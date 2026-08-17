/**
 * Per-frame audio reactivity, computed once, up front.
 *
 * The usual way to make visuals react to music is an AnalyserNode reading the
 * playing audio. That cannot work here: the encoder runs as fast as it can,
 * often several times faster than realtime, so there is no "now" to analyse.
 *
 * So we analyse the whole decoded buffer offline into a table indexed by
 * frame number, and both the live preview and the encoder read that same
 * table. The direct benefit is that the preview and the exported file are
 * frame-for-frame identical, which is the whole point.
 */

import type { AudioFeatures } from '../types';

export interface FrameAudio {
  /** Overall loudness, 0..1, smoothed. */
  level: number;
  /** Sub-bass and bass, 0..1. This is what "the beat" feels like. */
  bass: number;
  /** Mids, where the vocal lives. */
  mid: number;
  /** Highs — cymbals, air, sibilance. */
  treble: number;
  /** 1 at a beat, decaying to 0 before the next. */
  beat: number;
  /** As `beat`, but only on bar starts. */
  downbeat: number;
  /** Sharp spike on percussive onsets, decays fast. */
  hit: number;
}

export interface AudioTrack {
  fps: number;
  frames: number;
  duration: number;
  level: Float32Array;
  bass: Float32Array;
  mid: Float32Array;
  treble: Float32Array;
  beat: Float32Array;
  downbeat: Float32Array;
  hit: Float32Array;
  /** BAND_COUNT log-spaced magnitudes per frame, flattened. */
  bands: Float32Array;
  bandCount: number;
  /** Sample at an arbitrary time; clamps at both ends. */
  at(time: number): FrameAudio;
  /** The spectrum for one frame, as a view — do not mutate. */
  bandsAt(time: number): Float32Array;
}

const FFT_SIZE = 2048;

/**
 * Bars in the spectrum visual. Log-spaced from 30 Hz to 14 kHz so each bar
 * covers roughly the same musical interval — a linear split would give three
 * quarters of the display to frequencies nobody can hear anything in.
 */
export const BAND_COUNT = 48;
const BAND_LOW_HZ = 30;
const BAND_HIGH_HZ = 14000;

/* ------------------------------ small FFT -------------------------------- */

/**
 * In-place iterative radix-2 Cooley-Tukey.
 * 2048 points, a few thousand times — well under a second, and it saves
 * pulling in a DSP library for one function.
 */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/* ------------------------------- building -------------------------------- */

function hann(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return w;
}

/** Squash a band's energy to 0..1 using its own distribution, not a guess. */
function normaliseBand(values: Float32Array, lowPct = 0.08, highPct = 0.96): void {
  const sorted = Float32Array.from(values).sort();
  const lo = sorted[Math.floor(sorted.length * lowPct)] ?? 0;
  const hi = sorted[Math.floor(sorted.length * highPct)] ?? 1;
  const span = Math.max(1e-6, hi - lo);
  for (let i = 0; i < values.length; i++) {
    values[i] = Math.min(1, Math.max(0, (values[i] - lo) / span));
  }
}

/** One-pole smoothing with separate attack and release, in frames. */
function envelope(values: Float32Array, attack: number, release: number): void {
  let state = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    const target = values[i];
    const coeff = target > state ? attack : release;
    state += (target - state) * coeff;
    values[i] = state;
  }
}

/** Impulses at the given times, decaying exponentially over `decay` seconds. */
function impulseTrack(times: number[], frames: number, fps: number, decay: number): Float32Array {
  const out = new Float32Array(frames);
  const k = Math.exp(-1 / (decay * fps));
  let level = 0;
  let next = 0;
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    while (next < times.length && times[next] <= t) {
      level = 1;
      next++;
    }
    out[f] = level;
    level *= k;
  }
  return out;
}

/**
 * Build the reactivity table from decoded PCM.
 *
 * Beat and onset positions come from the server's librosa analysis rather
 * than being re-detected here — that analysis had the whole file, proper
 * onset-strength envelopes and a tempo tracker, and duplicating a worse
 * version of it in the browser would only introduce disagreement.
 */
