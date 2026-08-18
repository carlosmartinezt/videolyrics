/**
 * Render one still of every template into public/templates/<id>.webp.
 *
 *   node scripts/thumbnails.mjs
 *
 * These are what the "Look" cards show, so somebody can see what Filmstrip or
 * Neon actually looks like before spending a minute and a credit finding out.
 * They are generated rather than hand-made because a template's look is defined
 * by its renderer — a screenshot cannot drift from the code, a mockup can.
 *
 * Starts its own dev server: lab.html is dev-only and never in the build.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'public', 'templates');
const PORT = 5179;
const FFMPEG = process.env.FFMPEG_BIN || path.join(process.env.HOME || '', 'bin', 'ffmpeg');

const { TEMPLATES } = await import(path.join(ROOT, 'shared', 'templates.mjs'));

await fs.mkdir(OUT, { recursive: true });

// --host 127.0.0.1 matters: left to itself vite binds IPv6 loopback only, and
// the readiness poll below asks for 127.0.0.1, which then never connects.
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore', detached: false,
});
const stopVite = () => { try { vite.kill('SIGTERM'); } catch { /* already gone */ } };
// Every exit path, not just the clean one — a crashed run once left the dev
// server holding the port, which then broke the following run as well.
process.on('exit', stopVite);
process.on('uncaughtException', (error) => { stopVite(); console.error(error); process.exit(1); });
process.on('unhandledRejection', (error) => { stopVite(); console.error(error); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopVite(); process.exit(1); });

// Wait for it rather than guessing at a sleep length.
const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(`${base}/lab.html`);
    if (response.ok) { up = true; break; }
  } catch { /* not up yet */ }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!up) {
  stopVite();
  throw new Error(`the dev server never came up on ${PORT} — is something already using that port?`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/opt/google/chrome/chrome',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

// 3.05s lands inside the first chorus of the lab's sample, where every
// template is doing its most characteristic thing rather than sitting on an
// intro that looks the same for all six.
const page = await browser.newPage({ viewport: { width: 1400, height: 2400 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`${base}/lab.html?w=640&t=3.05`, { waitUntil: 'networkidle' });
await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
await page.waitForTimeout(600);

const canvases = page.locator('figure canvas');
const count = await canvases.count();
if (count !== TEMPLATES.length) {
  throw new Error(`lab drew ${count} canvases but there are ${TEMPLATES.length} templates`);
}

for (const [index, template] of TEMPLATES.entries()) {
  const png = path.join(OUT, `${template.id}.png`);
  const webp = path.join(OUT, `${template.id}.webp`);
  await canvases.nth(index).screenshot({ path: png });
  // WebP because six dark gradients as PNG is close to a megabyte, and JPEG
  // bands badly on exactly the smooth dark fields these templates are made of.
  await run(FFMPEG, ['-v', 'error', '-y', '-i', png, '-vf', 'scale=640:-2', '-quality', '82', webp]);
  await fs.unlink(png);
  const { size } = await fs.stat(webp);
  console.log(`  ${template.id.padEnd(10)} ${(size / 1024).toFixed(0)} KB`);
}

await browser.close();
stopVite();

if (errors.length) {
  console.error('page errors:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log(`\n${TEMPLATES.length} thumbnails -> public/templates/`);
process.exit(0);
