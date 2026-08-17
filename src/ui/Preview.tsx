/**
 * The preview player.
 *
 * The canvas is driven by the audio element's clock, so what you watch here
 * is the same function of time the encoder will evaluate — the preview is not
 * an approximation of the export, it is the export with a different sink.
 *
 * Time is deliberately kept out of React state. At sixty frames a second a
 * re-render per frame would cost more than the drawing does; the component
 * reports the playhead to its parent eight times a second instead, which is
 * plenty for highlighting a row in the cue sheet.
 */

import {
  forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';

import { Renderer, type Scene } from '../render/engine';
import { frameSizeFor } from '../encode/output';
import { formatTime } from './bits';

export interface PreviewHandle {
  seek(time: number): void;
  pause(): void;
}

interface Props {
  scene: Scene;
  audioUrl: string;
  onTime?: (time: number) => void;
}

/** Cap the preview canvas so a 1080p plan does not cost 1080p of drawing. */
const MAX_PREVIEW_SHORT_EDGE = 720;

export const Preview = forwardRef<PreviewHandle, Props>(function Preview(
  { scene, audioUrl, onTime }, ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const timeRef = useRef(0);

  const [playing, setPlaying] = useState(false);
  const [display, setDisplay] = useState(0);

  const size = useMemo(() => {
    const full = frameSizeFor(scene.plan);
    const scale = Math.min(1, MAX_PREVIEW_SHORT_EDGE / Math.min(full.width, full.height));
    return {
      width: Math.round(full.width * scale / 2) * 2,
      height: Math.round(full.height * scale / 2) * 2,
    };
  }, [scene.plan.aspect, scene.plan.resolution]);

  const duration = scene.alignment.duration;

  // Recreate the renderer only when the frame size changes; a plan edit just
  // swaps the scene, which is what makes style changes feel instant.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    rendererRef.current = new Renderer(canvas, size.width, size.height);
    rendererRef.current.setScene(scene);
    rendererRef.current.render(timeRef.current);
    return () => { rendererRef.current = null; };
  }, [size.width, size.height]);

  useEffect(() => {
    rendererRef.current?.setScene(scene);
    rendererRef.current?.render(timeRef.current);
  }, [scene]);

  useEffect(() => {
    let raf = 0;
    let lastReport = 0;

    const tick = () => {
      const audio = audioRef.current;
      const renderer = rendererRef.current;
      if (renderer) {
        const t = audio && !audio.paused ? audio.currentTime : timeRef.current;
        timeRef.current = t;
        renderer.render(t);

        const now = performance.now();
        if (now - lastReport > 125) {
          lastReport = now;
          setDisplay(t);
          onTime?.(t);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onTime]);

  useImperativeHandle(ref, () => ({
    seek(time: number) {
      const clamped = Math.min(duration, Math.max(0, time));
      timeRef.current = clamped;
      setDisplay(clamped);
      if (audioRef.current) audioRef.current.currentTime = clamped;
      rendererRef.current?.render(clamped);
    },
    pause() {
      audioRef.current?.pause();
      setPlaying(false);
    },
  }), [duration]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.currentTime = timeRef.current >= duration - 0.05 ? 0 : timeRef.current;
      void audio.play();
      setPlaying(true);
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  return (
    <div>
      <div className="stage">
        <canvas ref={canvasRef} width={size.width} height={size.height} />
      </div>

      <div className="transport">
        <button
          className="play"
          onClick={toggle}
          aria-label={playing ? 'Pause' : 'Play'}
          type="button"
        >
          {playing
            ? <svg width="13" height="14" viewBox="0 0 13 14" fill="currentColor" aria-hidden="true"><rect x="1" y="1" width="4" height="12" rx="1" /><rect x="8" y="1" width="4" height="12" rx="1" /></svg>
            : <svg width="13" height="14" viewBox="0 0 13 14" fill="currentColor" aria-hidden="true"><path d="M2 1.6a1 1 0 0 1 1.5-.87l8 5.4a1 1 0 0 1 0 1.74l-8 5.4A1 1 0 0 1 2 12.4z" /></svg>}
        </button>

        <span className="time">{formatTime(display)}</span>

        <input
          className="scrub"
          type="range"
          min={0}
          max={Math.max(0.1, duration)}
          step={0.02}
          value={Math.min(display, duration)}
          onChange={(event) => {
            const t = Number(event.target.value);
            timeRef.current = t;
            setDisplay(t);
            if (audioRef.current) audioRef.current.currentTime = t;
            rendererRef.current?.render(t);
            onTime?.(t);
          }}
          aria-label="Playhead"
        />

        <span className="time">{formatTime(duration)}</span>
      </div>

      <audio
        ref={audioRef}
        src={audioUrl}
        preload="auto"
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
      />
    </div>
  );
});
