/**
 * videolyrics API.
 *
 * Deliberately dependency-free, like the other services on this box. The only
 * non-trivial route is the audio upload, and it avoids multipart entirely by
 * taking the file as a raw PUT body — the job (and its lyrics) already exist
 * by the time the bytes arrive.
 *
 * Nothing here renders video. The browser does that with WebCodecs; this
 * server only listens to the song and designs the video.
 *
 *   POST   /api/jobs                 {lyrics, prefs}      -> {id, token}
 *   PUT    /api/jobs/:id/audio       raw audio body       -> {bytes}
 *   POST   /api/jobs/:id/start                            -> queued
 *   GET    /api/jobs/:id/events      server-sent events
 *   GET    /api/jobs/:id             ?full=1              -> job (+ result)
 *   POST   /api/jobs/:id/redirect    {prefs}              -> new plan
 *   POST   /api/jobs/:id/downloaded  {format, aspect, ...} -> ok (emails the owner)
 *   DELETE /api/jobs/:id
 *   GET    /api/config
 *   GET    /api/health
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './jobs.mjs';
import { notify } from './notify.mjs';
import { directorConfig, watermarkConfig } from './director/index.mjs';
import { TEMPLATES, FONTS, ASPECTS } from '../shared/templates.mjs';
import { PALETTES, MOOD_VOCABULARY } from '../shared/palettes.mjs';
import { CUE_TREATMENTS } from '../shared/plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3058);
const HOST = process.env.HOST || '127.0.0.1';

const MAX_JSON_BYTES = 512 * 1024;

/**
 * Browser origins allowed to call this API, comma-separated.
 *
 * Empty — the default, and how this has always run — means same-origin only:
 * Caddy serves the page and proxies /api from videolyrics.org, so no CORS
 * header is needed and none is sent. Set this only when the front end moves
 * to a host of its own:
 *
 *   ALLOWED_ORIGINS=https://videolyrics.org,https://videolyrics.vercel.app
 *
 * Origins are compared exactly. There is no wildcard and no pattern, because
 * the alignment endpoint is open to anonymous visitors and a loose match here
 * is the difference between a rate limit and a free two-core cluster.
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

/* --------------------------------- routing -------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');

  const allowed = cors(req, res);

  try {
    if (parts[0] !== 'api') return notFound(res);

    /* Preflight.
     *
     * Answered once for the whole API rather than per route. The upload sets
     * x-filename and content-type on a PUT, and every mutating call carries
     * x-job-token, so there is no request here the browser would treat as
     * simple — a missing preflight fails all of them, not some.
     */
    if (req.method === 'OPTIONS') {
      if (!allowed) return void res.writeHead(403).end();
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, x-job-token, x-filename',
        'access-control-max-age': '86400',
      });
      return res.end();
    }

    if (parts[1] === 'health' && req.method === 'GET') {
      return json(res, 200, { ok: true, ...store.stats(), uptime: Math.round(process.uptime()) });
    }

    if (parts[1] === 'config' && req.method === 'GET') {
      const config = directorConfig();
      return json(res, 200, {
        watermark: watermarkConfig(),
        limits: {
          maxAudioBytes: store.LIMITS.maxAudioBytes,
          maxLyricChars: store.LIMITS.maxLyricChars,
          maxDurationSeconds: store.LIMITS.maxDurationSeconds,
          retentionHours: Math.round(store.LIMITS.retentionMs / 3600000),
        },
        director: {
          enabled: config.enabled,
          provider: config.enabled ? config.providerName : null,
          model: config.enabled ? config.model : null,
        },
        templates: TEMPLATES,
        palettes: PALETTES,
        fonts: FONTS,
        aspects: ASPECTS,
        moods: MOOD_VOCABULARY,
        treatments: CUE_TREATMENTS,
      });
    }

    if (parts[1] !== 'jobs') return notFound(res);

    /* POST /api/jobs */
    if (parts.length === 2 && req.method === 'POST') {
      const ip = clientIp(req);
      // Alignment is the only expensive thing here and nothing else caps it.
      store.rateLimit(ip);
      const body = await readJson(req);
      const job = await store.createJob({ lyrics: body.lyrics, prefs: body.prefs, ip });
      return json(res, 201, { id: job.id, token: job.token, job: store.publicJob(job) });
    }

    const id = parts[2];
    const job = id && store.getJob(id);
    if (!job) return json(res, 404, { error: 'No such job. It may have expired.' });

    // The job token is a capability for one job. It travels in X-Job-Token,
    // or in the query string for the SSE stream, which cannot set headers.
    const jobToken = req.headers['x-job-token'] || url.searchParams.get('token');
    if (!store.authorised(job, jobToken)) {
      return json(res, 403, { error: 'Wrong or missing job token.' });
    }

    /* PUT /api/jobs/:id/audio */
    if (parts[3] === 'audio' && req.method === 'PUT') {
      await store.receiveAudio(job, req, {
        filename: req.headers['x-filename'],
        contentLength: Number(req.headers['content-length'] || 0),
      });
      return json(res, 200, { bytes: job.audioBytes, job: store.publicJob(job) });
    }

    /* POST /api/jobs/:id/start */
    if (parts[3] === 'start' && req.method === 'POST') {
      const body = await readJson(req);
      store.enqueue(job);
      notifyStarted(req, job, Number(body.durationSeconds) || 0);
      return json(res, 202, { job: store.publicJob(job) });
    }

    /* GET /api/jobs/:id/events */
    if (parts[3] === 'events' && req.method === 'GET') {
      return streamEvents(req, res, job);
    }

    /* POST /api/jobs/:id/redirect */
    if (parts[3] === 'redirect' && req.method === 'POST') {
      const body = await readJson(req);
      const result = await store.redirect(job, body.prefs, { useLlm: body.useLlm !== false });
      return json(res, 200, result);
    }

    /* POST /api/jobs/:id/downloaded: the browser finished an export */
    if (parts[3] === 'downloaded' && req.method === 'POST') {
      const body = await readJson(req);
      notifyDownloaded(req, job, body);
      return json(res, 200, { ok: true });
    }

    /* GET /api/jobs/:id */
    if (parts.length === 3 && req.method === 'GET') {
      return json(res, 200, store.publicJob(job, { includeResult: url.searchParams.get('full') === '1' }));
    }

    /* DELETE /api/jobs/:id */
    if (parts.length === 3 && req.method === 'DELETE') {
      store.cancel(job);
      return json(res, 200, { ok: true });
    }

    return notFound(res);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('[videolyrics]', error);
    return json(res, status, {
      error: error.expose || status < 500 ? error.message : 'Something went wrong on the server.',
    });
  }
});

