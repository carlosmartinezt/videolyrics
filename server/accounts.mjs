/**
 * Accounts and credits.
 *
 * Supabase owns identity; this module owns everything we decide *because* of
 * identity. Three rules shape it:
 *
 *   1. This server holds no privileged database credential. Every call is made
 *      with the signed-in person's *own* access token, and the SQL functions
 *      read auth.uid() out of it rather than taking a user id as an argument.
 *      There is deliberately no service-role key here to leak, and no key that
 *      could touch somebody else's account if there were.
 *
 *   2. The browser never writes account state directly. profiles and unlocks
 *      have select policies and no others; the only writes are inside
 *      security-definer functions that confine themselves to auth.uid().
 *
 *   3. A credit buys a *song*, not a download — keyed by the sha256 of the
 *      uploaded audio. Re-export at another resolution, restyle it, come back
 *      tomorrow: still free. Only a genuinely new song costs.
 *
 * There is also a development stub, because the alternative was leaving the
 * whole credits path untested until someone created a cloud project.
 */

import crypto from 'node:crypto';

/* ------------------------------ configuration ----------------------------- */

export function authConfig(env = process.env) {
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  // Supabase's newer key format calls this "publishable"; it is the same
  // thing the JS client calls the anon key, and it is safe in a browser.
  const anonKey = env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || '';

  // The stub must be impossible to switch on by accident in production: it
  // needs an explicit flag *and* a non-production NODE_ENV.
  const stub = env.AUTH_DEV_STUB === '1' && env.NODE_ENV !== 'production';

  return {
    url,
    anonKey,
    stub,
    enabled: Boolean(url && anonKey) || stub,
    // Google needs an OAuth client configured in Supabase; hide the button
    // until it is, rather than offering a route that dead-ends.
    google: env.AUTH_GOOGLE === '1',
    freeCredits: Number(env.FREE_CREDITS_PER_MONTH || 5),
  };
}

/* ------------------------------ token → user ------------------------------ */

/**
 * Verified tokens are cached briefly. Alignment takes minutes, so a round trip
 * to Supabase is negligible next to it — but the studio polls a few endpoints
 * and there is no reason to re-verify the same token six times a minute.
 */
const verified = new Map();
const VERIFY_TTL_MS = 60_000;

function cachePut(token, user) {
  verified.set(token, { user, at: Date.now() });
  if (verified.size > 2000) {
    for (const [key, value] of verified) {
      if (Date.now() - value.at > VERIFY_TTL_MS) verified.delete(key);
    }
  }
}

/**
 * Resolve an access token to a user, or null.
 *
 * Deliberately asks Supabase rather than verifying the JWT signature locally:
 * signing keys rotate and Supabase has changed its key format before, and a
 * verifier that silently starts rejecting everyone is a worse failure than one
 * extra HTTP call per minute per user.
 */
