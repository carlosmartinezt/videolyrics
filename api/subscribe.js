/**
 * POST /api/subscribe  { email, website }
 *
 * A Vercel function. Emails the owner the address through Resend, so the
 * list is the owner's inbox. `website` is a field people never see: a bot
 * that fills it in gets a 200 and nothing is sent.
 *
 *   RESEND_API_KEY   required, set in the Vercel project
 *   NOTIFY_TO        default carlosmartinezt@gmail.com
 *   NOTIFY_FROM      default "videolyrics <info@saveyourchess.com>"
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'bad request' }, { status: 400 });
  }

  const email = String(body?.email ?? '').trim();
  if (body?.website) return Response.json({ ok: true });
  if (email.length > 254 || !EMAIL.test(email)) {
    return Response.json({ error: 'not an email address' }, { status: 400 });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('[subscribe] RESEND_API_KEY is not set');
    return Response.json({ error: 'not set up' }, { status: 503 });
  }

  const country = request.headers.get('x-vercel-ip-country') || 'unknown';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM || 'videolyrics <info@saveyourchess.com>',
      to: [process.env.NOTIFY_TO || 'carlosmartinezt@gmail.com'],
      reply_to: email,
      subject: `videolyrics sign-up: ${email}`,
      text: `${email} wants to hear when videolyrics opens.\nCountry: ${country}\n`,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`[subscribe] Resend returned ${response.status}: ${detail.slice(0, 200)}`);
    return Response.json({ error: 'could not send' }, { status: 502 });
  }
  return Response.json({ ok: true });
}
