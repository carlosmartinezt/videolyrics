/**
 * The renderer.
 *
 * One method matters: `render(time)`. It is a pure function of the scene and
 * the timestamp — no accumulated state, no frame counter, no randomness. The
 * live preview calls it from requestAnimationFrame with the audio element's
 * currentTime; the encoder calls it in a tight loop with n/fps. Both get
 * identical pixels, which is why what you preview is what you download.
 */

import type { Alignment, AlignedLine, Plan, Segment } from '../types';
import type { AudioTrack, FrameAudio } from '../audio/track';
import {
  paintBackground, paintGrain, paintLetterbox, paintScrim, paintVignette,
  makeGrainTile, type PaintContext, type ResolvedPalette,
} from './backgrounds';
import {
  LayoutCache, layoutLine, lyricAnchor, paintLyrics, paintTitle,
  type ActiveLine, type LineLayout, type TypeStyle,
} from './lyrics';
import {
  clamp, easeOutExpo, frameGeometry, hash01, lerp, rgba, shiftHue, smoothstep, type Frame,
} from './util';
import { paintWatermark } from './watermark';

export interface Scene {
  plan: Plan;
  alignment: Alignment;
  audio: AudioTrack;
  photos: ImageBitmap[];
  /** Font stack for plan.typography.font, resolved by the caller. */
  fontStack: string;
  /** x-height correction for that face; see FONTS in shared/templates.mjs. */
  fontOptical?: number;
}

const LEAD_IN = 0.55;
const LEAD_OUT = 0.75;
const FADE_OUT_SECONDS = 1.1;

/** Low-res background buffer, as a fraction of the output's short edge. */
const LOW_RES_DIVISOR = 6;

export class Renderer {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D;
  private low: CanvasRenderingContext2D;
  private grain: CanvasImageSource;
  private frame: Frame;
  private scene: Scene | null = null;
  private layouts = new LayoutCache();

