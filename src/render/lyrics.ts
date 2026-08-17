/**
 * Type setting and the lyric presentation modes.
 *
 * The hard part here is not the animation, it is the fitting. Lyric lines
 * vary from two words to twenty, the frame might be portrait, and the type
 * has to stay large enough to read on a phone without ever overflowing or
 * colliding with the line below. So every line is measured and fitted once,
 * cached, and then animated.
 */

import type { AlignedLine, AlignedWord, Plan } from '../types';
import { clamp, easeOutCubic, easeOutExpo, lerp, rgba, smoothstep, type Frame } from './util';
import type { ResolvedPalette } from './backgrounds';

export interface LaidOutWord {
  index: number;      // index into alignment.words
  text: string;
  x: number;          // relative to the line's left edge
  y: number;          // baseline offset from the block's top
  width: number;
  row: number;
  start: number;
  end: number;
}

export interface LineLayout {
  line: number;
  words: LaidOutWord[];
  fontSize: number;
  rowHeight: number;
  rows: number;
  width: number;      // widest row
  height: number;
  rowWidths: number[];
}

export interface TypeStyle {
  family: string;
  weight: number;
  case: Plan['typography']['case'];
  tracking: number;
  align: Plan['typography']['align'];
}

const SPACE_RATIO = 0.28; // width of a space as a fraction of font size, before measuring

export function applyCase(text: string, mode: Plan['typography']['case']): string {
  if (mode === 'upper') return text.toLocaleUpperCase();
  if (mode === 'sentence') return text;
  return text;
}

function setFont(ctx: CanvasRenderingContext2D, style: TypeStyle, size: number): void {
  ctx.font = `${style.weight} ${size}px ${style.family}`;
  ctx.letterSpacing = `${(style.tracking * size).toFixed(2)}px`;
  ctx.textBaseline = 'alphabetic';
}

/**
 * Fit one lyric line into a box.
 *
 * Tries the requested size, wraps to as many rows as needed, and shrinks
 * until it fits both the width and the row budget. Shrinking rather than
 * clipping because a truncated lyric is worse than a small one.
 */
export function layoutLine(
  ctx: CanvasRenderingContext2D,
  line: AlignedLine,
  words: AlignedWord[],
  style: TypeStyle,
  maxWidth: number,
  maxRows: number,
  requestedSize: number,
): LineLayout {
  const tokens = line.words.map((wi) => words[wi]).filter(Boolean);
  let size = requestedSize;

  for (let attempt = 0; attempt < 14; attempt++) {
    setFont(ctx, style, size);
    const spaceWidth = ctx.measureText(' ').width || size * SPACE_RATIO;

    const laid: LaidOutWord[] = [];
    const rowWidths: number[] = [];
    let row = 0;
    let x = 0;
    let widest = 0;
    let overflowed = false;

    for (const word of tokens) {
      const text = applyCase(word.t, style.case);
      const width = ctx.measureText(text).width;

      if (width > maxWidth) {
        // A single word wider than the frame: only a smaller size can fix it.
        overflowed = true;
        break;
      }
      if (x > 0 && x + spaceWidth + width > maxWidth) {
        rowWidths[row] = x;
        widest = Math.max(widest, x);
        row++;
        x = 0;
      }
      if (x > 0) x += spaceWidth;

      laid.push({
        index: word.i, text, x, y: 0, width, row,
        start: word.start, end: word.end,
      });
      x += width;
    }

    rowWidths[row] = x;
    widest = Math.max(widest, x);

    if (!overflowed && row + 1 <= maxRows) {
      const rowHeight = size * 1.18;
      for (const word of laid) word.y = word.row * rowHeight;
      return {
        line: line.i,
        words: laid,
        fontSize: size,
        rowHeight,
        rows: row + 1,
        width: widest,
        height: (row + 1) * rowHeight,
        rowWidths,
      };
    }

    size *= 0.88;
    if (size < requestedSize * 0.35) {
      // Give up shrinking and accept extra rows; unreadably small is worse
      // than tall, and the caller's box is a preference, not a hard wall.
      maxRows += 1;
      size = requestedSize * 0.5;
    }
  }

  setFont(ctx, style, size);
  return {
    line: line.i, words: [], fontSize: size, rowHeight: size * 1.18,
    rows: 1, width: 0, height: size * 1.18, rowWidths: [0],
  };
}

/** Layouts are expensive to compute and trivial to cache. */
export class LayoutCache {
  private cache = new Map<string, LineLayout>();
  private signature = '';

  invalidateIf(signature: string): void {
    if (signature !== this.signature) {
      this.signature = signature;
      this.cache.clear();
    }
  }

  get(
    key: number,
    compute: () => LineLayout,
  ): LineLayout {
    let hit = this.cache.get(String(key));
    if (!hit) {
      hit = compute();
      this.cache.set(String(key), hit);
    }
    return hit;
  }
}

