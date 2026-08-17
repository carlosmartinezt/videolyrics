/**
 * Curated colour palettes, tagged by mood.
 *
 * Hand-picked rather than generated, because generated palettes tend to be
 * *valid* and *forgettable* — evenly spaced hues at uniform saturation. Each
 * of these has a deliberate imbalance: a dominant, a support, and one colour
 * that does nothing but punch.
 *
 * Contract for every palette:
 *   bg      two or three stops for the background gradient, dark end first
 *   fg      lyric colour, must clear 7:1 against bg[0]
 *   dim     lyric colour for not-yet-sung / already-sung words
 *   accent  the highlight colour for the word being sung right now
 *   accent2 secondary, for particles, rules, underlines
 *   glow    what light bleeds around bright elements
 */

export const PALETTES = [
  {
    id: 'ember',
    name: 'Ember',
    moods: ['warm', 'romantic', 'nostalgic', 'soulful'],
    bg: ['#1a0d0a', '#3d1a17', '#120807'],
    fg: '#fff3e8',
    dim: '#8a6a5c',
    accent: '#ff7a45',
    accent2: '#ffc46b',
    glow: '#ff5722',
  },
  {
    id: 'midnight',
    name: 'Midnight',
    moods: ['melancholy', 'calm', 'introspective', 'cinematic'],
    bg: ['#070b18', '#131f3d', '#04060f'],
    fg: '#e8eeff',
    dim: '#5a6788',
    accent: '#6ea8ff',
    accent2: '#a78bfa',
    glow: '#3b82f6',
  },
  {
    id: 'neon-noir',
    name: 'Neon Noir',
    moods: ['energetic', 'dark', 'electronic', 'aggressive'],
    bg: ['#0a0410', '#1d0733', '#050208'],
    fg: '#f5e9ff',
    dim: '#6b4a85',
    accent: '#ff2d95',
    accent2: '#00e5ff',
    glow: '#ff2d95',
  },
  {
    id: 'sunbleached',
    name: 'Sunbleached',
    moods: ['happy', 'summer', 'bright', 'playful'],
    bg: ['#12212b', '#1f4a55', '#0b171e'],
    fg: '#fffaf0',
    dim: '#7fa39f',
    accent: '#ffd24a',
    accent2: '#4ee0c0',
    glow: '#ffd24a',
  },
  {
    id: 'monolith',
    name: 'Monolith',
    moods: ['minimal', 'serious', 'modern', 'cold'],
    bg: ['#0d0d0f', '#1c1c22', '#08080a'],
    fg: '#fafafa',
    dim: '#5c5c66',
    accent: '#ffffff',
    accent2: '#9b9bab',
    glow: '#ffffff',
  },
  {
    id: 'bloom',
    name: 'Bloom',
    moods: ['romantic', 'dreamy', 'soft', 'hopeful'],
    bg: ['#180d1c', '#3a1b3d', '#0f070f'],
    fg: '#ffeef7',
    dim: '#8f6b86',
    accent: '#ff8fc7',
    accent2: '#c9a4ff',
    glow: '#ff8fc7',
  },
  {
    id: 'forest',
    name: 'Forest',
    moods: ['calm', 'organic', 'folk', 'grounded'],
    bg: ['#0a1410', '#1b3226', '#060d0a'],
    fg: '#f0f7ee',
    dim: '#5f7a67',
    accent: '#8fd694',
    accent2: '#e0c37a',
    glow: '#5fbf72',
  },
  {
    id: 'rust',
    name: 'Rust',
    moods: ['gritty', 'rock', 'raw', 'defiant'],
    bg: ['#140d0a', '#3a2117', '#0a0605'],
    fg: '#fdefe2',
    dim: '#8a6551',
    accent: '#e8542f',
    accent2: '#d9a441',
    glow: '#e8542f',
  },
  {
    id: 'ultraviolet',
    name: 'Ultraviolet',
    moods: ['electronic', 'futuristic', 'euphoric', 'energetic'],
    bg: ['#0b0620', '#241154', '#060312'],
    fg: '#f0ecff',
    dim: '#6350a5',
    accent: '#b388ff',
    accent2: '#39e0ff',
    glow: '#8b5cf6',
  },
  {
    id: 'sepia',
    name: 'Sepia',
    moods: ['nostalgic', 'vintage', 'acoustic', 'tender'],
    bg: ['#151009', '#332714', '#0c0906'],
    fg: '#fdf3df',
    dim: '#8a7a5c',
    accent: '#e8c07a',
    accent2: '#c98f5a',
    glow: '#e8c07a',
  },
  {
    id: 'ice',
    name: 'Ice',
    moods: ['cold', 'ethereal', 'ambient', 'lonely'],
    bg: ['#0a1418', '#16323d', '#050c0f'],
    fg: '#eefaff',
    dim: '#5b7d8a',
    accent: '#8fe5f5',
    accent2: '#cfe8ff',
    glow: '#5fd0e8',
  },
  {
    id: 'crimson',
    name: 'Crimson',
    moods: ['dramatic', 'passionate', 'dark', 'intense'],
    bg: ['#12060a', '#3d0c1c', '#080305'],
    fg: '#fff0f2',
    dim: '#8a4f5d',
    accent: '#ff3d5a',
    accent2: '#ffa8b4',
    glow: '#ff1f45',
  },
  {
    id: 'gold-leaf',
    name: 'Gold Leaf',
    moods: ['elegant', 'triumphant', 'classic', 'grand'],
    bg: ['#0f0d08', '#2b2415', '#070603'],
    fg: '#fff9ec',
    dim: '#8a7f60',
    accent: '#f0c96b',
    accent2: '#fff2c4',
    glow: '#e8b84a',
  },
  {
    id: 'tidal',
    name: 'Tidal',
    moods: ['flowing', 'hopeful', 'expansive', 'uplifting'],
    bg: ['#04141c', '#0d3b4a', '#020b10'],
    fg: '#eafcff',
    dim: '#4d8496',
    accent: '#33d6d0',
    accent2: '#8ce0a0',
    glow: '#20c9c4',
  },
];