  /** Cumulative bar length, so the "which bar are we in" lookup is O(log n). */
  private downbeats: number[] = [];
  private onsets: number[] = [];
  private segmentStarts: number[] = [];

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number) {
    this.canvas = canvas;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null;
    if (!ctx) throw new Error('Could not get a 2D context for the video canvas.');
    this.ctx = ctx;
    this.frame = frameGeometry(width, height);

    const lowW = Math.max(32, Math.round(width / LOW_RES_DIVISOR));
    const lowH = Math.max(32, Math.round(height / LOW_RES_DIVISOR));
    const lowCanvas = document.createElement('canvas');
    lowCanvas.width = lowW;
    lowCanvas.height = lowH;
    this.low = lowCanvas.getContext('2d', { alpha: true })!;

    this.grain = makeGrainTile();
  }

  get width(): number { return this.frame.width; }
  get height(): number { return this.frame.height; }

  setScene(scene: Scene): void {
    this.scene = scene;
    this.downbeats = scene.alignment.audio.downbeats?.length
      ? scene.alignment.audio.downbeats
      : scene.alignment.audio.beats || [];
    this.onsets = scene.alignment.audio.onsets || [];
    this.segmentStarts = scene.alignment.segments.map((s) => s.start);

    // Any of these changing invalidates every cached line layout.
    const p = scene.plan;
    this.layouts.invalidateIf([
      p.template, p.typography.font, p.typography.weight, p.typography.case,
      p.typography.tracking, p.typography.scale, p.lyrics.mode, p.lyrics.linesVisible,
      this.frame.width, this.frame.height, scene.fontStack, scene.fontOptical ?? 1,
    ].join('|'));
  }

  /* ------------------------------ lookups ------------------------------- */

  private segmentAt(time: number): { segment: Segment; index: number; progress: number } {
    const segments = this.scene!.alignment.segments;
    if (!segments.length) {
      const fallback: Segment = {
        index: 0, kind: 'verse', label: 'Verse', start: 0,
        end: this.scene!.alignment.duration, lines: [], energy: 0.5,
        brightness: 0.5, repeat_of: null,
      };
      return { segment: fallback, index: 0, progress: 0 };
    }
    let lo = 0;
    let hi = this.segmentStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segmentStarts[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    const segment = segments[lo];
    const span = Math.max(0.001, segment.end - segment.start);
    return { segment, index: lo, progress: clamp((time - segment.start) / span) };
  }

  private barAt(time: number): { index: number; age: number; length: number } {
    const beats = this.downbeats;
    const tempoBar = (60 / Math.max(50, this.scene!.alignment.audio.tempo || 100)) * 4;
    if (!beats.length) {
      return { index: Math.floor(time / tempoBar), age: time % tempoBar, length: tempoBar };
    }
    let lo = 0;
    let hi = beats.length - 1;
    if (time < beats[0]) return { index: -1, age: beats[0] - time, length: tempoBar };
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (beats[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    const next = beats[lo + 1] ?? beats[lo] + tempoBar;
    return { index: lo, age: time - beats[lo], length: Math.max(0.15, next - beats[lo]) };
  }

  private onsetsNear(time: number, lookback = 1.3): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    // Linear scan bounded by lookback; onsets are sorted, so walk back from
    // the insertion point rather than filtering the whole array each frame.
    let lo = 0;
    let hi = this.onsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.onsets[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    for (let i = lo; i >= 0 && out.length < 24; i--) {
      const t = this.onsets[i];
      if (t > time) continue;
      if (time - t > lookback) break;
      out.push([t, i]);
    }
    return out;
  }

  private activeLines(time: number): { actives: ActiveLine[]; currentIndex: number } {
    const { alignment, plan } = this.scene!;
    const lines = alignment.lines;
    const actives: ActiveLine[] = [];

    let currentIndex = -1;
    for (const line of lines) {
      if (line.start <= time) currentIndex = line.i;
      else break;
    }
    // Once a line is well past, the next one is "current" for layout purposes.
    if (currentIndex >= 0 && lines[currentIndex] && time > lines[currentIndex].end + LEAD_OUT) {
      const next = lines[currentIndex + 1];
      if (next && next.start - time < LEAD_IN * 2) currentIndex = next.i;
    }

    const window = plan.lyrics.mode === 'cascade' ? plan.lyrics.linesVisible + 1 : 1;
    const from = Math.max(0, currentIndex - window);
    const to = Math.min(lines.length - 1, Math.max(0, currentIndex) + window);

    for (let i = from; i <= to; i++) {
      const line = lines[i];
      if (!line) continue;
      const visibleFrom = line.start - LEAD_IN;
      const visibleTo = line.end + LEAD_OUT;
      const inCascade = plan.lyrics.mode === 'cascade';
      if (!inCascade && (time < visibleFrom || time > visibleTo)) continue;

      actives.push({
        layout: this.layoutFor(line),
        line,
        progress: clamp((time - line.start) / Math.max(0.05, line.end - line.start)),
        age: time - line.start,
        lead: line.start - time,
      });
    }

    return { actives, currentIndex: Math.max(0, currentIndex) };
  }

  private typeStyle(): TypeStyle {
    const { plan, fontStack } = this.scene!;
    return {
      family: fontStack,
      weight: plan.typography.weight,
      case: plan.typography.case,
      tracking: plan.typography.tracking,
      align: plan.typography.align,
    };
  }

  private layoutFor(line: AlignedLine): LineLayout {
    const { plan, alignment } = this.scene!;
    return this.layouts.get(line.i, () => {
      const style = this.typeStyle();
      const mode = plan.lyrics.mode;

      // Each mode wants a different starting size; fitting shrinks from there.
      // These are fractions of the short edge, and they are deliberately large:
      // a lyric video is watched on a phone in a feed, and the first draft of
      // these numbers produced type that was tasteful at desk distance and
      // unreadable at arm's length.
      const base = mode === 'hero' ? 0.17
        : mode === 'wordPop' ? 0.125
          : mode === 'cascade' ? 0.076
            : this.frame.portrait ? 0.09 : 0.096;

      const requested = this.frame.unit * base * plan.typography.scale
        * (this.scene!.fontOptical ?? 1);
      const maxWidth = this.frame.width - this.frame.margin * 2;
      const maxRows = mode === 'cascade' ? 2 : this.frame.portrait ? 4 : 3;

      return layoutLine(this.ctx, line, alignment.words, style, maxWidth, maxRows, requested);
    });
  }

  /* ------------------------------ photos -------------------------------- */

  private photoSlot(time: number, segmentIndex: number, lineIndex: number, bar: { index: number }) {
    const { plan, alignment } = this.scene!;
    switch (plan.photos.changeOn) {
      case 'line':
        return { slot: lineIndex, since: time - (alignment.lines[lineIndex]?.start ?? 0) };
      case 'downbeat': {
        // Every fourth bar; every bar would be a strobe of photographs.
        const group = Math.floor(Math.max(0, bar.index) / 4);
        const startBar = group * 4;
        const startTime = this.downbeats[startBar] ?? 0;
        return { slot: group, since: time - startTime };
      }
      case 'slow': {
        const period = 9;
        return { slot: Math.floor(time / period), since: time % period };
      }
      default: {
        const seg = alignment.segments[segmentIndex];
        return { slot: segmentIndex, since: time - (seg?.start ?? 0) };
      }
    }
  }

  private drawPhotos(c: PaintContext, slot: number, since: number, lineIndex: number): void {
    const { photos, plan } = this.scene!;
    if (!photos.length || !plan.photos.enabled) return;

    const { ctx, frame, palette } = c;
    const treatment = plan.photos.treatment;
    const opacity = plan.photos.opacity;

    const drawOne = (image: ImageBitmap, alpha: number, progress: number, seed: number) => {
      if (alpha <= 0.01) return;
      // Cover-fit, then Ken Burns on top of that.
      const scaleToCover = Math.max(frame.width / image.width, frame.height / image.height);
      const zoom = treatment === 'kenburns'
        ? lerp(1.04, 1.18, (progress + hash01(seed, 3) * 0.3) % 1)
        : 1.02;
      const angle = hash01(seed, 5) * Math.PI * 2;
      const travel = treatment === 'kenburns' ? frame.unit * 0.05 * progress : 0;
      const w = image.width * scaleToCover * zoom;
      const h = image.height * scaleToCover * zoom;
      const x = (frame.width - w) / 2 + Math.cos(angle) * travel;
      const y = (frame.height - h) / 2 + Math.sin(angle) * travel;

      ctx.save();
      ctx.globalAlpha = clamp(alpha * opacity);
      if (treatment === 'ghost') ctx.globalCompositeOperation = 'lighter';
      if (treatment === 'blend') ctx.globalCompositeOperation = 'overlay';

      if (treatment === 'plate') {
        // An inset card rather than a full bleed.
        const pw = frame.width * 0.62;
        const ph = pw * (image.height / image.width);
        const px = (frame.width - pw) / 2;
        const py = frame.height * 0.3 - ph / 2;
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = frame.unit * 0.04;
        ctx.drawImage(image, px, py, pw, ph);
      } else {
        ctx.drawImage(image, x, y, w, h);
      }
      ctx.restore();

      // Tint towards the palette so photographs from different cameras,
      // different days and different light still read as one film.
      if (plan.photos.tint > 0.01) {
        ctx.save();
        ctx.globalAlpha = clamp(plan.photos.tint * alpha * 0.8);
        ctx.globalCompositeOperation = 'color';
        ctx.fillStyle = palette.accent;
        ctx.fillRect(0, 0, frame.width, frame.height);
        ctx.restore();
      }
    };

    if (treatment === 'flash') {
      // Only on hits, and only briefly.
      const flashIndex = Math.abs(lineIndex) % photos.length;
      const strength = c.audio.hit * c.energy;
      drawOne(photos[flashIndex], strength * 0.9, 0.5, flashIndex);
      return;
    }

    const index = ((slot % photos.length) + photos.length) % photos.length;
    const previous = ((index - 1 + photos.length) % photos.length);
    const crossfade = clamp(since / 0.9);
    const progress = clamp(since / 8);

    if (crossfade < 0.999 && photos.length > 1) {
      drawOne(photos[previous], 1 - crossfade, 1, previous);
    }
    drawOne(photos[index], crossfade, progress, index);
  }

  /* ------------------------------- render -------------------------------- */

  render(time: number): void {
    const scene = this.scene;
    const { ctx, frame } = this;
    if (!scene) {
      ctx.fillStyle = '#08080a';
      ctx.fillRect(0, 0, frame.width, frame.height);
      return;
    }

    const { plan, alignment, audio } = scene;
    const t = clamp(time, 0, alignment.duration);

    const { segment, index: segmentIndex, progress: segmentProgress } = this.segmentAt(t);
    const cue = plan.cues[segmentIndex] ?? {
      segment: segmentIndex, treatment: 'drift', intensity: 0.5,
      lyricMode: null, accentShift: 0, note: '',
    };
    const frameAudio: FrameAudio = audio.at(t);
    const bands = audio.bandsAt(t);
    const bar = this.barAt(t);

    // Treatment shapes how the cue's intensity is spent across the section.
    let energy = cue.intensity;
    if (cue.treatment === 'build') energy = lerp(cue.intensity * 0.3, cue.intensity, segmentProgress);
    else if (cue.treatment === 'still') energy *= 0.45;
    else if (cue.treatment === 'surge') energy = Math.min(1, energy * 1.12);
    else if (cue.treatment === 'bloom') energy *= 0.7;
    energy = clamp(energy * (0.82 + frameAudio.level * 0.3));

    const motion = clamp(plan.background.motion *
      (cue.treatment === 'still' ? 0.2 : cue.treatment === 'surge' ? 1.25 : 1));

    const palette: ResolvedPalette = {
      bg: plan.palette.bg,
      fg: plan.palette.fg,
      dim: plan.palette.dim,
      accent: shiftHue(plan.palette.accent, cue.accentShift),
      accent2: shiftHue(plan.palette.accent2, cue.accentShift * 0.6),
      glow: shiftHue(plan.palette.glow, cue.accentShift),
    };

    const paintContext: PaintContext = {
      ctx, low: this.low, frame, plan, palette, time: t,
      audio: frameAudio, bands, segment, segmentProgress,
      treatment: cue.treatment, energy, motion,
      recentOnsets: this.onsetsNear(t), bar,
    };

    const { actives, currentIndex } = this.activeLines(t);

    // Whole-frame movement: a gentle zoom on the beat and a kick on hard hits.
    const pulse = frameAudio.beat * plan.reactivity.pulse * energy;
    const shake = frameAudio.hit * plan.reactivity.shake * energy;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = plan.palette.bg[0];
    ctx.fillRect(0, 0, frame.width, frame.height);

    if (pulse > 0.001 || shake > 0.001) {
      const scale = 1 + pulse * 0.014;
      const angle = hash01(Math.floor(t * 20)) * Math.PI * 2;
      ctx.translate(
        frame.width / 2 + Math.cos(angle) * shake * frame.unit * 0.012,
        frame.height / 2 + Math.sin(angle) * shake * frame.unit * 0.012,
      );
      ctx.scale(scale, scale);
      ctx.translate(-frame.width / 2, -frame.height / 2);
    }

    paintBackground(paintContext);

    if (plan.photos.enabled && scene.photos.length) {
      const { slot, since } = this.photoSlot(t, segmentIndex, currentIndex, bar);
      this.drawPhotos(paintContext, slot, since, currentIndex);
    }

    const anchor = lyricAnchor(plan, frame);
    if (actives.length) {
      paintScrim(ctx, frame, plan.background.scrim * (plan.photos.enabled ? 1 : 0.7), anchor.y);
    }

    const lyricContext = {
      ctx, frame, plan, palette, style: this.typeStyle(), time: t,
      energy, pulse: frameAudio.beat * energy,
    };

    // The title card owns the frame while it is up; lyrics start after it.
    const titleEnd = plan.title.holdUntil;
    if (plan.title.show && t < titleEnd + 0.4 && titleEnd > 0.6) {
      paintTitle(lyricContext, clamp(t / Math.max(0.8, titleEnd)));
    }
    if (actives.length) {
      paintLyrics(lyricContext, actives, currentIndex);
    }

    ctx.restore();

    /* post ---------------------------------------------------------------- */

    if (plan.template === 'filmstrip') {
      paintLetterbox(ctx, frame, 0.055);
    }

    paintVignette(ctx, frame, plan.background.vignette);

    const flash = frameAudio.downbeat * plan.reactivity.flash * energy;
    if (flash > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = rgba(palette.glow, easeOutExpo(flash) * 0.13);
      ctx.fillRect(0, 0, frame.width, frame.height);
      ctx.restore();
    }

    paintGrain(ctx, frame, this.grain, plan.background.grain, Math.floor(t * plan.fps));

    // Fade to black over the last beat or so, so the file ends rather than
    // stops. Cheap, and the difference between "a video" and "a screen capture".
    const remaining = alignment.duration - t;
    const fade = remaining < FADE_OUT_SECONDS
      ? smoothstep(0, FADE_OUT_SECONDS, remaining)
      : 1;
    if (fade < 1) {
      ctx.fillStyle = `rgba(0,0,0,${(1 - fade).toFixed(3)})`;
      ctx.fillRect(0, 0, frame.width, frame.height);
    }

    // Last of everything, so grain does not sit on top of it and the closing
    // frames still carry the mark. It dims with the fade rather than hanging
    // over black.
    if (plan.watermark) {
      paintWatermark(ctx, frame, plan, plan.watermark, fade);
    }
  }
}