/* ------------------------------ SSE progress ------------------------------ */

function streamEvents(req, res, job) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Caddy buffers proxied responses unless told otherwise.
    'x-accel-buffering': 'no',
  });

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send(store.publicJob(job));

  const onUpdate = (view) => {
    send(view);
    if (view.state === 'ready' || view.state === 'error' || view.state === 'cancelled') {
      // Hand over the finished article on the same stream so the client does
      // not need a second round trip to start rendering.
      if (view.state === 'ready') {
        send({ ...store.publicJob(job, { includeResult: true }), final: true });
      }
      cleanup();
      res.end();
    }
  };

  // A comment line every 20s: proxies drop idle connections, and alignment
  // can legitimately go a couple of minutes without a progress change.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

  function cleanup() {
    clearInterval(heartbeat);
    store.events.off(job.id, onUpdate);
  }

  store.events.on(job.id, onUpdate);
  req.on('close', cleanup);

  if (job.state === 'ready') {
    send({ ...store.publicJob(job, { includeResult: true }), final: true });
    cleanup();
    res.end();
  }
}

/* -------------------------------- helpers -------------------------------- */

/**
 * Allow this request's origin, if it is one of ours.
 *
 * Returns whether the origin was allowed, so the preflight can refuse rather
 * than answer. Called before anything is written, since both json() and the
 * SSE stream go straight to writeHead — Node merges headers set here with the
 * object passed there, giving writeHead precedence, and neither sets these.
 *
 * `Vary: Origin` is unconditional and not optional. Cloudflare sits in front
 * of this and a response cached for one origin must never be replayed with
 * its Allow-Origin header to another.
 *
 * There is deliberately no Access-Control-Allow-Credentials: nothing here
 * rides on a cookie. The job token is a header the client sets by hand, so a
 * cross-site request without it is simply refused, and CSRF has nothing to
 * ride in on.
 */
