/** Shared maths for the renderer. Pure functions, no canvas state. */

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Smooth 0→1 ramp between two edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

export const easeOutCubic = (t: number) => 1 - (1 - clamp(t)) ** 3;
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * clamp(t)));
export const easeInOutQuad = (t: number) => {
  const x = clamp(t);
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
};

/* ------------------------------- colour ---------------------------------- */

export interface Rgb { r: number; g: number; b: number }

export function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = Number.parseInt(full.slice(0, 6), 16);
  return Number.isNaN(n)
    ? { r: 0, g: 0, b: 0 }
    : { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${clamp(alpha).toFixed(3)})`;
}

export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp(t);
  const to = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${to(lerp(ca.r, cb.r, k))}${to(lerp(ca.g, cb.g, k))}${to(lerp(ca.b, cb.b, k))}`;
}

/** Rotate a colour's hue by `shift` turns (1 = full circle), keeping S and L. */
export function shiftHue(hex: string, shift: number): string {
  if (!shift) return hex;
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return hex;
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;

  h = (h + shift + 1) % 1;

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let tt = (t + 1) % 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${to(channel(h + 1 / 3))}${to(channel(h))}${to(channel(h - 1 / 3))}`;
}

/* ------------------------------ deterministic ---------------------------- */

/**
 * A stable hash → 0..1. Used anywhere the renderer wants variety without
 * randomness: which photo a section gets, how a particle is angled, where a
 * blob starts. Same input, same frame, forever — which is what makes the
 * preview and the export identical.
 */
export function hash01(...values: number[]): number {
  let h = 2166136261;
  for (const value of values) {
    let v = Math.imul(Math.round(value * 1000) | 0, 0x9e3779b1);
    v ^= v >>> 15;
    h = Math.imul(h ^ v, 16777619);
  }
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}

/** Value noise in one dimension — smooth, cheap, repeatable. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(i, seed);
  const b = hash01(i + 1, seed);
  const t = f * f * (3 - 2 * f);
  return lerp(a, b, t);
}

/* ------------------------------- geometry -------------------------------- */

export interface Frame {
  width: number;
  height: number;
  /** Shortest edge — the unit everything scales against. */
  unit: number;
  /** Safe inset for text, in pixels. */
  margin: number;
  portrait: boolean;
}

export function frameGeometry(width: number, height: number): Frame {
  const unit = Math.min(width, height);
  return {
    width,
    height,
    unit,
    // Broadcast-ish title-safe margin, a little wider on portrait where the
    // platform chrome (captions, buttons) eats the edges.
    margin: Math.round(unit * (height > width ? 0.1 : 0.075)),
    portrait: height > width,
  };
}
