/**
 * Font loading.
 *
 * Canvas text silently falls back when a face is not yet loaded — there is no
 * error, just a frame set in the wrong typeface. Since a render is thousands
 * of frames produced as fast as the machine can manage, a face arriving one
 * second late would be baked into thirty frames of the finished file. So we
 * wait for the specific face before rendering anything.
 */

import type { FontInfo } from '../types';

const loaded = new Set<string>();

export function fontStackFor(fonts: FontInfo[], id: string): string {
  return fonts.find((f) => f.id === id)?.stack ?? 'system-ui, sans-serif';
}

export function fontOpticalFor(fonts: FontInfo[], id: string): number {
  return fonts.find((f) => f.id === id)?.optical ?? 1;
}

function familyOf(stack: string): string {
  const first = stack.split(',')[0]?.trim() ?? '';
  return first.replace(/^["']|["']$/g, '');
}

/**
 * Ensure a family is ready at the weights we might draw with.
 * Resolves even on failure — a missing font should degrade the look, not
 * block the export.
 */
export async function ensureFont(stack: string, weights: number[] = [400]): Promise<void> {
  const family = familyOf(stack);
  if (!family || loaded.has(family)) return;

  try {
    await Promise.all(
      weights.map((weight) => document.fonts.load(`${weight} 64px "${family}"`)),
    );
    // load() resolves per face; ready waits for the whole document to settle,
    // which also covers faces the CSS pulled in for other weights.
    await document.fonts.ready;
    loaded.add(family);
  } catch {
    // Leave it out of `loaded` so a later attempt can retry.
  }
}

export async function ensureAllFonts(fonts: FontInfo[]): Promise<void> {
  await Promise.all(fonts.map((font) => ensureFont(font.stack, font.weights)));
}