/* ------------------------------- drawing --------------------------------- */

export interface WordPaint {
  fill: string;
  alpha: number;
  /** 0..1 — how much of the word is filled with `accent` from the left. */
  sweep: number;
  sweepColour: string;
  scale: number;
  glow: number;
  offsetY: number;
}

function drawWord(
  ctx: CanvasRenderingContext2D,
  word: LaidOutWord,
  originX: number,
  originY: number,
  paint: WordPaint,
  glowColour: string,
): void {
  if (paint.alpha <= 0.004) return;

  const x = originX + word.x;
  const y = originY + word.y + paint.offsetY;

  ctx.save();
  ctx.globalAlpha = clamp(paint.alpha);

  if (paint.scale !== 1) {
    // Scale about the word's own centre so a highlighted word grows in place
    // instead of shoving the rest of the line sideways.
    ctx.translate(x + word.width / 2, y);
    ctx.scale(paint.scale, paint.scale);
    ctx.translate(-(x + word.width / 2), -y);
  }

  if (paint.glow > 0.01) {
    ctx.shadowColor = rgba(glowColour, clamp(paint.glow));
    ctx.shadowBlur = word.width * 0.35 * paint.glow + 8;
  }

  ctx.fillStyle = paint.fill;
  ctx.fillText(word.text, x, y);

  if (paint.sweep > 0.001) {
    ctx.save();
    ctx.beginPath();
    // A hair of overdraw on the left stops a seam appearing between the
    // swept and unswept halves at fractional pixel positions.
    ctx.rect(x - 2, y - word.width * 2, word.width * paint.sweep + 2, word.width * 4);
    ctx.clip();
    ctx.fillStyle = paint.sweepColour;
    ctx.fillText(word.text, x, y);
    ctx.restore();
  }

  ctx.restore();
}

export interface LyricContext {
  ctx: CanvasRenderingContext2D;
  frame: Frame;
  plan: Plan;
  palette: ResolvedPalette;
  style: TypeStyle;
  time: number;
  /** Extra emphasis, 0..1, from the cue and the music. */
  energy: number;
  pulse: number;
}

/** Where the type block sits, per template. */
export function lyricAnchor(plan: Plan, frame: Frame): { x: number; y: number } {
  const centreX = plan.typography.align === 'left'
    ? frame.margin
    : plan.typography.align === 'right'
      ? frame.width - frame.margin
      : frame.width / 2;

  // Filmstrip keeps the lower third for type so photographs keep the frame;
  // everything else centres, biased slightly high because subtitles and
  // platform chrome eat the bottom of a phone screen.
  const y = plan.template === 'filmstrip'
    ? frame.height * 0.76
    : plan.template === 'editorial'
      ? frame.height * 0.52
      : frame.height * 0.5;

  return { x: centreX, y };
}

function rowOrigin(layout: LineLayout, row: number, anchorX: number, align: string): number {
  const rowWidth = layout.rowWidths[row] ?? layout.width;
  if (align === 'left') return anchorX;
  if (align === 'right') return anchorX - rowWidth;
  return anchorX - rowWidth / 2;
}

/** Draw one laid-out line with per-word paint decided by `paintFor`. */
function drawLine(
  c: LyricContext,
  layout: LineLayout,
  anchorX: number,
  topY: number,
  paintFor: (word: LaidOutWord) => WordPaint,
): void {
  const { ctx, plan, palette, style } = c;
  setFont(ctx, style, layout.fontSize);

  for (const word of layout.words) {
    const originX = rowOrigin(layout, word.row, anchorX, plan.typography.align);
    drawWord(ctx, word, originX, topY + layout.fontSize, paintFor(word), palette.glow);
  }
}

/* ------------------------------- the modes -------------------------------- */

export interface ActiveLine {
  layout: LineLayout;
  line: AlignedLine;
  /** −1 before it starts, 0..1 during, >1 after. */
  progress: number;
  /** Seconds since the line's first word started. */
  age: number;
  /** Seconds until it starts (positive) — used to fade lines in early. */
  lead: number;
}

const LEAD_IN = 0.55;   // how long before its first word a line appears
const LEAD_OUT = 0.75;  // how long after its last word a line lingers

/**
 * Karaoke: the whole line is present, the current word fills with the accent
 * colour as it is sung. The one mode that lets a singer read ahead.
 */