export async function userFromToken(token, config = authConfig()) {
  if (!token || !config.enabled) return null;

  const hit = verified.get(token);
  if (hit && Date.now() - hit.at < VERIFY_TTL_MS) return hit.user;

  if (config.stub) {
    const user = stubUserFromToken(token);
    if (user) cachePut(token, user);
    return user;
  }

  try {
    const response = await fetch(`${config.url}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: config.anonKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload?.id) return null;
    // The token travels with the user because every subsequent call is made
    // as them. Nothing here can act on an account without one.
    const user = { id: payload.id, email: payload.email || null, token };
    cachePut(token, user);
    return user;
  } catch {
    return null;
  }
}

/* ------------------------------ the ledger -------------------------------- */

/** Call a database function as the signed-in person, never as an admin. */
async function rpc(name, body, user, config) {
  const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: config.anonKey,
      authorization: `Bearer ${user.token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`Supabase ${name} failed (${response.status}): ${detail}`);
  }
  return response.json();
}

export async function accountState(user, config = authConfig()) {
  if (!user) return null;
  if (config.stub) return stubAccountState(user, config);
  return rpc('account_state', {}, user, config);
}

export async function consumeCredit(user, songHash, title, config = authConfig()) {
  if (!user) return { ok: false, reason: 'not_signed_in' };
  if (config.stub) return stubConsume(user, songHash, title, config);
  return rpc('consume_credit', {
    p_song_hash: songHash, p_title: title || null,
  }, user, config);
}

/** Has this person already unlocked this song? Cheap, and never spends. */
export async function isUnlocked(user, songHash, config = authConfig()) {
  if (!user || !songHash) return false;
  if (config.stub) return stubUnlocks(user.id).has(songHash);

  // The row-level policy already confines this to the caller; the user_id
  // filter is here so the query uses the index rather than scanning.
  const url = `${config.url}/rest/v1/unlocks`
    + `?user_id=eq.${encodeURIComponent(user.id)}`
    + `&song_hash=eq.${encodeURIComponent(songHash)}&select=id&limit=1`;
  try {
    const response = await fetch(url, {
      headers: {
        apikey: config.anonKey,
        authorization: `Bearer ${user.token}`,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    const rows = await response.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

/* ------------------------------- song hash -------------------------------- */

/**
 * Identify a song by its audio bytes alone.
 *
 * Not the lyrics: correcting a typo and re-aligning must not cost a second
 * credit. Not the file name or size: those change with a re-encode of the same
 * upload, but so does the hash, and being occasionally generous here is much
 * cheaper than being occasionally wrong in the other direction.
 */
export function hashAudioStream(stream) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/* ------------------------------- dev stub --------------------------------- */
/*
 * An in-memory Supabase. It exists so the gating, the counter, the monthly
 * roll and the idempotent unlock can all be tested for real — including in the
 * end-to-end browser run — without anybody having created a cloud project.
 *
 * A token is `dev:<email>`. That is obviously forgeable, which is exactly why
 * authConfig() refuses to enable this unless NODE_ENV is not production.
 */

const stubProfiles = new Map();
const stubUnlockSets = new Map();

function stubUserFromToken(token) {
  const match = /^dev:([^\s]{1,120})$/.exec(String(token));
  if (!match) return null;
  const email = match[1].toLowerCase();
  const id = crypto.createHash('sha1').update(email).digest('hex').slice(0, 32);
  return { id, email, token: String(token) };
}

function stubUnlocks(userId) {
  if (!stubUnlockSets.has(userId)) stubUnlockSets.set(userId, new Set());
  return stubUnlockSets.get(userId);
}

function stubProfile(user, config) {
  const thisPeriod = new Date();
  thisPeriod.setUTCDate(1);
  thisPeriod.setUTCHours(0, 0, 0, 0);

  let profile = stubProfiles.get(user.id);
  if (!profile) {
    profile = {
      email: user.email,
      remaining: config.freeCredits,
      perPeriod: config.freeCredits,
      periodStart: thisPeriod.getTime(),
    };
    stubProfiles.set(user.id, profile);
  }
  if (profile.periodStart < thisPeriod.getTime()) {
    profile.remaining = profile.perPeriod;
    profile.periodStart = thisPeriod.getTime();
  }
  return profile;
}

function stubResetsAt(profile) {
  const next = new Date(profile.periodStart);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
}

function stubAccountState(user, config) {
  const profile = stubProfile(user, config);
  return {
    ok: true,
    email: profile.email,
    remaining: profile.remaining,
    per_period: profile.perPeriod,
    resets_at: stubResetsAt(profile),
    unlocked: stubUnlocks(user.id).size,
  };
}

function stubConsume(user, songHash, _title, config) {
  const profile = stubProfile(user, config);
  const unlocks = stubUnlocks(user.id);

  if (unlocks.has(songHash)) {
    return { ok: true, already: true, remaining: profile.remaining, resets_at: stubResetsAt(profile) };
  }
  if (profile.remaining <= 0) {
    return { ok: false, reason: 'no_credits', remaining: 0, resets_at: stubResetsAt(profile) };
  }
  profile.remaining -= 1;
  unlocks.add(songHash);
  return { ok: true, already: false, remaining: profile.remaining, resets_at: stubResetsAt(profile) };
}

/** Test seam: wipe the stub between cases. */
export function resetStub() {
  stubProfiles.clear();
  stubUnlockSets.clear();
  verified.clear();
}