export function buildAudioTrack(
  buffer: AudioBuffer,
  features: AudioFeatures,
  fps: number,
): AudioTrack {
  const duration = buffer.duration;
  const frames = Math.max(1, Math.ceil(duration * fps));
  const sampleRate = buffer.sampleRate;

  // Mono sum — the visuals have no concept of stereo.
  const mono = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) mono[i] += data[i];
  }
  if (buffer.numberOfChannels > 1) {
    for (let i = 0; i < mono.length; i++) mono[i] /= buffer.numberOfChannels;
  }

  const window = hann(FFT_SIZE);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  const level = new Float32Array(frames);
  const bass = new Float32Array(frames);
  const mid = new Float32Array(frames);
  const treble = new Float32Array(frames);

  const bands = new Float32Array(frames * BAND_COUNT);

  const binHz = sampleRate / FFT_SIZE;
  const bin = (hz: number) => Math.min(FFT_SIZE / 2 - 1, Math.max(1, Math.round(hz / binHz)));
  const bassRange = [bin(20), bin(180)];
  const midRange = [bin(180), bin(2200)];
  const trebleRange = [bin(2200), bin(12000)];

  // Precompute each bar's bin range once rather than per frame.
  const bandEdges: Array<[number, number]> = [];
  for (let i = 0; i < BAND_COUNT; i++) {
    const lo = BAND_LOW_HZ * (BAND_HIGH_HZ / BAND_LOW_HZ) ** (i / BAND_COUNT);
    const hi = BAND_LOW_HZ * (BAND_HIGH_HZ / BAND_LOW_HZ) ** ((i + 1) / BAND_COUNT);
    const a = bin(lo);
    bandEdges.push([a, Math.max(a + 1, bin(hi))]);
  }

  for (let f = 0; f < frames; f++) {
    // Centre the window on the frame so a hit lands on the frame that shows it.
    const centre = Math.round((f / fps) * sampleRate);
    const start = centre - FFT_SIZE / 2;

    let sum = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = start + i;
      const sample = idx >= 0 && idx < mono.length ? mono[idx] : 0;
      re[i] = sample * window[i];
      im[i] = 0;
      sum += sample * sample;
    }
    level[f] = Math.sqrt(sum / FFT_SIZE);

    fft(re, im);

    let b = 0, m = 0, t = 0;
    for (let k = bassRange[0]; k < bassRange[1]; k++) b += re[k] * re[k] + im[k] * im[k];
    for (let k = midRange[0]; k < midRange[1]; k++) m += re[k] * re[k] + im[k] * im[k];
    for (let k = trebleRange[0]; k < trebleRange[1]; k++) t += re[k] * re[k] + im[k] * im[k];

    // Log scaling: energy in a band spans several orders of magnitude, and a
    // linear mapping leaves everything except the loudest moment near zero.
    bass[f] = Math.log10(1 + b * 1e3);
    mid[f] = Math.log10(1 + m * 1e3);
    treble[f] = Math.log10(1 + t * 1e4);

    for (let i = 0; i < BAND_COUNT; i++) {
      const [lo, hi] = bandEdges[i];
      let energy = 0;
      for (let k = lo; k < hi; k++) energy += re[k] * re[k] + im[k] * im[k];
      // Per-bar tilt: high frequencies carry far less energy, so without a
      // lift the right-hand half of any spectrum display is a flat line.
      const tilt = 1 + (i / BAND_COUNT) * 6;
      bands[f * BAND_COUNT + i] = Math.log10(1 + (energy / (hi - lo)) * 1e4 * tilt);
    }
  }

  for (const band of [level, bass, mid, treble]) normaliseBand(band);

  // Normalise the spectrum as one surface, not bar by bar: independent
  // normalisation would make silence in a band look like full scale.
  normaliseBand(bands, 0.35, 0.995);

  // Fast attack, slower release: visuals should snap to a hit and ease off it,
  // which is also how a compressor makes music feel punchy.
  envelope(level, 0.55, 0.14);
  envelope(bass, 0.75, 0.16);
  envelope(mid, 0.5, 0.12);
  envelope(treble, 0.8, 0.22);

  const beatDecay = Math.max(0.12, 60 / Math.max(50, features.tempo || 100) * 0.55);
  const beat = impulseTrack(features.beats || [], frames, fps, beatDecay);
  const downbeat = impulseTrack(features.downbeats || [], frames, fps, beatDecay * 1.8);
  const hit = impulseTrack(features.onsets || [], frames, fps, 0.13);

  const clampFrame = (f: number) => Math.min(frames - 1, Math.max(0, f));

  return {
    fps, frames, duration,
    level, bass, mid, treble, beat, downbeat, hit,
    bands, bandCount: BAND_COUNT,
    at(time: number): FrameAudio {
      const f = clampFrame(Math.round(time * fps));
      return {
        level: level[f], bass: bass[f], mid: mid[f], treble: treble[f],
        beat: beat[f], downbeat: downbeat[f], hit: hit[f],
      };
    },
    bandsAt(time: number): Float32Array {
      const f = clampFrame(Math.round(time * fps));
      return bands.subarray(f * BAND_COUNT, (f + 1) * BAND_COUNT);
    },
  };
}

/** A flat track, for previewing before the audio has been analysed. */
export function silentTrack(duration: number, fps: number): AudioTrack {
  const frames = Math.max(1, Math.ceil(duration * fps));
  const zero = new Float32Array(frames);
  const zeroBands = new Float32Array(BAND_COUNT);
  return {
    fps, frames, duration,
    level: zero, bass: zero, mid: zero, treble: zero,
    beat: zero, downbeat: zero, hit: zero,
    bands: new Float32Array(frames * BAND_COUNT), bandCount: BAND_COUNT,
    at: () => ({ level: 0, bass: 0, mid: 0, treble: 0, beat: 0, downbeat: 0, hit: 0 }),
    bandsAt: () => zeroBands,
  };
}
