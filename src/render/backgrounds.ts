/**
 * Background painters, one per template.
 *
 * Everything is Canvas2D. There is no WebGL here on purpose: the soft looks
 * that would normally want a fragment shader are drawn into a small buffer
 * (a sixth of the output) and scaled up with smoothing, which is both cheaper
 * than a per-pixel blur and produces exactly the same result on every machine
 * — and identical output between preview and export is the property this
 * whole design is protecting.
 *
 * Painters must be pure functions of their context. No accumulated state, no
 * Math.random: frame 900 must look the same whether you seeked to it or
 * played there. That is what lets the encoder skip around and lets a paused
 * preview match the file.
 */

import type { Plan, Segment } from '../types';
import type { FrameAudio } from '../audio/track';
import {
  clamp, lerp, smoothstep, rgba, mixHex, hash01, noise1, easeOutExpo, type Frame,
} from './util';

export interface ResolvedPalette {
  bg: string[];
  fg: string;
  dim: string;
  accent: string;
  accent2: string;
  glow: string;
}

export interface PaintContext {
  ctx: CanvasRenderingContext2D;
  /** Low-resolution scratch buffer for soft, out-of-focus elements. */
  low: CanvasRenderingContext2D;
  frame: Frame;
  plan: Plan;
  palette: ResolvedPalette;
  time: number;
  audio: FrameAudio;
  bands: Float32Array;
  segment: Segment;
  /** 0..1 through the current segment. */
  segmentProgress: number;
  treatment: string;
  /** Cue intensity after the treatment's own ramp. 0..1. */
  energy: number;
  /** How much anything is allowed to move. 0..1. */
  motion: number;
  /** Onsets in the last couple of seconds: [time, index] pairs. */
  recentOnsets: Array<[number, number]>;
  /** Index of the most recent downbeat, and how long ago it was. */
  bar: { index: number; age: number; length: number };
}

export type Painter = (c: PaintContext) => void;

/* -------------------------------- helpers -------------------------------- */

/** Fill the low-res buffer with the base colour and return its size. */
function beginLow(c: PaintContext, base: string): { w: number; h: number } {
  const { low } = c;
  const w = low.canvas.width;
  const h = low.canvas.height;
  low.globalCompositeOperation = 'source-over';
  low.globalAlpha = 1;
  low.fillStyle = base;
  low.fillRect(0, 0, w, h);
  return { w, h };
}

/** Scale the low-res buffer over the full frame. */
function flushLow(c: PaintContext, alpha = 1): void {
  const { ctx, frame, low } = c;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(low.canvas, 0, 0, low.canvas.width, low.canvas.height, 0, 0, frame.width, frame.height);
  ctx.restore();
}

function radialBlob(
  g: CanvasRenderingContext2D,
  x: number, y: number, radius: number, colour: string, strength: number,
): void {
  if (radius <= 0 || strength <= 0.002) return;
  const gradient = g.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, rgba(colour, strength));
  gradient.addColorStop(0.45, rgba(colour, strength * 0.45));
  gradient.addColorStop(1, rgba(colour, 0));
  g.fillStyle = gradient;
  g.beginPath();
  g.arc(x, y, radius, 0, Math.PI * 2);
  g.fill();
}

/* -------------------------------- aurora --------------------------------- */

/**
 * Slow overlapping colour fields. Five blobs on incommensurable orbits, so
 * the pattern never visibly repeats, drifting faster and glowing brighter
 * with the music.
 */
