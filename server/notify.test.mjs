/**
 * The email alerts must never flood the inbox: a daily cap with one last
 * "muted" email, and a per-key throttle for alerts that repeat.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createNotifier, DAILY_CAP } from './notify.mjs';

const HOUR = 60 * 60 * 1000;
const quiet = { log() {}, error() {} };

function setup({ env = { RESEND_API_KEY: 'test' }, start = Date.UTC(2026, 8, 23, 10) } = {}) {
  const sent = [];
  const clock = { t: start };
  const notifier = createNotifier({
    env,
    now: () => clock.t,
    log: quiet,
    fetchImpl: async (url, init) => {
      sent.push({ url, init, body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    },
  });
  return { sent, clock, ...notifier };
}

test('sends through Resend with the defaults', async () => {
  const { sent, notify } = setup();
  assert.equal(await notify({ subject: 'hi', text: 'there' }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.resend.com/emails');
  assert.equal(sent[0].init.headers.authorization, 'Bearer test');
  assert.deepEqual(sent[0].body.to, ['carlosmartinezt@gmail.com']);
  assert.equal(sent[0].body.from, 'videolyrics <info@saveyourchess.com>');
});

test('skips without a key and never calls fetch', async () => {
  const { sent, notify } = setup({ env: {} });
  assert.equal(await notify({ subject: 'hi', text: 'there' }), false);
  assert.equal(sent.length, 0);
});

test('a failing send does not throw', async () => {
  const notifier = createNotifier({
    env: { RESEND_API_KEY: 'test' },
    log: quiet,
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(await notifier.notify({ subject: 'hi', text: 'there' }), false);
});

test('daily cap: the last email says alerts are muted, then nothing until tomorrow', async () => {
  const { sent, clock, notify } = setup();
  for (let i = 0; i < DAILY_CAP + 10; i++) await notify({ subject: `n${i}`, text: 'x' });

  assert.equal(sent.length, DAILY_CAP);
  assert.match(sent[DAILY_CAP - 1].body.subject, /muted until tomorrow/);
  assert.match(sent[DAILY_CAP - 2].body.subject, /^n\d+$/);

  clock.t += 24 * HOUR;
  await notify({ subject: 'next day', text: 'x' });
  assert.equal(sent.length, DAILY_CAP + 1);
  assert.equal(sent.at(-1).body.subject, 'next day');
});

test('throttle: at most one per key every 6 hours', async () => {
  const { sent, clock, notifyAtMostEvery } = setup();
  const msg = { subject: 'out of credit', text: 'x' };

  await notifyAtMostEvery('llm', 6 * HOUR, msg);
  await notifyAtMostEvery('llm', 6 * HOUR, msg);
  clock.t += 5 * HOUR;
  await notifyAtMostEvery('llm', 6 * HOUR, msg);
  assert.equal(sent.length, 1);

  // A different key is throttled separately.
  await notifyAtMostEvery('other', 6 * HOUR, msg);
  assert.equal(sent.length, 2);

  clock.t += 1 * HOUR + 1;
  await notifyAtMostEvery('llm', 6 * HOUR, msg);
  assert.equal(sent.length, 3);
});
