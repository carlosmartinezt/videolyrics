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
 *   GET    /api/me                   Supabase bearer      -> account + credits
 *   POST   /api/jobs                 {lyrics, prefs}      -> {id, token}
 *   PUT    /api/jobs/:id/audio       raw audio body       -> {bytes}
 *   POST   /api/jobs/:id/start                            -> queued
 *   GET    /api/jobs/:id/events      server-sent events
 *   GET    /api/jobs/:id             ?full=1              -> job (+ result)
 *   POST   /api/jobs/:id/redirect    {prefs}              -> new plan
 *   POST   /api/jobs/:id/unlock      spends one credit    -> {remaining}
 *   DELETE /api/jobs/:id
 *   GET    /api/config
 *   GET    /api/health
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './jobs.mjs';
import {
  accountState, authConfig, consumeCredit, enabledProviders, isUnlocked, userFromToken,
} from './accounts.mjs';
import { directorConfig, watermarkConfig } from './director/index.mjs';
import { TEMPLATES, FONTS, ASPECTS } from '../shared/templates.mjs';
import { PALETTES, MOOD_VOCABULARY } from '../shared/palettes.mjs';
import { CUE_TREATMENTS } from '../shared/plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3058);
const HOST = process.env.HOST || '127.0.0.1';

const MAX_JSON_BYTES = 512 * 1024;

/* --------------------------------- routing -------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');

  try {
    if (parts[0] !== 'api') return notFound(res);

    if (parts[1] === 'health' && req.method === 'GET') {
      return json(res, 200, { ok: true, ...store.stats(), uptime: Math.round(process.uptime()) });
    }

    if (parts[1] === 'config' && req.method === 'GET') {
      const config = directorConfig();
      const auth = authConfig();
      const providers = await enabledProviders(auth);
      return json(res, 200, {
        auth: {
          enabled: auth.enabled,
          url: auth.url || null,
          anonKey: auth.anonKey || null,
          google: providers.google,
          freeCredits: auth.freeCredits,
          devStub: auth.stub,
        },
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

    /* GET /api/me */
    if (parts[1] === 'me' && req.method === 'GET') {
      const user = await userFromToken(bearer(req));
      if (!user) return json(res, 401, { error: 'Not signed in.' });
      const state = await accountState(user);
      return json(res, 200, { user: { id: user.id, email: user.email }, account: state });
    }

    if (parts[1] !== 'jobs') return notFound(res);

    /* POST /api/jobs */
    if (parts.length === 2 && req.method === 'POST') {
      const ip = clientIp(req);
      // Anonymous visitors may align and preview; the account only gates the
      // download. They get a much smaller per-IP allowance, because alignment
      // is the only expensive thing here and nothing else caps it.
      const user = await userFromToken(bearer(req));
      store.rateLimit(ip, Boolean(user));
      const body = await readJson(req);
      const job = await store.createJob({ lyrics: body.lyrics, prefs: body.prefs, ip, user });
      return json(res, 201, { id: job.id, token: job.token, job: store.publicJob(job) });
    }

    const id = parts[2];
    const job = id && store.getJob(id);
    if (!job) return json(res, 404, { error: 'No such job. It may have expired.' });

    // Two independent credentials, and they must not share a header.
    // `Authorization: Bearer` is the person's Supabase session, which is what
    // that header conventionally means and what /unlock needs. The job token
    // is our own capability for one job — it travels in X-Job-Token, or in
    // the query string for the SSE stream, which cannot set headers.
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
      store.enqueue(job);
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

    /* POST /api/jobs/:id/unlock — spend a credit to allow the download */
    if (parts[3] === 'unlock' && req.method === 'POST') {
      const auth = authConfig();
      if (!auth.enabled) {
        return json(res, 503, { error: 'Accounts are not configured on this server.' });
      }
      const user = await userFromToken(bearer(req));
      if (!user) {
        return json(res, 401, { error: 'Sign in to download.' });
      }
      if (!job.songHash) {
        return json(res, 409, { error: 'This job has no audio yet.' });
      }

      const title = job.plan?.title?.title || job.audioName || null;
      const result = await consumeCredit(user, job.songHash, title);

      if (!result?.ok) {
        const status = result?.reason === 'no_credits' ? 402 : 400;
        return json(res, status, {
          error: result?.reason === 'no_credits'
            ? 'You have used this month\'s credits.'
            : 'Could not unlock this song.',
          reason: result?.reason || 'unknown',
          remaining: result?.remaining ?? 0,
          resetsAt: result?.resets_at ?? null,
        });
      }

      job.unlocked = true;
      return json(res, 200, {
        ok: true,
        already: Boolean(result.already),
        remaining: result.remaining,
        resetsAt: result.resets_at ?? null,
      });
    }

    /* GET /api/jobs/:id */
    if (parts.length === 3 && req.method === 'GET') {
      const viewer = await userFromToken(bearer(req));
      if (viewer && job.songHash && !job.unlocked) {
        // Somebody who already paid for this song on another day should not
        // be asked again just because this is a fresh job.
        job.unlocked = await isUnlocked(viewer, job.songHash);
      }
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

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function clientIp(req) {
  // Caddy is the only thing in front of us and it sets X-Forwarded-For; the
  // last hop is the one it observed, so trust that and nothing else.
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  const hops = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : req.socket.remoteAddress || 'unknown';
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