const paintAurora: Painter = (c) => {
  const { palette, time, audio, energy, motion } = c;
  const { w, h } = beginLow(c, palette.bg[0]);

  c.low.globalCompositeOperation = 'lighter';

  const colours = [palette.accent, palette.accent2, palette.glow, palette.bg[1], palette.accent];
  const drift = time * (0.035 + motion * 0.09);
  const breathe = 0.75 + audio.level * 0.5 + audio.bass * 0.35;

  for (let i = 0; i < 5; i++) {
    const seed = i * 17.13;
    // Prime-ish frequency ratios keep the orbits from re-syncing.
    const x = w * (0.5 + 0.42 * Math.sin(drift * (0.7 + i * 0.13) + seed));
    const y = h * (0.5 + 0.4 * Math.cos(drift * (0.53 + i * 0.19) + seed * 1.7));
    const wobble = 0.85 + noise1(time * 0.35 + i * 5, i) * 0.4;
    const radius = Math.min(w, h) * (0.42 + i * 0.06) * wobble * breathe;
    const strength = (0.2 + energy * 0.4) * (1 - i * 0.09);
    radialBlob(c.low, x, y, radius, colours[i % colours.length], strength);
  }

  // A deep pool in the centre keeps the middle of frame dark enough for type.
  c.low.globalCompositeOperation = 'source-over';
  radialBlob(c.low, w / 2, h / 2, Math.min(w, h) * 0.62, palette.bg[2] || palette.bg[0], 0.55);

  flushLow(c);
};

/* -------------------------------- kinetic -------------------------------- */

/**
 * Flat colour that snaps on the bar, with diagonal bands sliding across it.
 * Drawn at full resolution — the whole point is hard edges.
 */
