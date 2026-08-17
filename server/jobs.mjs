/**
 * Job store, queue and retention.
 *
 * A job is a directory under data/jobs/<id> holding the upload, the lyrics,
 * the alignment and the plan. Everything about a job is on disk, so a restart
 * mid-queue loses the queue but never loses a finished result.
 *
 * Concurrency is one. This box has two cores and already runs five other
 * services; two simultaneous alignments would make both of them slower than
 * one after the other, and would make the progress bar lie.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runAligner } from './aligner.mjs';
import { direct } from './director/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.resolve(HERE, '..', 'data', 'jobs');

export const LIMITS = {
  maxAudioBytes: Number(process.env.MAX_AUDIO_BYTES || 40 * 1024 * 1024),
  maxLyricChars: 20_000,
  maxDurationSeconds: Number(process.env.MAX_DURATION_SECONDS || 12 * 60),
  retentionMs: Number(process.env.RETENTION_MS || 6 * 60 * 60 * 1000),
  maxJobsPerIpPerHour: Number(process.env.MAX_JOBS_PER_IP || 20),
  maxTotalBytes: Number(process.env.MAX_TOTAL_BYTES || 3 * 1024 * 1024 * 1024),
};

export const STATES = ['created', 'queued', 'aligning', 'directing', 'ready', 'error', 'cancelled'];

/** In-memory view of jobs. The disk is authoritative for results. */
const jobs = new Map();
const queue = [];
let running = null;

export const events = new EventEmitter();
events.setMaxListeners(0);

/* ------------------------------ lifecycle -------------------------------- */

export async function init() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await sweep();
  setInterval(() => { sweep().catch(() => {}); }, 15 * 60 * 1000).unref();
}

function jobDir(id) {
  return path.join(DATA_DIR, id);
}

