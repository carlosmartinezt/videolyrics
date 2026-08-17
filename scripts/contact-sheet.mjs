/**
 * Screenshot the render lab.
 *
 *   node scripts/contact-sheet.mjs                      all templates
 *   node scripts/contact-sheet.mjs --palettes --template neon
 *   node scripts/contact-sheet.mjs --t 6.4 --mode karaoke
 *
 * Needs the dev server (npm run dev:web) on :5174.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'data', 'lab');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = args[index + 1];
  return !next || next.startsWith('--') ? '1' : next;
};

const query = new URLSearchParams();
for (const name of ['t', 'palette', 'palettes', 'template', 'mode', 'w']) {
  const value = flag(name);
  if (value !== null) query.set(name, value);
}

const url = `${flag('base', 'http://localhost:5174')}/lab.html?${query}`;
const name = flag('out', `sheet-${[...query.entries()].map(([k, v]) => `${k}${v}`).join('-') || 'default'}.png`);

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/opt/google/chrome/chrome',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 2600, height: 1200 } });

const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
await page.waitForTimeout(500);

const target = path.join(OUT, name);
await page.screenshot({ path: target, fullPage: true });
await browser.close();

if (errors.length) {
  console.error('page errors:\n  ' + errors.join('\n  '));
}
console.log(target);
process.exit(errors.length ? 1 : 0);
