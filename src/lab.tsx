/**
 * Render lab — a contact sheet of every template.
 *
 * Dev-server only (`vite build` never sees lab.html), and the reason it
 * exists is that judging six visual systems by exporting six videos is
 * unworkable. This draws one frame of each, side by side, at a moment chosen
 * to be mid-lyric so the type treatment is visible.
 *
 *   npm run dev  →  http://localhost:5174/lab.html
 *   node scripts/contact-sheet.mjs   (screenshots it)
 *
 * `?t=6.2` picks the timestamp, `?palette=ember` forces a palette,
 * `?mode=karaoke` forces a lyric mode.
 */

import { FONTS, TEMPLATES } from '../shared/templates.mjs';
import { PALETTES_BY_ID, PALETTES } from '../shared/palettes.mjs';
import { demoAlignment, demoPlan, demoTrack } from './lib/demo';
import { ensureAllFonts } from './lib/fonts';
import { Renderer } from './render/engine';
import type { LyricMode, Plan } from './types';

const params = new URLSearchParams(location.search);
const at = Number(params.get('t') ?? '3.05');
const forcedPalette = params.get('palette');
const forcedMode = params.get('mode') as LyricMode | null;
const width = Number(params.get('w') ?? '854');
const height = Math.round(width * (9 / 16));

// One palette per template by default, so the sheet shows range rather than
// six copies of the same colour scheme.
const DEFAULT_PALETTES: Record<string, string> = {
  aurora: 'bloom',
  kinetic: 'rust',
  filmstrip: 'sepia',
  neon: 'neon-noir',
  editorial: 'monolith',
  spectrum: 'tidal',
};

async function main() {
  await ensureAllFonts(FONTS as unknown as Parameters<typeof ensureAllFonts>[0]);

  const grid = document.getElementById('grid')!;
  const alignment = demoAlignment();
  const track = demoTrack(60);

  const cells = params.get('palettes') === '1'
    ? PALETTES.map((palette) => ({ template: params.get('template') || 'aurora', palette: palette.id }))
    : TEMPLATES.map((template) => ({
      template: template.id,
      palette: forcedPalette || DEFAULT_PALETTES[template.id] || 'midnight',
    }));

  for (const cell of cells) {
    const template = TEMPLATES.find((t) => t.id === cell.template)!;
    const palette = PALETTES_BY_ID[cell.palette] ?? PALETTES_BY_ID.midnight;

    const base = demoPlan();
    const mode: LyricMode = forcedMode && template.lyricModes.includes(forcedMode)
      ? forcedMode
      : (template.defaultLyricMode as LyricMode);

    const plan: Plan = {
      ...base,
      template: template.id,
      palette: {
        id: palette.id,
        bg: [...palette.bg],
        fg: palette.fg,
        dim: palette.dim,
        accent: palette.accent,
        accent2: palette.accent2,
        glow: palette.glow,
      },
      typography: {
        ...base.typography,
        font: template.typography.font,
        case: template.typography.case as Plan['typography']['case'],
        weight: template.typography.weight,
        align: template.typography.align as Plan['typography']['align'],
        tracking: template.typography.tracking,
      },
      lyrics: { ...base.lyrics, mode, linesVisible: mode === 'cascade' ? 3 : 2 },
      reactivity: { ...base.reactivity, pulse: template.motion.pulse },
    };

    const figure = document.createElement('figure');
    const canvas = document.createElement('canvas');
    figure.append(canvas);
    const caption = document.createElement('figcaption');
    caption.textContent = `${template.name} · ${palette.name} · ${mode}`;
    figure.append(caption);
    grid.append(figure);

    // One broken template must not blank the whole sheet — that is exactly
    // when you most want to see the other five.
    try {
      const renderer = new Renderer(canvas, width, height);
      renderer.setScene({
        plan, alignment, audio: track, photos: [],
        fontStack: fontStackOf(template.typography.font),
        fontOptical: (FONTS.find((f) => f.id === template.typography.font)?.optical ?? 1) as number,
      });
      renderer.render(at);
    } catch (error) {
      caption.textContent = `${template.name} FAILED: ${(error as Error).message}`;
      caption.style.color = '#ff6a5e';
      console.error(template.id, error);
    }
  }

  document.body.dataset.ready = 'true';
}

function fontStackOf(id: string): string {
  const table: Record<string, string> = {
    anton: '"Anton", Impact, sans-serif',
    bebas: '"Bebas Neue", Impact, sans-serif',
    'archivo-black': '"Archivo Black", sans-serif',
    inter: '"Inter", system-ui, sans-serif',
    'space-grotesk': '"Space Grotesk", sans-serif',
    oswald: '"Oswald", sans-serif',
    playfair: '"Playfair Display", Georgia, serif',
    cormorant: '"Cormorant Garamond", Georgia, serif',
    'dm-serif': '"DM Serif Display", Georgia, serif',
    caveat: '"Caveat", cursive',
    jetbrains: '"JetBrains Mono", monospace',
  };
  return table[id] ?? 'system-ui, sans-serif';
}

main().catch((error) => {
  console.error('lab failed:', error);
  document.body.dataset.ready = 'error';
});