export const PALETTES_BY_ID = Object.fromEntries(PALETTES.map((p) => [p.id, p]));

/** Every mood word any palette answers to — used to seed the mood picker. */
export const MOOD_VOCABULARY = [...new Set(PALETTES.flatMap((p) => p.moods))].sort();

/**
 * Score how well a palette matches a set of mood words.
 * Exact tag hits dominate; substring hits are a weak tiebreak so that
 * "dreamlike" still finds "dreamy".
 */
export function scorePalette(palette, moodWords) {
  let score = 0;
  for (const word of moodWords) {
    const w = word.toLowerCase().trim();
    if (!w) continue;
    if (palette.moods.includes(w)) score += 3;
    else if (palette.moods.some((m) => m.includes(w) || w.includes(m))) score += 1;
  }
  return score;
}

/* ---------------------------------------------------------------------- */
/* Colour maths. Kept here so the server and the browser agree exactly.    */
/* ---------------------------------------------------------------------- */

export function hexToRgb(hex) {
  const clean = String(hex).replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('');
}

export function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }) {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return { r: channel(h + 1 / 3) * 255, g: channel(h) * 255, b: channel(h - 1 / 3) * 255 };
}

/** WCAG relative luminance. */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Nudge a foreground colour until it is legible on a background.
 *
 * Lyrics sit on top of moving imagery, so 4.5:1 is not enough — text that
 * merely passes AA over the *average* background disappears the moment a
 * bright frame comes up. We push to 7:1 and let the renderer add a scrim on
 * top of photos as well.
 */
export function ensureContrast(fg, bg, target = 7) {
  if (contrastRatio(fg, bg) >= target) return fg;
  const bgLum = luminance(bg);
  const hsl = rgbToHsl(hexToRgb(fg));
  const towardsLight = bgLum < 0.5;

  let best = fg;
  let bestRatio = contrastRatio(fg, bg);
  for (let step = 1; step <= 20; step++) {
    const l = towardsLight
      ? Math.min(1, hsl.l + step * 0.04)
      : Math.max(0, hsl.l - step * 0.04);
    const candidate = rgbToHex(hslToRgb({ ...hsl, l }));
    const ratio = contrastRatio(candidate, bg);
    if (ratio > bestRatio) { best = candidate; bestRatio = ratio; }
    if (ratio >= target) return candidate;
  }
  // Saturation was the thing holding it back; fall back to plain black/white.
  return towardsLight ? '#ffffff' : '#0a0a0a';
}
