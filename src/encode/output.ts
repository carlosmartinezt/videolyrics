/**
 * Output geometry and audio decoding.
 *
 * Deliberately free of any muxing library import. The encoder pulls in a
 * media toolkit worth a few hundred kilobytes, and nobody should pay for that
 * while they are still reading the landing page — so the export module is
 * loaded on demand, and everything needed *before* export lives here.
 */

import type { Plan } from '../types';

/** Even dimensions only — H.264 rejects odd ones at configure time. */
export function frameSizeFor(plan: Plan): { width: number; height: number } {
  const ratios: Record<string, [number, number]> = {
    '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5],
  };
  const [w, h] = ratios[plan.aspect] ?? ratios['16:9'];
  const short = plan.resolution;
  const long = Math.round((short * Math.max(w, h)) / Math.min(w, h));
  const size = w >= h ? { width: long, height: short } : { width: short, height: long };
  return {
    width: size.width - (size.width % 2),
    height: size.height - (size.height % 2),
  };
}

/**
 * Decode an audio file to PCM at a fixed rate.
 *
 * OfflineAudioContext rather than a live AudioContext so the sample rate is
 * ours to choose: a live context runs at whatever the sound card wants, which
 * varies by machine and would make the analysis differ between devices.
 */
export async function decodeAudioFile(file: Blob, sampleRate = 48000): Promise<AudioBuffer> {
  const bytes = await file.arrayBuffer();
  const context = new OfflineAudioContext(2, Math.ceil(sampleRate * 0.1), sampleRate);
  return context.decodeAudioData(bytes);
}

export function suggestFilename(plan: Plan): string {
  const slug = (text: string, max: number) => text
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
  const base = slug(plan.title.title || 'lyric-video', 60) || 'lyric-video';
  const artist = plan.title.artist ? `-${slug(plan.title.artist, 40)}` : '';
  return `${base}${artist}-${plan.resolution}p.mp4`;
}

export interface EncodeProgress {
  phase: 'preparing' | 'audio' | 'video' | 'finishing';
  frame: number;
  totalFrames: number;
  fraction: number;
  fps: number;
  /** Seconds remaining, or null while we still have no idea. */
  eta: number | null;
}

export interface EncodeResult {
  blob: Blob;
  /** How the audio got into the file — surfaced so the UI can be honest. */
  audio: { method: 'copied' | 'encoded' | 'none'; codec: string | null };
}
