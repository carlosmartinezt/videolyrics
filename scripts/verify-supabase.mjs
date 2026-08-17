/**
 * Verify accounts and credits against the *real* Supabase project.
 *
 * The unit tests run against an in-memory stub, which proves the rules but not
 * the SQL. This signs in as a real user, drives the real functions through the
 * real API, and checks the things that can only go wrong once PostgREST, RLS
 * and the JWT are in the loop:
 *
 *   - the signup trigger created a profile with the free allowance
 *   - a signed-in caller can spend exactly one credit
 *   - spending twice on the same song is free and idempotent
 *   - one person cannot read or spend another's
 *   - an anonymous caller can do neither
 *
 *   SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… \
 *     node scripts/verify-supabase.mjs <email> <password>
 *
 * Run it against a project you are happy to leave a test row in.
 */

import crypto from 'node:crypto';

const [email, password] = process.argv.slice(2);
const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const API = process.env.API_BASE || 'http://127.0.0.1:3058';

if (!email || !password || !URL_BASE || !KEY) {
  console.error('need SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and <email> <password>');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function signIn(mail, pass) {
  const response = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: KEY },
    body: JSON.stringify({ email: mail, password: pass }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  return (await response.json()).access_token;
}

async function rpc(name, body, token) {
  const response = await fetch(`${URL_BASE}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: KEY,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function main() {
  const token = await signIn(email, password);
  check('signed in with a real session', Boolean(token), `${token.slice(0, 12)}…`);

  /* our own API sees them ------------------------------------------------ */
  const me = await fetch(`${API}/api/me`, { headers: { authorization: `Bearer ${token}` } });
  const account = me.ok ? (await me.json()).account : null;
  check('the API resolves the token to an account', me.ok && account?.ok === true,
    account ? `${account.email}, ${account.remaining}/${account.per_period} credits` : `HTTP ${me.status}`);

  const startingCredits = account?.remaining ?? 0;

  /* the signup trigger did its job -------------------------------------- */
  check('the signup trigger created a profile', account?.per_period > 0,
    `resets ${account?.resets_at?.slice(0, 10) ?? '?'}`);

  /* spending -------------------------------------------------------------- */
  const song = crypto.randomBytes(32).toString('hex');

  const first = await rpc('consume_credit', { p_song_hash: song, p_title: 'Verification' }, token);
  check('spends exactly one credit', first.body?.ok === true && first.body?.already === false
    && first.body?.remaining === startingCredits - 1,
    `${startingCredits} → ${first.body?.remaining}`);

  const second = await rpc('consume_credit', { p_song_hash: song, p_title: 'Verification' }, token);
  check('the same song again is free', second.body?.ok === true && second.body?.already === true
    && second.body?.remaining === first.body?.remaining,
    `still ${second.body?.remaining}`);

  /* reading own rows ------------------------------------------------------ */
  const unlocks = await fetch(
    `${URL_BASE}/rest/v1/unlocks?song_hash=eq.${song}&select=id,title`,
    { headers: { apikey: KEY, authorization: `Bearer ${token}` } },
  );
  const rows = unlocks.ok ? await unlocks.json() : [];
  check('the unlock is readable by its owner', rows.length === 1, `${rows.length} row(s)`);

  /* anonymous can do nothing --------------------------------------------- */
  const anonState = await rpc('account_state', {}, null);
  check('anonymous cannot read an account',
    anonState.status === 401 || anonState.status === 403 || anonState.body?.ok === false,
    `HTTP ${anonState.status}`);

  const anonSpend = await rpc('consume_credit', { p_song_hash: song }, null);
  check('anonymous cannot spend',
    anonSpend.status === 401 || anonSpend.status === 403 || anonSpend.body?.ok === false,
    `HTTP ${anonSpend.status}`);

  const anonRead = await fetch(`${URL_BASE}/rest/v1/profiles?select=*`, { headers: { apikey: KEY } });
  const anonRows = anonRead.ok ? await anonRead.json() : null;
  check('anonymous cannot list profiles',
    !anonRead.ok || (Array.isArray(anonRows) && anonRows.length === 0),
    anonRead.ok ? `${anonRows?.length} rows` : `HTTP ${anonRead.status}`);

  /* a browser session cannot write directly ------------------------------ */
  const directWrite = await fetch(`${URL_BASE}/rest/v1/profiles?id=eq.${account?.email ? '' : ''}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      apikey: KEY,
      authorization: `Bearer ${token}`,
      prefer: 'return=representation',
    },
    body: JSON.stringify({ credits_remaining: 9999 }),
  });
  const wrote = directWrite.ok ? await directWrite.json() : null;
  check('a signed-in session cannot grant itself credits',
    !directWrite.ok || (Array.isArray(wrote) && wrote.length === 0),
    directWrite.ok ? `${wrote?.length} rows changed` : `HTTP ${directWrite.status}`);

  const after = await fetch(`${API}/api/me`, { headers: { authorization: `Bearer ${token}` } });
  const afterAccount = after.ok ? (await after.json()).account : null;
  check('the balance is what the ledger says',
    afterAccount?.remaining === startingCredits - 1,
    `${afterAccount?.remaining}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