function cors(req, res) {
  res.setHeader('vary', 'Origin');
  const origin = req.headers.origin;
  // No Origin at all is a same-origin fetch or a non-browser client; both are
  // fine and neither wants a header back.
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  return true;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function notFound(res) {
  return json(res, 404, { error: 'Not found.' });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      const error = new Error('Request body too large.');
      error.status = 413;
      error.expose = true;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Body was not valid JSON.');
    error.status = 400;
    error.expose = true;
    throw error;
  }
}

function clientIp(req) {
  // Caddy is the only thing in front of us and it sets X-Forwarded-For; the
  // last hop is the one it observed, so trust that and nothing else.
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  const hops = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : req.socket.remoteAddress || 'unknown';
}

/* --------------------------------- alerts -------------------------------- */

// Emails to the owner. notify() never throws and is never awaited here, so a
// slow or broken mail service cannot hold up a request.

function notifyStarted(req, job, seconds) {
  notify({
    subject: 'videolyrics: someone started a video',
    text: [
      `Song file: ${songFile(job)}`,
      `First line: ${job.firstLine || '(none)'}`,
      `Length: ${seconds > 0 ? formatSeconds(seconds) : 'not known'}`,
      ...whereAndWhen(req, job),
    ].join('\n'),
  });
}

function notifyDownloaded(req, job, body) {
  const b = body && typeof body === 'object' ? body : {};
  const clean = (v) => String(v ?? '').replace(/[^\w .:x-]/g, '').slice(0, 20);
  const size = b.width && b.height ? `${clean(b.width)}x${clean(b.height)}` : '';
  notify({
    subject: 'videolyrics: someone downloaded a video',
    text: [
      `Song file: ${songFile(job)}`,
      `Title: ${job.plan?.title?.title || '(none)'}`,
      `Export: ${[clean(b.format), clean(b.aspect), size].filter(Boolean).join(', ') || 'not given'}`,
      `Length: ${Number(b.seconds) > 0 ? formatSeconds(Number(b.seconds)) : 'not given'}`,
      ...whereAndWhen(req, job),
    ].join('\n'),
  });
}

// The browser sends the file name URI-encoded in X-Filename.
function songFile(job) {
  try { return decodeURIComponent(job.audioName || '') || 'unknown'; } catch { return job.audioName; }
}

function whereAndWhen(req, job) {
  const country = String(req.headers['cf-ipcountry'] || '').slice(0, 8);
  return [
    `Country: ${country || 'unknown'}`,
    `Time: ${new Date().toISOString()}`,
    `Job: ${job.id}`,
  ];
}

function formatSeconds(total) {
  const s = Math.round(total);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* --------------------------------- start --------------------------------- */

await store.init();

server.listen(PORT, HOST, () => {
  const config = directorConfig();
  console.log(`[videolyrics] api on http://${HOST}:${PORT}`);
  console.log(`[videolyrics] data in ${store.DATA_DIR}`);
  console.log(
    config.enabled
      ? `[videolyrics] art director: ${config.providerName} (${config.model})`
      : '[videolyrics] art director: deterministic only (set DIRECTOR_API_KEY to enable)'
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