export async function createJob({ lyrics, prefs, ip }) {
  const text = String(lyrics || '');
  if (!text.trim()) throw badRequest('Paste the lyrics first.');
  if (text.length > LIMITS.maxLyricChars) {
    throw badRequest(`Those lyrics are ${text.length} characters; the limit is ${LIMITS.maxLyricChars}.`);
  }

  const id = crypto.randomBytes(9).toString('base64url');
  const token = crypto.randomBytes(24).toString('base64url');
  const dir = jobDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'lyrics.txt'), text, 'utf8');

  const job = {
    id,
    token,
    ip,
    state: 'created',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    progress: 0,
    stage: null,
    message: 'Waiting for the audio file',
    prefs: sanitisePrefs(prefs),
    audioBytes: 0,
    audioName: null,
    error: null,
    alignment: null,
    plan: null,
    director: null,
    queuePosition: null,
  };

  jobs.set(id, job);
  await persist(job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function authorised(job, token) {
  if (!job || !token) return false;
  const a = Buffer.from(job.token);
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Stream the uploaded audio to disk.
 *
 * Streamed rather than buffered because a 40 MB body held in memory on a box
 * with 7 GB total, shared with five other services, is a bad trade for code
 * that is barely simpler.
 */
export async function receiveAudio(job, stream, { filename, contentLength }) {
  if (job.state !== 'created') throw badRequest('This job already has its audio.');
  if (contentLength && contentLength > LIMITS.maxAudioBytes) {
    throw badRequest(`That file is ${mb(contentLength)}; the limit is ${mb(LIMITS.maxAudioBytes)}.`);
  }

  const dest = path.join(jobDir(job.id), 'audio');
  const out = createWriteStream(dest);
  let written = 0;

  await new Promise((resolve, reject) => {
    // settle() rather than bare resolve/reject: destroying a stream mid-pipe
    // fires an unpredictable mixture of 'error', 'close' and nothing at all
    // depending on which end gave up first, and a promise that never settles
    // here would hang the request forever.
    let done = false;
    const settle = (error) => {
      if (done) return;
      done = true;
      stream.destroy();
      out.destroy();
      error ? reject(error) : resolve();
    };

    stream.on('data', (chunk) => {
      written += chunk.length;
      if (written > LIMITS.maxAudioBytes) {
        settle(badRequest(`That file is over the ${mb(LIMITS.maxAudioBytes)} limit.`));
      }
    });
    stream.on('error', (e) => settle(e));
    out.on('error', (e) => settle(e));
    out.on('finish', () => settle(null));
    stream.pipe(out);
  }).catch(async (error) => {
    await fs.rm(dest, { force: true });
    throw error;
  });

  if (written === 0) {
    await fs.rm(dest, { force: true });
    throw badRequest('The upload was empty.');
  }

  job.audioBytes = written;
  job.audioName = String(filename || '').slice(0, 120) || 'audio';
  job.updatedAt = Date.now();
  await persist(job);
  return job;
}

/* -------------------------------- queue ---------------------------------- */

export function enqueue(job) {
  if (!job.audioBytes) throw badRequest('Upload the audio before starting.');
  if (job.state !== 'created') throw badRequest(`This job is already ${job.state}.`);

  job.state = 'queued';
  job.controller = new AbortController();
  queue.push(job.id);
  updateQueuePositions();
  emit(job, { message: queueMessage(job) });
  drain();
  return job;
}

export function cancel(job) {
  const index = queue.indexOf(job.id);
  if (index !== -1) queue.splice(index, 1);
  if (job.controller) job.controller.abort();
  if (['ready', 'error'].includes(job.state)) return job;
  job.state = 'cancelled';
  emit(job, { message: 'Cancelled.' });
  updateQueuePositions();
  return job;
}

function updateQueuePositions() {
  queue.forEach((id, index) => {
    const job = jobs.get(id);
    if (!job) return;
    const position = index + (running ? 1 : 0) + 1;
    if (job.queuePosition !== position) {
      job.queuePosition = position;
      emit(job, { message: queueMessage(job) });
    }
  });
}

function queueMessage(job) {
  if (!job.queuePosition || job.queuePosition <= 1) return 'Next in line…';
  return `Waiting — ${job.queuePosition - 1} song${job.queuePosition === 2 ? '' : 's'} ahead`;
}

async function drain() {
  if (running || queue.length === 0) return;
  const id = queue.shift();
  const job = jobs.get(id);
  if (!job || job.state !== 'queued') return drain();

  running = job.id;
  job.queuePosition = 0;
  updateQueuePositions();

  try {
    await process_(job);
  } catch (error) {
    if (job.state !== 'cancelled') {
      job.state = 'error';
      job.error = error.message || 'Something went wrong.';
      emit(job, { message: job.error });
    }
  } finally {
    running = null;
    await persist(job).catch(() => {});
    drain();
  }
}

async function process_(job) {
  const dir = jobDir(job.id);

  job.state = 'aligning';
  job.progress = 0;
  emit(job, { message: 'Listening to your song…' });

  await runAligner({
    audioPath: path.join(dir, 'audio'),
    lyricsPath: path.join(dir, 'lyrics.txt'),
    outPath: path.join(dir, 'alignment.json'),
    model: job.prefs.alignerModel || undefined,
    signal: job.controller?.signal,
    onProgress: (event) => {
      if (job.state !== 'aligning') return;
      // The aligner owns 0–90% of the bar; directing owns the rest.
      job.progress = Math.min(0.9, (event.progress || 0) * 0.9);
      job.stage = event.stage;
      emit(job, { message: event.message });
    },
  });

  if (job.state === 'cancelled') return;

  const alignment = JSON.parse(await fs.readFile(path.join(dir, 'alignment.json'), 'utf8'));

  if (alignment.duration > LIMITS.maxDurationSeconds) {
    throw badRequest(
      `That song is ${Math.round(alignment.duration / 60)} minutes; the limit is ` +
      `${Math.round(LIMITS.maxDurationSeconds / 60)}.`
    );
  }

  job.alignment = alignment;
  job.state = 'directing';
  job.progress = 0.92;
  emit(job, { message: 'Designing the video…' });

  const lyricsText = await fs.readFile(path.join(dir, 'lyrics.txt'), 'utf8');
  const { plan, director } = await direct({ alignment, lyricsText, prefs: job.prefs });

  job.plan = plan;
  job.director = director;
  await fs.writeFile(path.join(dir, 'plan.json'), JSON.stringify({ plan, director }), 'utf8');

  job.state = 'ready';
  job.progress = 1;
  job.stage = 'ready';
  emit(job, { message: 'Ready.' });
}

/**
 * Re-run only the director. Changing the mood or the template should feel
 * instant — the expensive part is the alignment, and that does not change.
 */
export async function redirect(job, prefs, { useLlm = true } = {}) {
  if (!job.alignment) throw badRequest('This job has not been aligned yet.');
  job.prefs = { ...job.prefs, ...sanitisePrefs(prefs) };

  const lyricsText = await fs.readFile(path.join(jobDir(job.id), 'lyrics.txt'), 'utf8');
  const { plan, director } = await direct({
    alignment: job.alignment, lyricsText, prefs: job.prefs, useLlm,
  });

  job.plan = plan;
  job.director = director;
  job.updatedAt = Date.now();
  await fs.writeFile(
    path.join(jobDir(job.id), 'plan.json'), JSON.stringify({ plan, director }), 'utf8'
  );
  emit(job, { message: 'Redesigned.' });
  return { plan, director };
}

/* ------------------------------ serialising ------------------------------ */

export function publicJob(job, { includeResult = false } = {}) {
  const view = {
    id: job.id,
    state: job.state,
    progress: Math.round((job.progress || 0) * 1000) / 1000,
    stage: job.stage,
    message: job.message,
    error: job.error,
    queuePosition: job.queuePosition || 0,
    audioBytes: job.audioBytes,
    audioName: job.audioName,
    createdAt: job.createdAt,
    expiresAt: job.createdAt + LIMITS.retentionMs,
  };
  if (includeResult && job.state === 'ready') {
    view.alignment = job.alignment;
    view.plan = job.plan;
    view.director = job.director;
  }
  return view;
}

function emit(job, patch = {}) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  events.emit(job.id, publicJob(job));
  events.emit('*', { id: job.id, state: job.state });
}

async function persist(job) {
  const meta = {
    id: job.id, token: job.token, state: job.state, createdAt: job.createdAt,
    prefs: job.prefs, audioBytes: job.audioBytes, audioName: job.audioName,
  };
  await fs.writeFile(path.join(jobDir(job.id), 'meta.json'), JSON.stringify(meta), 'utf8');
}

/* ------------------------------- retention ------------------------------- */

export async function sweep() {
  let entries;
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return { removed: 0, bytes: 0 };
  }

  const now = Date.now();
  const survivors = [];
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(DATA_DIR, entry.name);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    const age = now - stat.mtimeMs;
    if (age > LIMITS.retentionMs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(entry.name);
      removed++;
    } else {
      survivors.push({ name: entry.name, dir, mtime: stat.mtimeMs, size: await dirSize(dir) });
    }
  }

  // Disk backstop: if uploads have piled up, drop the oldest until under cap.
  survivors.sort((a, b) => a.mtime - b.mtime);
  let total = survivors.reduce((n, s) => n + s.size, 0);
  while (total > LIMITS.maxTotalBytes && survivors.length) {
    const victim = survivors.shift();
    if (running === victim.name) continue;
    await fs.rm(victim.dir, { recursive: true, force: true }).catch(() => {});
    jobs.delete(victim.name);
    total -= victim.size;
    removed++;
  }

  return { removed, bytes: total, jobs: survivors.length };
}