function paintKaraoke(c: LyricContext, active: ActiveLine): void {
  const { palette, time, plan } = c;
  const appear = smoothstep(-LEAD_IN, 0, -active.lead);
  const leave = 1 - smoothstep(0, LEAD_OUT, active.age - (active.line.end - active.line.start));
  const lineAlpha = clamp(Math.min(appear, leave));

  const anchor = lyricAnchor(plan, c.frame);
  drawLine(c, active.layout, anchor.x, anchor.y - active.layout.height / 2, (word) => {
    const sung = time >= word.end;
    const singing = time >= word.start && time < word.end;
    const sweep = singing ? clamp((time - word.start) / Math.max(0.05, word.end - word.start)) : 0;

    return {
      fill: sung ? palette.fg : rgba(palette.fg, 0.46),
      alpha: lineAlpha,
      sweep: singing ? sweep : 0,
      sweepColour: palette.accent,
      scale: plan.lyrics.highlight === 'scale' && singing ? 1 + 0.06 * c.energy : 1,
      glow: plan.lyrics.highlight === 'glow' && (singing || (sung && time - word.end < 0.25))
        ? 0.5 + c.energy * 0.5
        : 0,
      offsetY: 0,
    };
  });
}

/** Words arrive one at a time and the line clears when it ends. */
function paintWordPop(c: LyricContext, active: ActiveLine): void {
  const { palette, time, plan } = c;
  const leave = 1 - smoothstep(0, LEAD_OUT * 0.8, active.age - (active.line.end - active.line.start));
  const anchor = lyricAnchor(plan, c.frame);

  drawLine(c, active.layout, anchor.x, anchor.y - active.layout.height / 2, (word) => {
    const since = time - word.start;
    if (since < 0) return { fill: palette.fg, alpha: 0, sweep: 0, sweepColour: palette.accent, scale: 1, glow: 0, offsetY: 0 };

    const entry = easeOutExpo(clamp(since / 0.22));
    const singing = time < word.end;
    return {
      fill: singing ? palette.accent : palette.fg,
      alpha: clamp(entry * leave),
      sweep: 0,
      sweepColour: palette.accent,
      scale: lerp(1.25, 1, entry) * (singing ? 1 + 0.04 * c.energy : 1),
      glow: singing ? 0.35 + c.energy * 0.5 : 0,
      offsetY: (1 - entry) * active.layout.fontSize * 0.22,
    };
  });
}

/** The whole line fades in and out as a unit. Calm, cinematic. */
function paintLineFade(c: LyricContext, active: ActiveLine): void {
  const { palette, time, plan } = c;
  const appear = easeOutCubic(smoothstep(-LEAD_IN, 0.12, -active.lead));
  const leave = 1 - smoothstep(0, LEAD_OUT, active.age - (active.line.end - active.line.start));
  const alpha = clamp(Math.min(appear, leave));

  const anchor = lyricAnchor(plan, c.frame);
  const rise = (1 - appear) * active.layout.fontSize * 0.3;

  drawLine(c, active.layout, anchor.x, anchor.y - active.layout.height / 2 + rise, (word) => {
    const singing = time >= word.start && time < word.end;
    return {
      fill: palette.fg,
      alpha,
      sweep: 0,
      sweepColour: palette.accent,
      scale: 1,
      // Even in the calmest mode the current word gets a whisper of emphasis,
      // otherwise there is nothing tying the type to the vocal at all.
      glow: singing ? 0.25 + c.energy * 0.35 : 0,
      offsetY: 0,
    };
  });
}

/** A scrolling column: the current line bright and centred, neighbours dim. */
function paintCascade(
  c: LyricContext,
  actives: ActiveLine[],
  currentIndex: number,
): void {
  const { palette, plan, frame, time } = c;
  const anchor = lyricAnchor(plan, frame);
  const visible = plan.lyrics.linesVisible;

  for (const active of actives) {
    const offset = active.line.i - currentIndex;
    if (Math.abs(offset) > visible) continue;

    // Smooth scrolling: interpolate towards the next line's slot as its first
    // word approaches, so the column glides rather than jumping.
    const glide = active.lead < 0 ? 0 : smoothstep(LEAD_IN, 0, active.lead);
    const slot = offset - glide * 0;
    const spacing = active.layout.rowHeight * 1.45;
    const y = anchor.y + slot * spacing - active.layout.height / 2;

    const distance = Math.abs(slot);
    // Floor the fade rather than letting it reach zero: a line at 5% opacity
    // reads as a rendering fault, not as a design decision.
    const dim = distance < 0.5 ? 1 : Math.max(0.3, 1 - (distance - 0.5) * 0.42);

    drawLine(c, active.layout, anchor.x, y, (word) => {
      const isCurrent = distance < 0.5;
      const sung = time >= word.end;
      const singing = time >= word.start && time < word.end;
      return {
        // Neighbours are the foreground colour held back by opacity, not the
        // `dim` colour — a dark dim colour disappears entirely on a dark
        // background, which is exactly where these templates live.
        fill: isCurrent ? (sung ? palette.fg : rgba(palette.fg, 0.5)) : rgba(palette.fg, 0.55),
        alpha: dim,
        sweep: isCurrent && singing
          ? clamp((time - word.start) / Math.max(0.05, word.end - word.start))
          : 0,
        sweepColour: palette.accent,
        scale: 1,
        glow: isCurrent && singing ? 0.3 * c.energy : 0,
        offsetY: 0,
      };
    });
  }
}

