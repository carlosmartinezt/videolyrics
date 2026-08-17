/**
 * A self-contained scene for the landing page.
 *
 * The hero is the renderer running for real — the same class that produces
 * the exported file, drawing a short phrase on a loop. That is a stronger
 * claim than any screenshot: what you see moving is literally the product.
 *
 * There is no audio, so the reactivity comes from a synthesised track at a
 * fixed tempo. Nothing is random, so the loop is identical every pass.
 */

import type { Alignment, AlignedLine, AlignedWord, Plan, Segment } from '../types';
import type { AudioTrack } from '../audio/track';
import { BAND_COUNT } from '../audio/track';

const TEMPO = 96;
const LOOP = 12; // seconds

const PHRASE = [
  'Drop the song in',
  'paste the words',
  'it does the rest',
];

function buildLyrics(): { words: AlignedWord[]; lines: AlignedLine[] } {
  const words: AlignedWord[] = [];
  const lines: AlignedLine[] = [];

  let t = 1.1;
  PHRASE.forEach((text, lineIndex) => {
    const tokens = text.split(' ');
    const lineWords: number[] = [];
    const start = t;
    for (const token of tokens) {
      const span = 0.26 + token.length * 0.045;
      words.push({
        i: words.length, t: token, line: lineIndex,
        start: t, end: t + span, score: 1, aligned: true,
      });
      lineWords.push(words.length - 1);
      t += span + 0.07;
    }
    lines.push({
      i: lineIndex, text, section: 'Verse', words: lineWords,
      start, end: t,
    });
    t += 0.85;
  });

  return { words, lines };
}

export function demoAlignment(): Alignment {
  const { words, lines } = buildLyrics();
  const beatSpacing = 60 / TEMPO;
  const beats: number[] = [];
  for (let b = 0; b * beatSpacing < LOOP; b++) beats.push(b * beatSpacing);

  const segments: Segment[] = [
    {
      index: 0, kind: 'verse', label: 'Verse', start: 0,
      end: lines[lines.length - 1].end + 0.6, lines: lines.map((l) => l.i),
      energy: 0.6, brightness: 0.55, repeat_of: null,
    },
    {
      index: 1, kind: 'break', label: 'Instrumental',
      start: lines[lines.length - 1].end + 0.6, end: LOOP, lines: [],
      energy: 0.45, brightness: 0.5, repeat_of: null,
    },
  ];

  return {
    version: 1,
    duration: LOOP,
    model: 'demo',
    elapsed: 0,
    quality: { mean_score: 1, aligned_ratio: 1, verdict: 'good' },
    audio: {
      duration: LOOP, tempo: TEMPO, beats,
      downbeats: beats.filter((_, i) => i % 4 === 0),
      onsets: beats.flatMap((b) => [b, b + beatSpacing * 0.5]),
      envelope_hz: 10, loudness: [], brightness: [], bass: [],
      key: 'A', mode: 'minor', key_confidence: 0.8, peak_loudness_at: 6,
    },
    words,
    lines,
    segments,
  };
}

/** Synthesised reactivity: a steady four-to-the-floor with a breathing top. */
export function demoTrack(fps = 60): AudioTrack {
  const duration = LOOP;
  const frames = Math.ceil(duration * fps);
  const beatSpacing = 60 / TEMPO;

  const make = (fn: (t: number, f: number) => number) => {
    const out = new Float32Array(frames);
    for (let f = 0; f < frames; f++) out[f] = Math.max(0, Math.min(1, fn(f / fps, f)));
    return out;
  };

  const decayTo = (t: number, spacing: number, tau: number) =>
    Math.exp(-((t % spacing) / tau));

  const level = make((t) => 0.42 + 0.2 * Math.sin(t * 0.9) + 0.14 * decayTo(t, beatSpacing, 0.18));
  const bass = make((t) => 0.25 + 0.6 * decayTo(t, beatSpacing, 0.13));
  const mid = make((t) => 0.35 + 0.22 * Math.sin(t * 1.7 + 1));
  const treble = make((t) => 0.3 + 0.35 * decayTo(t, beatSpacing / 2, 0.07));
  const beat = make((t) => decayTo(t, beatSpacing, 0.16));
  const downbeat = make((t) => decayTo(t, beatSpacing * 4, 0.3));
  const hit = make((t) => decayTo(t, beatSpacing / 2, 0.06));

  const bands = new Float32Array(frames * BAND_COUNT);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < BAND_COUNT; i++) {
      const tilt = 1 - (i / BAND_COUNT) * 0.55;
      const wobble = 0.5 + 0.5 * Math.sin(f / fps * (1.2 + i * 0.21) + i);
      bands[f * BAND_COUNT + i] = Math.max(0, Math.min(1, tilt * (0.35 + 0.5 * wobble) * (0.6 + bass[f] * 0.6)));
    }
  }

  const clampFrame = (f: number) => Math.min(frames - 1, Math.max(0, f));

  return {
    fps, frames, duration, level, bass, mid, treble, beat, downbeat, hit,
    bands, bandCount: BAND_COUNT,
    at(time) {
      const f = clampFrame(Math.round((time % duration) * fps));
      return {
        level: level[f], bass: bass[f], mid: mid[f], treble: treble[f],
        beat: beat[f], downbeat: downbeat[f], hit: hit[f],
      };
    },
    bandsAt(time) {
      const f = clampFrame(Math.round((time % duration) * fps));
      return bands.subarray(f * BAND_COUNT, (f + 1) * BAND_COUNT);
    },
  };
}

/** The look the landing page demonstrates. Deliberately not the defaults. */
export function demoPlan(): Plan {
  return {
    version: 1,
    template: 'aurora',
    aspect: '16:9',
    resolution: 720,
    fps: 60,
    mood: { words: ['dreamy', 'hopeful'], energy: 0.55, warmth: 0.5, brightness: 0.5 },
    palette: {
      id: 'ultraviolet',
      bg: ['#0b0620', '#241154', '#060312'],
      fg: '#f0ecff',
      dim: '#6350a5',
      accent: '#b388ff',
      accent2: '#39e0ff',
      glow: '#8b5cf6',
    },
    typography: {
      font: 'space-grotesk', case: 'upper', weight: 500,
      align: 'center', tracking: 0.06, scale: 0.92,
    },
    lyrics: { mode: 'wordPop', linesVisible: 1, highlight: 'glow', maxWordsPerCard: 9 },
    background: { intensity: 0.7, grain: 0.12, vignette: 0.4, motion: 0.55, scrim: 0.2 },
    photos: { enabled: false, treatment: 'kenburns', opacity: 0.7, tint: 0.3, changeOn: 'section' },
    reactivity: { pulse: 0.5, flash: 0.25, shake: 0.06, cutOnDownbeat: false },
    title: { show: false, title: '', artist: '', style: 'fade', holdUntil: 0 },
    cues: [
      { segment: 0, treatment: 'drift', intensity: 0.62, lyricMode: null, accentShift: 0, note: '' },
      { segment: 1, treatment: 'bloom', intensity: 0.5, lyricMode: null, accentShift: 0.05, note: '' },
    ],
    notes: '',
    source: 'demo',
  };
}