async function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
      if (stat) total += stat.size;
    }
  } catch { /* gone already */ }
  return total;
}

/* ------------------------------ rate limit ------------------------------- */

const ipHistory = new Map();

export function rateLimit(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const history = (ipHistory.get(ip) || []).filter((t) => now - t < hour);
  if (history.length >= LIMITS.maxJobsPerIpPerHour) {
    const wait = Math.ceil((hour - (now - history[0])) / 60000);
    const error = badRequest(`That's ${LIMITS.maxJobsPerIpPerHour} songs this hour. Try again in ${wait} minutes.`);
    error.status = 429;
    throw error;
  }
  history.push(now);
  ipHistory.set(ip, history);
  if (ipHistory.size > 5000) ipHistory.clear();
}

/* -------------------------------- helpers -------------------------------- */

const ALLOWED_PREFS = [
  'moods', 'template', 'palette', 'font', 'lyricMode', 'aspect', 'resolution',
  'fps', 'imageColors', 'photoCount', 'title', 'artist', 'notes', 'alignerModel',
];

function sanitisePrefs(prefs) {
  const input = prefs && typeof prefs === 'object' ? prefs : {};
  const out = {};
  for (const key of ALLOWED_PREFS) {
    if (input[key] === undefined || input[key] === null) continue;
    const value = input[key];
    if (Array.isArray(value)) {
      out[key] = value.filter((v) => typeof v === 'string').map((v) => v.slice(0, 40)).slice(0, 12);
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, 300);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.expose = true;
  return error;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function stats() {
  return {
    tracked: jobs.size,
    queued: queue.length,
    running,
  };
}