/** One word, very large. For sparse lyrics with space around them. */
function paintHero(c: LyricContext, active: ActiveLine): void {
  const { ctx, palette, time, plan, frame } = c;
  const current = active.layout.words.find((w) => time >= w.start && time < w.end)
    ?? active.layout.words.filter((w) => time >= w.start).pop();
  if (!current) return;

  const since = time - current.start;
  const span = Math.max(0.12, current.end - current.start);
  const entry = easeOutExpo(clamp(since / 0.18));
  const exit = 1 - smoothstep(span, span + 0.35, since);
  const alpha = clamp(entry * exit);
  if (alpha <= 0.01) return;

  const anchor = lyricAnchor(plan, frame);
  // Hero type is fitted independently of the line: it gets the whole frame.
  const size = active.layout.fontSize * 2.4;
  setFont(ctx, c.style, size);
  const width = ctx.measureText(current.text).width;
  const fitted = width > frame.width - frame.margin * 2
    ? size * ((frame.width - frame.margin * 2) / width)
    : size;
  setFont(ctx, c.style, fitted);

  const scale = lerp(1.18, 1, entry) * (1 + c.pulse * 0.05);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(anchor.x, anchor.y + fitted * 0.34);
  ctx.scale(scale, scale);
  if (c.energy > 0.4) {
    ctx.shadowColor = rgba(palette.glow, 0.5 * c.energy);
    ctx.shadowBlur = fitted * 0.2;
  }
  ctx.fillStyle = palette.fg;
  ctx.textAlign = 'center';
  ctx.fillText(current.text, 0, 0);
  ctx.textAlign = 'left';
  ctx.restore();
}

export function paintLyrics(
  c: LyricContext,
  actives: ActiveLine[],
  currentIndex: number,
): void {
  const mode = c.plan.lyrics.mode;

  if (mode === 'cascade') {
    paintCascade(c, actives, currentIndex);
    return;
  }

  for (const active of actives) {
    switch (mode) {
      case 'karaoke': paintKaraoke(c, active); break;
      case 'wordPop': paintWordPop(c, active); break;
      case 'hero': paintHero(c, active); break;
      default: paintLineFade(c, active); break;
    }
  }
}

/* ------------------------------- title card ------------------------------- */

export function paintTitle(
  c: LyricContext,
  progress: number,   // 0..1 across the card's life
): void {
  const { ctx, frame, palette, plan, style } = c;
  const { title, artist } = plan.title;
  if (!title && !artist) return;

  // In, hold, out.
  const alpha = clamp(Math.min(smoothstep(0, 0.18, progress), 1 - smoothstep(0.82, 1, progress)));
  if (alpha <= 0.01) return;

  const entry = easeOutCubic(smoothstep(0, 0.22, progress));
  const exit = smoothstep(0.8, 1, progress);

  const titleSize = frame.unit * 0.11 * plan.typography.scale;
  const artistSize = titleSize * 0.36;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';

  const centreY = frame.height * 0.48;
  const slide = plan.title.style === 'slide' ? (1 - entry) * frame.unit * 0.06 : 0;
  const stamp = plan.title.style === 'stamp' ? lerp(1.14, 1, entry) : 1;

  ctx.translate(frame.width / 2, centreY - slide - exit * frame.unit * 0.03);
  ctx.scale(stamp, stamp);

  if (title) {
    setFont(ctx, style, titleSize);
    ctx.shadowColor = rgba(palette.glow, 0.4);
    ctx.shadowBlur = titleSize * 0.3;
    ctx.fillStyle = palette.fg;
    ctx.fillText(applyCase(title, style.case), 0, 0);
    ctx.shadowBlur = 0;
  }

  if (artist) {
    setFont(ctx, { ...style, tracking: Math.max(style.tracking, 0.14) }, artistSize);
    ctx.fillStyle = rgba(palette.accent, 0.9);
    ctx.fillText(artist.toLocaleUpperCase(), 0, titleSize * 0.85);
  }

  // A rule that draws itself in under the title.
  const ruleWidth = frame.unit * 0.16 * entry;
  if (ruleWidth > 1) {
    ctx.fillStyle = rgba(palette.accent, 0.55);
    ctx.fillRect(-ruleWidth / 2, titleSize * (artist ? 1.25 : 0.5), ruleWidth, Math.max(1, frame.unit * 0.0022));
  }

  ctx.textAlign = 'left';
  ctx.restore();
}
