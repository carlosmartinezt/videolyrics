/**
 * End-to-end check: upload → align → design → preview → encode → MP4.
 *
 * This drives a real Chrome because the two things most likely to break are
 * things only a real browser can tell us: whether WebCodecs will encode
 * H.264 + AAC here, and whether the canvas actually draws what we think.
 * The MP4 it produces is written to disk and probed with ffprobe, so a pass
 * means a genuinely playable file, not just an absence of exceptions.
 *
 *   node scripts/e2e.mjs --audio path/to.mp3 --lyrics path/to.txt [--keep]
 *
 * Requires the API on :3058 and the built app on :5175.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => {
    if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1]?.startsWith('--') === false ? all[index + 1] : true]);
    return pairs;
  }, []),
);

const APP = args.app || 'http://localhost:5175/';
const OUT = args.out || path.join(ROOT, 'data', 'e2e');
const FFPROBE = process.env.FFPROBE_BIN || path.join(process.env.HOME || '', 'bin', 'ffprobe');

const steps = [];
function step(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  if (!args.audio || !args.lyrics) {
    console.error('need --audio and --lyrics');
    process.exit(2);
  }
  await fs.mkdir(OUT, { recursive: true });
  const lyrics = await fs.readFile(args.lyrics, 'utf8');

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/opt/google/chrome/chrome',
    headless: true,
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      // Headless Chrome needs a GL implementation for canvas compositing;
      // swiftshader is software but produces identical pixels.
      '--enable-unsafe-swiftshader',
    ],
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  try {
    await page.goto(APP, { waitUntil: 'networkidle' });
    step('app loads', true);

    // Only the video encoder is required. Audio is copied out of the upload
    // rather than re-encoded, which is the whole reason this works on Linux,
    // where Chrome ships an AAC decoder and no AAC encoder.
    const capability = await page.evaluate(async () => {
      const video = await VideoEncoder.isConfigSupported({
        codec: 'avc1.640028', width: 1280, height: 720, framerate: 30, bitrate: 4e6,
      }).then((r) => r.supported).catch(() => false);
      const aac = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000,
      }).then((r) => r.supported).catch(() => false);
      return { video, aac };
    });
    step('h264 encoding available', capability.video, `aac encoder: ${capability.aac}`);

    // Let the hero canvas run a moment, then confirm it is not a blank frame.
    await page.waitForTimeout(2500);
    const heroPixels = await page.evaluate(() => {
      const canvas = document.querySelector('.hero-stage canvas');
      if (!canvas) return null;
      const probe = document.createElement('canvas');
      probe.width = 64; probe.height = 36;
      const ctx = probe.getContext('2d');
      ctx.drawImage(canvas, 0, 0, 64, 36);
      const { data } = ctx.getImageData(0, 0, 64, 36);
      const seen = new Set();
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        seen.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
        sum += data[i] + data[i + 1] + data[i + 2];
      }
      return { colours: seen.size, brightness: sum / (data.length / 4) / 3 };
    });
    step(
      'hero renders something',
      Boolean(heroPixels && heroPixels.colours > 6 && heroPixels.brightness > 4),
      heroPixels ? `${heroPixels.colours} distinct colours, mean ${heroPixels.brightness.toFixed(1)}` : 'no canvas',
    );

    await page.screenshot({ path: path.join(OUT, '1-landing.png'), fullPage: false });

    /* ---- fill in the form ------------------------------------------- */

    await page.setInputFiles('input[type=file][accept*="audio"]', path.resolve(args.audio));
    await page.fill('.textarea', lyrics);
    await page.fill('#title', args.title || 'Alignment Test');
    await page.fill('#artist', args.artist || 'videolyrics');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, '2-setup.png'), fullPage: true });
    step('form accepts audio and lyrics', true);

    /* ---- run it ------------------------------------------------------ */

    const startedAt = Date.now();
    await page.getByRole('button', { name: 'Make the video' }).click();
    await page.waitForSelector('.working', { timeout: 10_000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '3-working.png') });

    await page.waitForSelector('.studio', { timeout: 480_000 });
    const alignSeconds = (Date.now() - startedAt) / 1000;
    step('alignment finished', true, `${alignSeconds.toFixed(0)}s`);

    // The reactivity table is built just after the studio appears.
    await page.waitForFunction(
      () => !document.querySelector('.stage .spin'),
      { timeout: 120_000 },
    );
    await page.waitForTimeout(800);

    const plan = await page.evaluate(() => {
      const cues = [...document.querySelectorAll('.cue')].map((row) => ({
        n: row.querySelector('.n')?.textContent,
        t: row.querySelector('.t')?.textContent,
        label: row.querySelector('.label')?.textContent,
        treatment: row.querySelector('.treatment')?.textContent,
      }));
      return {
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        cues,
        meta: document.querySelector('.topbar-meta')?.textContent,
      };
    });
    step('cue sheet built', plan.cues.length > 0, `${plan.cues.length} cues, accent ${plan.accent}`);
    step('interface adopted the palette', /^#|rgb/.test(plan.accent), plan.accent);

    await page.screenshot({ path: path.join(OUT, '4-studio.png'), fullPage: true });

    /* ---- accounts and credits ---------------------------------------- */

    const accountsOn = await page.evaluate(async () => {
      const config = await fetch('/api/config').then((r) => r.json());
      return config.auth?.enabled === true;
    });

    if (accountsOn) {
      // Anonymous: the export button must lead to a sign-in sheet, not a file.
      await page.getByRole('button', { name: 'Export MP4' }).click();
      const signInShown = await page.locator('.dialog h2', { hasText: 'Sign in' })
        .first().isVisible({ timeout: 5000 }).catch(() => false);
      step('anonymous export asks for an account', signInShown);
      await page.screenshot({ path: path.join(OUT, '5-signin.png') });

      await page.fill('#signin-email', args.email || 'e2e@example.com');
      // Scope to the sheet: the header carries a "Sign in" button too.
      await page.locator('.dialog').getByRole('button', { name: /^Sign in$|Send me a link/ }).click();
      await page.waitForSelector('.credits', { timeout: 10_000 });

      const before = await page.locator('.credits b').textContent();
      step('signed in with a credit balance', before?.trim() === '5', `${before?.trim()} credits`);
    } else {
      step('accounts configured', false, 'auth disabled — skipping credit checks');
    }

    // Seek across the song and confirm the preview keeps drawing.
    const previewProbe = await page.evaluate(async () => {
      const canvas = document.querySelector('.stage canvas');
      const scrub = document.querySelector('.scrub');
      if (!canvas || !scrub) return null;
      const samples = [];
      for (const fraction of [0.05, 0.3, 0.55, 0.8]) {
        const value = Number(scrub.max) * fraction;
        scrub.value = String(value);
        scrub.dispatchEvent(new Event('change', { bubbles: true }));
        scrub.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 260));
        const probe = document.createElement('canvas');
        probe.width = 32; probe.height = 18;
        const ctx = probe.getContext('2d');
        ctx.drawImage(canvas, 0, 0, 32, 18);
        const { data } = ctx.getImageData(0, 0, 32, 18);
        let sum = 0;
        const seen = new Set();
        for (let i = 0; i < data.length; i += 4) {
          sum += data[i] + data[i + 1] + data[i + 2];
          seen.add(`${data[i] >> 5},${data[i + 1] >> 5},${data[i + 2] >> 5}`);
        }
        samples.push({ at: value.toFixed(1), mean: +(sum / (data.length / 4) / 3).toFixed(1), colours: seen.size });
      }
      return samples;
    });
    const previewOk = Boolean(previewProbe?.every((s) => s.mean > 3 && s.colours > 2));
    step('preview draws across the song', previewOk, JSON.stringify(previewProbe));

    /* ---- export ------------------------------------------------------ */

    await page.getByRole('button', { name: 'Export MP4' }).click();
    await page.waitForSelector('.dialog', { timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, '6-export.png') });

    const encodeStarted = Date.now();
    // Signed in and not yet unlocked, the button spends the credit first.
    const startButton = page.getByRole('button', { name: /Use 1 credit and encode|Start encoding/ });
    await startButton.click();

    if (accountsOn) {
      await page.waitForFunction(
        () => document.querySelector('.credits b')?.textContent?.trim() === '4',
        { timeout: 30_000 },
      ).catch(() => {});
      const after = await page.locator('.credits b').textContent();
      step('exporting spent exactly one credit', after?.trim() === '4', `${after?.trim()} left`);
    }

    const download = page.waitForEvent('download', { timeout: 900_000 });
    await page.waitForSelector('a.btn-primary[download]', { timeout: 900_000 });
    const encodeSeconds = (Date.now() - encodeStarted) / 1000;
    await page.screenshot({ path: path.join(OUT, '7-done.png') });

    await page.click('a.btn-primary[download]');
    const file = await download;
    const target = path.join(OUT, 'output.mp4');
    await file.saveAs(target);

    const stat = await fs.stat(target);
    step('encoded an mp4', stat.size > 20_000, `${(stat.size / 1024 / 1024).toFixed(2)} MB in ${encodeSeconds.toFixed(0)}s`);

    /* ---- verify the file --------------------------------------------- */

    const { stdout } = await run(FFPROBE, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', target,
    ]);
    const probe = JSON.parse(stdout);
    const video = probe.streams.find((s) => s.codec_type === 'video');
    const audio = probe.streams.find((s) => s.codec_type === 'audio');

    // ffprobe reports frame rate as a rational string like "30/1".
    const rate = (value) => {
      const [num, den] = String(value || '0/1').split('/').map(Number);
      return den ? Math.round((num / den) * 100) / 100 : 0;
    };
    step('has an h264 video stream', video?.codec_name === 'h264',
      video ? `${video.width}x${video.height} ${rate(video.r_frame_rate)}fps` : 'missing');
    // Whatever the upload carried, so long as MP4 can hold it.
    const CARRIABLE = ['aac', 'mp3', 'opus', 'flac'];
    step('has an audio stream MP4 can carry', CARRIABLE.includes(audio?.codec_name),
      audio ? `${audio.codec_name}, ${audio.sample_rate} Hz, ${audio.channels}ch` : 'missing');

    const declared = Number(probe.format.duration);
    step('duration is right', declared > 5, `${declared.toFixed(1)}s`);

    // Decode a frame from the middle: a file that probes clean but cannot be
    // decoded is exactly the failure this whole check exists to catch.
    const frameAt = Math.max(1, declared / 2);
    const still = path.join(OUT, 'frame.png');
    await run(process.env.FFMPEG_BIN || path.join(process.env.HOME || '', 'bin', 'ffmpeg'), [
      '-v', 'error', '-y', '-ss', String(frameAt), '-i', target, '-frames:v', '1', still,
    ]);
    const stillStat = await fs.stat(still);
    step('a frame decodes from the middle', stillStat.size > 4000, `${(stillStat.size / 1024).toFixed(0)} KB`);

    // The watermark sits bottom-right. Compare that corner's luminance spread
    // against the mirrored corner, which the renderer leaves empty: light text
    // on a dark ground shows up as markedly more variance.
    const corner = async (x) => {
      const out = path.join(OUT, `corner-${x}.txt`);
      const { stdout: stats } = await run(
        process.env.FFMPEG_BIN || path.join(process.env.HOME || '', 'bin', 'ffmpeg'),
        ['-v', 'error', '-i', still, '-vf',
          `crop=iw*0.3:ih*0.12:${x}:ih*0.84,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-`,
          '-f', 'null', '-'],
      );
      await fs.writeFile(out, stats).catch(() => {});
      const match = /YMAX=(\d+)/.exec(stats);
      return match ? Number(match[1]) : 0;
    };
    const rightMax = await corner('iw*0.68');
    const leftMax = await corner('0');
    step('the watermark is burned into the frame', rightMax > leftMax + 25,
      `bottom-right peak ${rightMax} vs bottom-left ${leftMax}`);

    step('no console errors', consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | ') || 'clean');
  } catch (error) {
    step('run completed', false, error.message);
    await page.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {});
  } finally {
    if (!args.keep) await browser.close();
  }

  const failed = steps.filter((s) => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} checks passed. Artefacts in ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main();
