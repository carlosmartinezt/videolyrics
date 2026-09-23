/**
 * Email alerts to the owner, sent through Resend.
 *
 * No dependencies: one fetch per email. Callers never await this and it never
 * throws, so a slow or broken mail service cannot hold up or fail a request.
 *
 *   RESEND_API_KEY   unset means log and skip
 *   NOTIFY_TO        default carlosmartinezt@gmail.com
 *   NOTIFY_FROM      default "videolyrics <info@saveyourchess.com>"
 *
 * At most DAILY_CAP emails a day (UTC). The last one of the day says further
 * alerts are muted until tomorrow, so a busy day or a loop cannot flood the
 * inbox and nobody wonders why the emails stopped.
 */

export const DAILY_CAP = 60;

export function createNotifier({
  env = process.env,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  log = console,
} = {}) {
  let day = null;
  let sentToday = 0;
  const lastSent = new Map();

  async function send({ subject, text }) {
    const key = env.RESEND_API_KEY;
    if (!key) {
      log.log(`[notify] RESEND_API_KEY not set, skipping: ${subject}`);
      return false;
    }

    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      sentToday = 0;
    }
    if (sentToday >= DAILY_CAP) return false;

    // Counted before sending, so failures cannot loop past the cap either.
    sentToday++;
    if (sentToday === DAILY_CAP) {
      text = `That is ${DAILY_CAP} alerts today. Further alerts are muted until tomorrow (UTC).\n\n`
        + `The alert that hit the limit:\n${subject}\n\n${text}`;
      subject = 'videolyrics: alerts muted until tomorrow';
    }

    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: env.NOTIFY_FROM || 'videolyrics <info@saveyourchess.com>',
          to: [env.NOTIFY_TO || 'carlosmartinezt@gmail.com'],
          subject,
          text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        log.error(`[notify] Resend returned ${response.status}: ${detail.slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (error) {
      log.error(`[notify] could not send "${subject}": ${error.message}`);
      return false;
    }
  }

  /** Send, fire and forget. The returned promise never rejects. */
  function notify(message) {
    return send(message).catch((error) => {
      log.error('[notify]', error);
      return false;
    });
  }

  /** Like notify, but at most once per `intervalMs` for the same key. */
  function notifyAtMostEvery(key, intervalMs, message) {
    const last = lastSent.get(key);
    if (last !== undefined && now() - last < intervalMs) return Promise.resolve(false);
    lastSent.set(key, now());
    return notify(message);
  }

  return { notify, notifyAtMostEvery };
}

const shared = createNotifier();
export const notify = shared.notify;
export const notifyAtMostEvery = shared.notifyAtMostEvery;