const paintKinetic: Painter = (c) => {
  const { ctx, frame, palette, energy, bar, audio, motion, time } = c;
  const { width, height } = frame;

  const swatches = [palette.bg[0], palette.bg[1], palette.accent, palette.bg[0], palette.accent2];
  const pick = Math.floor(hash01(bar.index, 7) * swatches.length);
  const base = swatches[pick];
  // Accent-coloured bars are loud; keep them for high-intensity sections.
  const useAccent = energy > 0.6 && hash01(bar.index, 11) > 0.62;
  ctx.fillStyle = useAccent ? base : mixHex(palette.bg[0], base, 0.45);
  ctx.fillRect(0, 0, width, height);

  const bandCount = 3 + Math.floor(energy * 4);
  const slide = (time * (0.05 + motion * 0.35)) % 1;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < bandCount; i++) {
    const phase = (slide + i / bandCount) % 1;
    const thickness = height * (0.06 + hash01(i, bar.index) * 0.12);
    const y = phase * (height + thickness * 2) - thickness;
    const colour = i % 2 === 0 ? palette.accent : palette.accent2;
    ctx.fillStyle = rgba(colour, 0.06 + energy * 0.1);
    ctx.save();
    ctx.translate(width / 2, y);
    ctx.rotate(-0.18);
    ctx.fillRect(-width, 0, width * 2, thickness);
    ctx.restore();
  }
  ctx.restore();

  // A hard flash on the downbeat, gone within a couple of frames.
  const snap = easeOutExpo(1 - clamp(bar.age / 0.12));
  if (snap > 0.01 && energy > 0.5) {
    ctx.fillStyle = rgba(palette.fg, snap * 0.1 * energy);
    ctx.fillRect(0, 0, width, height);
  }

  // Bass pushes a glow up from the floor.
  const bassGlow = audio.bass * energy;
  if (bassGlow > 0.05) {
    const gradient = ctx.createLinearGradient(0, height, 0, height * (0.55 - bassGlow * 0.2));
    gradient.addColorStop(0, rgba(palette.glow, 0.28 * bassGlow));
    gradient.addColorStop(1, rgba(palette.glow, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
};

/* ------------------------------- filmstrip ------------------------------- */

/**
 * The bed under photographs: a slow duotone wash. With no photographs
 * supplied it has to carry the frame alone, so it is given more contrast and
 * a visible drift rather than being left as a flat plate.
 */
const paintFilmstrip: Painter = (c) => {
  const { ctx, frame, plan, palette, time, motion, energy, audio, bar } = c;
  const { w, h } = beginLow(c, palette.bg[0]);
  const bare = !plan.photos.enabled;

  const drift = time * (0.02 + motion * 0.03);
  const cx = w * (0.5 + 0.22 * Math.sin(drift));
  const cy = h * (0.42 + 0.18 * Math.cos(drift * 0.8));

  radialBlob(c.low, cx, cy, Math.max(w, h) * (bare ? 0.85 : 0.7),
    mixHex(palette.bg[1], palette.accent, bare ? 0.4 : 0.18), bare ? 0.85 : 0.5);
  radialBlob(c.low, w - cx, h - cy * 0.7, Math.max(w, h) * 0.55,
    palette.bg[1], 0.45 + audio.level * 0.15);

  if (bare) {
    c.low.globalCompositeOperation = 'lighter';
    radialBlob(c.low, w * 0.5, h * 0.42, Math.min(w, h) * 0.55,
      palette.glow, 0.1 + energy * 0.14);
    c.low.globalCompositeOperation = 'source-over';
  }

  flushLow(c);

  if (!bare) return;

  // With no photographs this template has nothing but a haze, so it borrows
  // the other half of its own name: a projected frame. A soft rectangle of
  // light with a gate edge, drifting the way a projector gate breathes.
  const { width, height, unit } = frame;
  const wobble = Math.sin(time * 0.6) * unit * 0.004 + Math.sin(time * 1.7) * unit * 0.0015;
  const inset = unit * 0.085;
  const gateX = inset + wobble;
  const gateY = inset * 0.7 - wobble * 0.5;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const gate = ctx.createLinearGradient(0, gateY, 0, height - gateY);
  gate.addColorStop(0, rgba(palette.accent, 0.1 + energy * 0.08));
  gate.addColorStop(0.5, rgba(palette.accent2, 0.04));
  gate.addColorStop(1, rgba(palette.accent, 0.09 + energy * 0.06));
  ctx.fillStyle = gate;
  ctx.fillRect(gateX, gateY, width - gateX * 2, height - gateY * 2);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = rgba(palette.fg, 0.11);
  ctx.lineWidth = Math.max(1, unit * 0.0015);
  ctx.strokeRect(gateX, gateY, width - gateX * 2, height - gateY * 2);
  ctx.restore();

  // Sprocket holes down both edges, stepping one perforation per bar. Slow
  // enough to read as mechanism rather than decoration.
  const holeH = unit * 0.052;
  const holeW = unit * 0.03;
  const pitch = holeH * 1.85;
  const offset = -((bar.index + smoothstep(0, bar.length, bar.age)) * pitch) % pitch;
  ctx.save();
  ctx.fillStyle = rgba(palette.fg, 0.09);
  for (let y = offset - pitch; y < height + pitch; y += pitch) {
    roundRect(ctx, inset * 0.28, y, holeW, holeH, holeW * 0.28);
    roundRect(ctx, width - inset * 0.28 - holeW, y, holeW, holeH, holeW * 0.28);
  }
  ctx.restore();
};

function roundRect(
  g: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  g.fill();
}

/* --------------------------------- neon ---------------------------------- */

/**
 * A dark room with a horizon, and sparks thrown off every percussive hit.
 *
 * Particles are stateless: each onset deterministically defines its own
 * sparks, and a spark's position is a function of how long ago that onset
 * was. Nothing accumulates, so seeking is exact.
 */
const paintNeon: Painter = (c) => {
  const { ctx, frame, palette, time, audio, energy, motion, recentOnsets } = c;
  const { width, height, unit } = frame;

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, palette.bg[2] || palette.bg[0]);
  gradient.addColorStop(0.55, palette.bg[0]);
  gradient.addColorStop(1, mixHex(palette.bg[0], palette.glow, 0.12 + audio.bass * 0.1));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Perspective floor. Lines converge on a vanishing point that rides the bass.
  const horizon = height * (0.62 + audio.bass * 0.02);
  ctx.save();
  ctx.strokeStyle = rgba(palette.accent, 0.1 + energy * 0.16);
  ctx.lineWidth = Math.max(1, unit * 0.0016);
  const vanishX = width / 2;
  for (let i = -8; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(vanishX + i * width * 0.09, horizon);
    ctx.lineTo(vanishX + i * width * 0.9, height);
    ctx.stroke();
  }
  // Receding rungs, scrolling towards the viewer.
  const scroll = (time * (0.15 + motion * 0.5)) % 1;
  for (let i = 0; i < 12; i++) {
    const t = ((i + scroll) / 12) ** 2.6;
    const y = horizon + t * (height - horizon);
    ctx.globalAlpha = clamp(0.05 + t * 0.35) * (0.4 + energy * 0.6);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();

  // Glow above the horizon.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  radialBlob(ctx, width / 2, horizon, unit * (0.5 + audio.level * 0.25),
    palette.glow, 0.1 + energy * 0.18);

  const sparkLife = 1.1;
  for (const [onsetTime, index] of recentOnsets) {
    const age = time - onsetTime;
    if (age < 0 || age > sparkLife) continue;
    const fade = 1 - age / sparkLife;
    const count = 5 + Math.floor(energy * 9);
    for (let k = 0; k < count; k++) {
      const angle = hash01(index, k) * Math.PI * 2;
      const speed = (0.25 + hash01(index, k + 99) * 0.85) * unit * (0.35 + energy * 0.5);
      const x = width / 2 + Math.cos(angle) * speed * age;
      const y = horizon - Math.abs(Math.sin(angle)) * speed * age * 0.8 - age * unit * 0.06;
      const size = unit * 0.004 * (0.5 + hash01(index, k + 7) * 1.4) * fade;
      ctx.fillStyle = rgba(k % 3 === 0 ? palette.accent2 : palette.accent, fade * fade * 0.9);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, size), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
};

/* ------------------------------- editorial ------------------------------- */

/**
 * Nearly still. The only motion is a wash that takes half a minute to cross
 * the frame, and a rule under the type that advances with the song.
 */
const paintEditorial: Painter = (c) => {
  const { ctx, frame, palette, time, audio, energy, segment, segmentProgress } = c;
  const { width, height, unit, margin } = frame;

  const gradient = ctx.createLinearGradient(0, 0, width * 0.4, height);
  gradient.addColorStop(0, palette.bg[1]);
  gradient.addColorStop(1, palette.bg[0]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const { w, h } = beginLow(c, 'rgba(0,0,0,0)');
  c.low.clearRect(0, 0, w, h);
  const slow = time * 0.018;
  radialBlob(c.low, w * (0.3 + 0.4 * Math.sin(slow)), h * (0.6 + 0.25 * Math.cos(slow * 0.7)),
    Math.max(w, h) * 0.7, palette.accent, 0.08 + energy * 0.08 + audio.level * 0.05);
  flushLow(c, 1);

  // The page furniture. This template's whole argument is restraint, so what
  // it gets is not motion but *typographic structure*: a margin rule, the
  // section named in the corner, and a measure of how far through it we are.
  const left = margin * 0.55;
  ctx.save();
  ctx.strokeStyle = rgba(palette.fg, 0.14);
  ctx.lineWidth = Math.max(1, unit * 0.0014);
  ctx.beginPath();
  ctx.moveTo(left, margin * 0.7);
  ctx.lineTo(left, height - margin * 0.7);
  ctx.stroke();

  // The rule fills as the section plays — the only thing on screen that moves.
  ctx.strokeStyle = rgba(palette.accent, 0.75);
  ctx.lineWidth = Math.max(1.5, unit * 0.0028);
  ctx.beginPath();
  ctx.moveTo(left, margin * 0.7);
  ctx.lineTo(left, margin * 0.7 + (height - margin * 1.4) * segmentProgress);
  ctx.stroke();

  const label = (segment.label || '').toUpperCase();
  if (label) {
    const size = unit * 0.022;
    ctx.font = `500 ${size}px ui-monospace, monospace`;
    ctx.letterSpacing = `${(size * 0.22).toFixed(2)}px`;
    ctx.fillStyle = rgba(palette.fg, 0.32);
    ctx.textBaseline = 'alphabetic';
    ctx.save();
    ctx.translate(left - size * 0.75, margin * 0.7);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'right';
    ctx.fillText(label, 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';
    ctx.letterSpacing = '0px';
  }
  ctx.restore();
};

/* -------------------------------- spectrum ------------------------------- */

/**
 * The song draws itself: a ring of bars around the centre, mirrored, with a
 * second row along the floor. Bars come straight from the precomputed
 * spectrum, so they are as accurate as the analysis.
 */
const paintSpectrum: Painter = (c) => {
  const { ctx, frame, palette, bands, audio, energy, time, motion } = c;
  const { width, height, unit } = frame;

  const gradient = ctx.createRadialGradient(
    width / 2, height / 2, unit * 0.1, width / 2, height / 2, unit * 0.85,
  );
  gradient.addColorStop(0, palette.bg[1]);
  gradient.addColorStop(1, palette.bg[2] || palette.bg[0]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const count = bands.length;
  // The ring has to clear the type block, not sit behind it. Everything from
  // here out is sized off a radius that starts outside the lyric measure.
  const radius = unit * (0.38 + audio.bass * 0.03);
  const maxBar = unit * (0.1 + energy * 0.14);
  const spin = time * motion * 0.05;

  // A pool of shadow inside the ring, so type never lands on a bar.
  const well = ctx.createRadialGradient(
    width / 2, height / 2, unit * 0.05, width / 2, height / 2, radius * 1.02,
  );
  well.addColorStop(0, rgba(palette.bg[2] || palette.bg[0], 0.92));
  well.addColorStop(0.72, rgba(palette.bg[0], 0.7));
  well.addColorStop(1, rgba(palette.bg[0], 0));
  ctx.fillStyle = well;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(spin);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';

  // Two mirrored halves so the ring reads as symmetrical rather than as a
  // spiral, which is what an unmirrored log spectrum looks like.
  for (const direction of [1, -1]) {
    for (let i = 0; i < count; i++) {
      const value = bands[i];
      const angle = direction * (i / count) * Math.PI - Math.PI / 2;
      const length = maxBar * (0.12 + value);
      const colour = mixHex(palette.accent, palette.accent2, i / count);
      ctx.strokeStyle = rgba(colour, 0.25 + value * 0.55);
      ctx.lineWidth = Math.max(1.5, (unit * 0.006) * (1 - (i / count) * 0.4));
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      ctx.lineTo(Math.cos(angle) * (radius + length), Math.sin(angle) * (radius + length));
      ctx.stroke();
    }
  }
  ctx.restore();

  // Floor bars, low opacity, so the frame has weight at the bottom.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const barWidth = width / count;
  for (let i = 0; i < count; i++) {
    const value = bands[i];
    const h = height * 0.16 * value * (0.4 + energy);
    ctx.fillStyle = rgba(mixHex(palette.accent2, palette.glow, i / count), 0.1 + value * 0.18);
    ctx.fillRect(i * barWidth, height - h, barWidth * 0.82, h);
  }
  ctx.restore();

  // A ring that pulses on the beat, sitting just inside the bars.
  const pulse = audio.beat * energy;
  if (pulse > 0.02) {
    ctx.save();
    ctx.strokeStyle = rgba(palette.glow, pulse * 0.35);
    ctx.lineWidth = unit * 0.004 * (1 + pulse * 2);
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, radius * (0.94 - pulse * 0.03), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
};

/* -------------------------------- registry -------------------------------- */

const PAINTERS: Record<string, Painter> = {
  aurora: paintAurora,
  kinetic: paintKinetic,
  filmstrip: paintFilmstrip,
  neon: paintNeon,
  editorial: paintEditorial,
  spectrum: paintSpectrum,
};

export function paintBackground(c: PaintContext): void {
  // `strip` deliberately throws the background away and leaves flat colour —
  // it is the one treatment that overrides the template entirely, which is
  // exactly why a bridge set to `strip` reads as a change.
  if (c.treatment === 'strip') {
    const flat = mixHex(c.palette.bg[0], c.palette.bg[1], 0.35 + c.audio.level * 0.15);
    c.ctx.fillStyle = flat;
    c.ctx.fillRect(0, 0, c.frame.width, c.frame.height);
    return;
  }

  const painter = PAINTERS[c.plan.template] || paintAurora;
  painter(c);

  if (c.treatment === 'bloom') {
    // Lift the whole frame towards the glow colour and soften it by drawing a
    // scaled copy of the low buffer over the top.
    const { ctx, frame, palette } = c;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.16 + c.energy * 0.12;
    ctx.drawImage(
      c.low.canvas, 0, 0, c.low.canvas.width, c.low.canvas.height,
      -frame.width * 0.04, -frame.height * 0.04, frame.width * 1.08, frame.height * 1.08,
    );
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = palette.glow;
    ctx.fillRect(0, 0, frame.width, frame.height);
    ctx.restore();
  }

  if (c.treatment === 'flicker') {
    // Hold an inverted frame for a beat every few bars. Deterministic, so it
    // lands in the same place every time you watch it.
    const roll = hash01(c.bar.index, 3);
    if (roll > 0.72 && c.bar.age < c.bar.length * 0.25) {
      const { ctx, frame, palette } = c;
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = rgba(palette.accent, 0.5 + c.energy * 0.4);
      ctx.fillRect(0, 0, frame.width, frame.height);
      ctx.restore();
    }
  }
}

/* --------------------------------- post ---------------------------------- */

export function paintVignette(ctx: CanvasRenderingContext2D, frame: Frame, strength: number): void {
  if (strength <= 0.01) return;
  const { width, height } = frame;
  const gradient = ctx.createRadialGradient(
    width / 2, height / 2, Math.min(width, height) * 0.25,
    width / 2, height / 2, Math.max(width, height) * 0.75,
  );
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, `rgba(0,0,0,${clamp(strength * 0.85).toFixed(3)})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

/**
 * Film grain, as a pre-rendered tile shuffled per frame.
 *
 * Generating noise per pixel per frame would cost more than everything else
 * in the renderer combined. One 256px tile, drawn at a per-frame offset and
 * rotation, is indistinguishable in motion.
 */
export function makeGrainTile(size = 256): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    // Deterministic so the tile is identical between preview and export.
    const v = Math.round(hash01(i, 1234) * 255);
    image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function paintGrain(
  ctx: CanvasRenderingContext2D, frame: Frame, tile: CanvasImageSource,
  strength: number, seed: number,
): void {
  if (strength <= 0.005) return;
  const size = 256;
  ctx.save();
  ctx.globalAlpha = clamp(strength * 0.5);
  ctx.globalCompositeOperation = 'overlay';
  const offsetX = -Math.floor(hash01(seed, 1) * size);
  const offsetY = -Math.floor(hash01(seed, 2) * size);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (pattern) {
    ctx.translate(offsetX, offsetY);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, frame.width + size, frame.height + size);
  }
  ctx.restore();
}

/** Darken behind the type so lyrics stay readable over anything. */
export function paintScrim(
  ctx: CanvasRenderingContext2D, frame: Frame, strength: number, focusY: number,
): void {
  if (strength <= 0.01) return;
  const { width, height } = frame;
  const gradient = ctx.createLinearGradient(0, focusY - height * 0.42, 0, focusY + height * 0.42);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(0.5, `rgba(0,0,0,${clamp(strength).toFixed(3)})`);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

export function paintLetterbox(ctx: CanvasRenderingContext2D, frame: Frame, ratio: number): void {
  if (ratio <= 0.001) return;
  const bar = Math.round(frame.height * ratio);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, frame.width, bar);
  ctx.fillRect(0, frame.height - bar, frame.width, bar);
}

export { smoothstep, lerp, clamp };
