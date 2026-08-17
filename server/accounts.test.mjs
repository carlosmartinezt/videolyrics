/**
 * Credits.
 *
 * These run against the development stub, which implements the same contract
 * as the SQL in supabase/migrations/0001 — same idempotency, same monthly
 * roll, same refusal when the balance is gone. The stub is what makes this
 * testable at all without a cloud project, and keeping the two honest with
 * each other is the point of writing the rules down twice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_DEV_STUB = '1';
process.env.NODE_ENV = 'test';

const {
  authConfig, userFromToken, accountState, consumeCredit, isUnlocked, resetStub,
} = await import('./accounts.mjs');

const config = authConfig({ AUTH_DEV_STUB: '1', NODE_ENV: 'test', FREE_CREDITS_PER_MONTH: '5' });

const SONG_A = 'a'.repeat(64);
const SONG_B = 'b'.repeat(64);

async function signIn(email = 'someone@example.com') {
  const user = await userFromToken(`dev:${email}`, config);
  assert.ok(user, 'stub should resolve a token to a user');
  return user;
}

test.beforeEach(() => resetStub());

test('the stub refuses to arm itself in production', () => {
  const live = authConfig({ AUTH_DEV_STUB: '1', NODE_ENV: 'production' });
  assert.equal(live.stub, false);
  assert.equal(live.enabled, false, 'no stub and no Supabase means accounts are off');
});

test('a missing or malformed token is nobody', async () => {
  for (const token of [null, undefined, '', 'garbage', 'Bearer x', 'dev:']) {
    assert.equal(await userFromToken(token, config), null, String(token));
  }
});

test('the same email is always the same account', async () => {
  const a = await userFromToken('dev:Someone@Example.com', config);
  const b = await userFromToken('dev:someone@example.com', config);
  assert.equal(a.id, b.id, 'case in an email address must not fork the account');
});

test('a new account starts with the free allowance', async () => {
  const user = await signIn();
  const state = await accountState(user, config);
  assert.equal(state.remaining, 5);
  assert.equal(state.per_period, 5);
  assert.equal(state.unlocked, 0);
});

test('unlocking a song spends exactly one credit', async () => {
  const user = await signIn();
  const result = await consumeCredit(user, SONG_A, 'A Song', config);

  assert.equal(result.ok, true);
  assert.equal(result.already, false);
  assert.equal(result.remaining, 4);
  assert.equal(await isUnlocked(user, SONG_A, config), true);
});

test('unlocking the same song again is free and idempotent', async () => {
  // The export button lives in a browser next to somebody who will click it
  // twice, and re-exporting at another resolution must never cost again.
  const user = await signIn();
  await consumeCredit(user, SONG_A, null, config);

  for (let attempt = 0; attempt < 4; attempt++) {
    const again = await consumeCredit(user, SONG_A, null, config);
    assert.equal(again.ok, true);
    assert.equal(again.already, true);
    assert.equal(again.remaining, 4, 'balance must not move');
  }

  const state = await accountState(user, config);
  assert.equal(state.unlocked, 1);
});

test('different songs cost a credit each', async () => {
  const user = await signIn();
  await consumeCredit(user, SONG_A, null, config);
  const second = await consumeCredit(user, SONG_B, null, config);
  assert.equal(second.remaining, 3);
  assert.equal((await accountState(user, config)).unlocked, 2);
});

test('the allowance runs out, and says so without spending', async () => {
  const user = await signIn();
  for (let i = 0; i < 5; i++) {
    const result = await consumeCredit(user, `song-${i}`, null, config);
    assert.equal(result.ok, true, `song ${i}`);
  }
  assert.equal((await accountState(user, config)).remaining, 0);

  const refused = await consumeCredit(user, 'song-six', null, config);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'no_credits');
  assert.equal(refused.remaining, 0);
  assert.ok(refused.resets_at, 'must tell them when it comes back');
  assert.equal(await isUnlocked(user, 'song-six', config), false);
});

test('songs already owned still work after the allowance is gone', async () => {
  const user = await signIn();
  for (let i = 0; i < 5; i++) await consumeCredit(user, `song-${i}`, null, config);

  const owned = await consumeCredit(user, 'song-0', null, config);
  assert.equal(owned.ok, true);
  assert.equal(owned.already, true);
});

test('accounts do not see each other', async () => {
  const one = await signIn('one@example.com');
  const two = await signIn('two@example.com');

  await consumeCredit(one, SONG_A, null, config);

  assert.equal(await isUnlocked(two, SONG_A, config), false);
  assert.equal((await accountState(two, config)).remaining, 5);
  assert.equal((await accountState(one, config)).remaining, 4);
});

test('an anonymous caller can never spend anything', async () => {
  const result = await consumeCredit(null, SONG_A, null, config);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_signed_in');
  assert.equal(await isUnlocked(null, SONG_A, config), false);
});
