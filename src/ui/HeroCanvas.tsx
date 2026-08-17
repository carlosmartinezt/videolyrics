/**
 * The landing page hero: the real renderer, running.
 *
 * Not a video file and not a screenshot — the same Renderer class that
 * produces the download, drawing a short phrase on a twelve second loop. It
 * is the most honest possible claim about what the tool does, and it costs
 * one canvas.
 */

import { useEffect, useRef } from 'react';

import { Renderer } from '../render/engine';
import { demoAlignment, demoPlan, demoTrack } from '../lib/demo';
import { ensureFont, fontOpticalFor, fontStackFor } from '../lib/fonts';
import type { FontInfo } from '../types';

const WIDTH = 1280;
const HEIGHT = 720;

export function HeroCanvas({ fonts, label }: { fonts: FontInfo[]; label?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: Renderer;
    try {
      renderer = new Renderer(canvas, WIDTH, HEIGHT);
    } catch {
      return; // No 2D context — the page still works, it just has no hero.
    }

    const plan = demoPlan();
    const alignment = demoAlignment();
    const track = demoTrack(60);

    let raf = 0;
    let cancelled = false;
    const started = performance.now();

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const tick = () => {
      if (cancelled) return;
      // Hidden tabs get no frames; rAF already throttles, but bailing keeps
      // the loop from doing layout work behind a background tab.
      if (!document.hidden) {
        const elapsed = (performance.now() - started) / 1000;
        renderer.render(elapsed % alignment.duration);
      }
      raf = requestAnimationFrame(tick);
    };

    const start = async () => {
      await ensureFont(fontStackFor(fonts, plan.typography.font), [plan.typography.weight]);
      if (cancelled) return;
      renderer.setScene({
        plan, alignment, audio: track, photos: [],
        fontStack: fontStackFor(fonts, plan.typography.font),
        fontOptical: fontOpticalFor(fonts, plan.typography.font),
      });

      if (reduced) {
        // Respect the preference by holding one composed frame rather than
        // showing nothing — the still is still the product.
        renderer.render(2.4);
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [fonts]);

  return (
    <figure className="hero-stage">
      <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} aria-label="A lyric video playing" />
      {label && <figcaption className="hero-badge">{label}</figcaption>}
    </figure>
  );
}
