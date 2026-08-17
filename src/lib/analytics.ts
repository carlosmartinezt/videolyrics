/**
 * Google Analytics 4.
 *
 * The loader lives in index.html as an external script; the configuration
 * lives here rather than in an inline `<script>` block. That is deliberate:
 * allowing `'unsafe-inline'` in script-src to accommodate four lines of setup
 * would weaken the policy protecting a page that handles people's files and
 * sign-in tokens. gtag.js drains whatever is already in `dataLayer` when it
 * loads, so running from the bundle is equivalent.
 *
 * What is sent is deliberately thin. No lyrics, no song titles, no file names,
 * no email addresses, no user ids — the questions worth answering are "did
 * anyone finish a video" and "where do people stop", and those need counts and
 * durations, not content.
 */

const MEASUREMENT_ID = 'G-R2T77DXX6B'; // also in index.html's loader tag

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let ready = false;

export function initAnalytics(): void {
  if (ready || typeof window === 'undefined') return;
  ready = true;

  window.dataLayer = window.dataLayer || [];

  // This must push the `arguments` object, not a real array, exactly as
  // Google's own snippet does. gtag.js distinguishes the two, and given an
  // array it initialises the tag, reports no error, and then silently never
  // sends a single hit — which is the worst possible failure for analytics,
  // because the dashboard just looks like nobody came. Measured: array form
  // 0 beacons, arguments form 2.
  const gtag = function (this: unknown) {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  } as (...args: unknown[]) => void;
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID, {
    // The address bar carries a magic-link token on the way back from
    // sign-in. tidyCallbackUrl() strips it, but the page can load before that
    // runs, and a token in an analytics payload would outlive the session it
    // belongs to.
    page_location: window.location.origin + window.location.pathname,
  });
}

/** Events worth counting. Named for the funnel, not for the code. */
export type AnalyticsEvent =
  | 'song_selected'
  | 'generate_started'
  | 'generate_failed'
  | 'video_ready'
  | 'signin_prompted'
  | 'redesigned'
  | 'export_started'
  | 'export_finished'
  | 'export_failed';

export function track(event: AnalyticsEvent, params: Record<string, string | number | boolean> = {}): void {
  // A blocked or absent gtag must never break the app. Analytics is the least
  // important thing on the page.
  try {
    window.gtag?.('event', event, params);
  } catch {
    /* ignore */
  }
}
