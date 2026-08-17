/**
 * The watermark.
 *
 * A lyric video gets watched by people who did not make it, and the only
 * thing carrying the name back to us is what is burned into the frame. So it
 * has to survive: re-encoding, a phone screen, and someone's 480p re-upload.
 * That argues for reasonable size and real contrast.
 *
 * It also has to not ruin the video, or people will find a way around it and
 * we will have traded goodwill for nothing. So it sits in a corner, out of
 * the type's way, at an opacity that reads as a credit rather than a claim,
 * and it holds still — the eye stops noticing a thing that never moves.
 *
 * It is drawn last, after grain and the closing fade, so nothing lies on top
 * of it and the final frames still carry it.
 *
 * On tamper-resistance: encoding happens in the visitor's browser, so a
 * determined person can edit the JavaScript and remove this. That is inherent
 * to not paying for server-side rendering, and it is a deterrent rather than
 * a lock. Making it real would mean rendering on the server, which on the
 * current box is 30-45 minutes per song.
 */

import type { Plan } from '../types';
import { clamp, rgba, type Frame } from './util';

export type WatermarkPosition =
  | 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'bottom-centre';

export interface WatermarkSpec {
  enabled: boolean;
  text: string;
  position: WatermarkPosition;
  opacity: number;
}

/**
 * Corners in frame units. Portrait video gets pushed further up from the
 * bottom, because that is where every platform stacks its own chrome —
 * captions, handles, the progress bar.
 */
function anchorFor(position: WatermarkPosition, frame: Frame) {
  const padX = frame.unit * 0.038;
  const padY = frame.unit * (frame.portrait ? 0.075 : 0.045);

  switch (position) {
    case 'bottom-left':
      return { x: padX, y: frame.height - padY, align: 'left' as const };
    case 'top-right':
      return { x: frame.width - padX, y: padY + frame.unit * 0.02, align: 'right' as const };
    case 'top-left':
      return { x: padX, y: padY + frame.unit * 0.02, align: 'left' as const };
    case 'bottom-centre':
      return { x: frame.width / 2, y: frame.height - padY, align: 'center' as const };
    default:
      return { x: frame.width - padX, y: frame.height - padY, align: 'right' as const };
  }
}

export function paintWatermark(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  plan: Plan,
  spec: WatermarkSpec,
  /** 0..1 — the closing fade, so the mark dims with the picture. */
  fade = 1,
): void {
  if (!spec.enabled || !spec.text) return;

  const alpha = clamp(spec.opacity) * clamp(fade);
  if (alpha <= 0.01) return;

  const size = frame.unit * 0.0235;
  const { x, y, align } = anchorFor(spec.position, frame);

  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  // Its own face and tracking, deliberately unrelated to the song's
  // typography: this is a credit, not part of the design, and it should read
  // that way whichever template is running.
  ctx.font = `500 ${size}px "Space Grotesk", system-ui, sans-serif`;
  ctx.letterSpacing = `${(size * 0.09).toFixed(2)}px`;

  // A shadow rather than a plate. A plate is a box someone has to look at;
  // a shadow just makes the letters work on a light frame and disappears on
  // a dark one.
  ctx.shadowColor = `rgba(0,0,0,${(0.55 * alpha).toFixed(3)})`;
  ctx.shadowBlur = size * 0.7;
  ctx.shadowOffsetY = size * 0.06;

  ctx.fillStyle = rgba(plan.palette.fg, alpha);
  ctx.fillText(spec.text, x, y);

  // A short rule in the accent colour, tying the mark to this video's palette
  // without colouring the words themselves, which would hurt legibility.
  const width = ctx.measureText(spec.text).width;
  const ruleY = y + size * 0.42;
  const ruleX = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = rgba(plan.palette.accent, alpha * 0.85);
  ctx.fillRect(ruleX, ruleY, width, Math.max(1, frame.unit * 0.0018));

  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';
  ctx.restore();
}
