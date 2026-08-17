/**
 * Encode the plan to an MP4, in the browser.
 *
 * The server never touches video. It has two shared cores; encoding a
 * four-minute 1080p file there would take the better part of an hour and
 * block every other user. The visitor's machine does it in a fraction of that
 * and costs us nothing.
 *
 * On audio: the first version of this re-encoded to AAC and it did not work,
 * because Chrome on Linux ships an AAC *decoder* but no AAC *encoder*. So the
 * audio is not re-encoded at all — the uploaded file's audio stream is copied
 * into the MP4 verbatim. That removes the dependency on any audio encoder,
 * removes a generation of lossy re-encoding, and is close to instant. The
 * encode path only runs for sources MP4 cannot hold (Vorbis, raw PCM).
 */

import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  getFirstEncodableAudioCodec,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  type AudioCodec,
} from 'mediabunny';

import { Renderer, type Scene } from '../render/engine';
import { frameSizeFor, type EncodeProgress, type EncodeResult } from './output';

export interface EncodeOptions {
  scene: Scene;
  /** The original upload. Its audio stream is copied when it can be. */
  audioFile: Blob;
  /** Decoded PCM, used only when the source stream cannot be copied. */
  audioBuffer: AudioBuffer;
  signal?: AbortSignal;
  onProgress?: (progress: EncodeProgress) => void;
}

/**
 * Generous bitrates. Flat gradients and large areas of near-solid colour are
 * exactly where H.264 bands, and this is a one-off encode someone waits on
 * rather than something streamed.
 */
function targetBitrate(width: number, height: number, fps: number): number {
  return Math.round(Math.min(24_000_000, Math.max(2_500_000, width * height * fps * 0.11)));
}

export async function encodeToMp4(options: EncodeOptions): Promise<EncodeResult> {
  const { scene, audioFile, audioBuffer, signal, onProgress } = options;
  const { plan } = scene;

  const { width, height } = frameSizeFor(plan);
  const fps = plan.fps;
  const duration = Math.min(scene.alignment.duration, audioBuffer.duration);
  const totalFrames = Math.max(1, Math.round(duration * fps));

  const canvas = document.createElement('canvas');
  const renderer = new Renderer(canvas, width, height);
  renderer.setScene(scene);

  const format = new Mp4OutputFormat({ fastStart: 'in-memory' });
  const output = new Output({ format, target: new BufferTarget() });

  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: targetBitrate(width, height, fps),
    // Two seconds between key frames: seekable in every player, and cheap
    // relative to what this renders.
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: fps });

  onProgress?.({ phase: 'preparing', frame: 0, totalFrames, fraction: 0, fps: 0, eta: null });

  const audioPlan = await planAudio(audioFile, format);

  let audioSource: EncodedAudioPacketSource | AudioBufferSource | null = null;
  if (audioPlan.method === 'copied') {
    audioSource = new EncodedAudioPacketSource(audioPlan.codec as AudioCodec);
    output.addAudioTrack(audioSource);
  } else if (audioPlan.method === 'encoded') {
    audioSource = new AudioBufferSource({
      codec: audioPlan.codec as AudioCodec,
      quality: new Quality(192_000),
    });
    output.addAudioTrack(audioSource);
  }

  const checkAborted = () => {
    if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
  };

  try {
    await output.start();
    checkAborted();

    /* ---- audio first ------------------------------------------------- */
    // It is a rounding error next to the video, and getting it out of the way
    // keeps the frame loop uninterrupted.
    if (audioPlan.method === 'copied' && audioSource) {
      onProgress?.({ phase: 'audio', frame: 0, totalFrames, fraction: 0, fps: 0, eta: null });
      await copyAudio(audioPlan.track!, audioSource as EncodedAudioPacketSource, checkAborted);
    } else if (audioPlan.method === 'encoded' && audioSource) {
      onProgress?.({ phase: 'audio', frame: 0, totalFrames, fraction: 0, fps: 0, eta: null });
      await (audioSource as AudioBufferSource).add(audioBuffer);
    }
    if (audioSource) audioSource.close();

    /* ---- video ------------------------------------------------------- */
    const started = performance.now();
    const frameDuration = 1 / fps;

    for (let n = 0; n < totalFrames; n++) {
      checkAborted();
      renderer.render(n / fps);
      // add() resolves when the encoder and writer are ready for more, which
      // is the whole of the backpressure story.
      await videoSource.add(n / fps, frameDuration);

      if ((n & 15) === 0 || n === totalFrames - 1) {
        const elapsed = (performance.now() - started) / 1000;
        const rate = elapsed > 0.5 ? (n + 1) / elapsed : 0;
        onProgress?.({
          phase: 'video',
          frame: n + 1,
          totalFrames,
          fraction: (n + 1) / totalFrames,
          fps: Math.round(rate * 10) / 10,
          eta: rate > 0.5 ? Math.round((totalFrames - n - 1) / rate) : null,
        });
        // Yield so the progress bar actually paints and the tab stays alive.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    videoSource.close();
    checkAborted();

    onProgress?.({ phase: 'finishing', frame: totalFrames, totalFrames, fraction: 1, fps: 0, eta: 0 });
    await output.finalize();

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error('The muxer produced no data.');

    return {
      blob: new Blob([buffer], { type: 'video/mp4' }),
      audio: { method: audioPlan.method, codec: audioPlan.codec },
    };
  } catch (error) {
    if (output.state === 'started' || output.state === 'pending') {
      await output.cancel().catch(() => {});
    }
    throw error;
  } finally {
    audioPlan.input?.dispose?.();
  }
}

/* --------------------------------- audio --------------------------------- */

interface AudioPlan {
  method: 'copied' | 'encoded' | 'none';
  codec: string | null;
  track?: Awaited<ReturnType<Input['getPrimaryAudioTrack']>>;
  input?: { dispose?: () => void };
}

/**
 * Decide how the audio gets into the file.
 *
 * Copying beats encoding on every axis available to us here — quality, speed,
 * and whether it works at all on this machine — so it is only skipped when
 * MP4 genuinely cannot carry the source codec.
 */
async function planAudio(file: Blob, format: Mp4OutputFormat): Promise<AudioPlan> {
  const supported = format.getSupportedAudioCodecs();

  let input: Input | null = null;
  try {
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (track && track.codec && supported.includes(track.codec)) {
      return { method: 'copied', codec: track.codec, track, input: input as unknown as { dispose?: () => void } };
    }
  } catch {
    // Unreadable container: fall through to encoding from decoded PCM, which
    // the browser already managed once or we would not have got this far.
  }

  const encodable = await getFirstEncodableAudioCodec(
    supported.filter((codec) => codec === 'aac' || codec === 'opus'),
    { numberOfChannels: 2, sampleRate: 48000 },
  );

  return encodable
    ? { method: 'encoded', codec: encodable }
    : { method: 'none', codec: null };
}

async function copyAudio(
  track: NonNullable<Awaited<ReturnType<Input['getPrimaryAudioTrack']>>>,
  source: EncodedAudioPacketSource,
  checkAborted: () => void,
): Promise<void> {
  const sink = new EncodedPacketSink(track);
  const decoderConfig = await track.getDecoderConfig();

  let first = true;
  for await (const packet of sink.packets()) {
    checkAborted();
    // The decoder config must ride along with the first packet; without it
    // the track has no way to describe itself and players reject the file.
    await source.add(packet, first && decoderConfig
      ? { decoderConfig: decoderConfig as AudioDecoderConfig }
      : undefined);
    first = false;
  }
}
