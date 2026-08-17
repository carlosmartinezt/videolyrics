/**
 * What can this browser actually do?
 *
 * Rendering happens on the visitor's machine, which is what makes this
 * affordable to host — but it means "can I export?" is a property of their
 * browser, and we should find that out on page load rather than after they
 * have waited three minutes for an alignment.
 *
 * Only the video encoder is a hard requirement. Audio is copied out of the
 * uploaded file rather than re-encoded, so an absent AAC encoder — which is
 * every Chrome on Linux — costs nothing.
 */

export interface Support {
  ok: boolean;
  video: boolean;
  /** Whether an audio *encoder* exists. Only needed for odd source formats. */
  audioEncoder: boolean;
  webAudio: boolean;
  reason: string | null;
  advice: string | null;
}

const AVC_CANDIDATES = [
  { codec: 'avc1.640028', label: 'High 4.0' },
  { codec: 'avc1.4d0028', label: 'Main 4.0' },
  { codec: 'avc1.42001f', label: 'Baseline 3.1' },
];

export async function detectSupport(width = 1920, height = 1080, fps = 30): Promise<Support> {
  const webAudio = typeof window !== 'undefined'
    && (typeof window.AudioContext !== 'undefined' || 'webkitAudioContext' in window);

  if (typeof window === 'undefined' || typeof window.VideoEncoder === 'undefined') {
    return {
      ok: false, video: false, audioEncoder: false, webAudio,
      reason: 'This browser cannot encode video.',
      advice: 'Chrome, Edge, Brave, Arc or Opera on a computer will work. Everything up to the download works here.',
    };
  }

  let video = false;
  for (const candidate of AVC_CANDIDATES) {
    try {
      const result = await window.VideoEncoder.isConfigSupported({
        codec: candidate.codec, width, height, framerate: fps, bitrate: 6_000_000,
      });
      if (result?.supported) { video = true; break; }
    } catch { /* try the next profile */ }
  }

  let audioEncoder = false;
  if (typeof window.AudioEncoder !== 'undefined') {
    for (const codec of ['mp4a.40.2', 'opus']) {
      try {
        const result = await window.AudioEncoder.isConfigSupported({
          codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000,
        });
        if (result?.supported) { audioEncoder = true; break; }
      } catch { /* keep looking */ }
    }
  }

  if (!video) {
    return {
      ok: false, video: false, audioEncoder, webAudio,
      reason: 'This browser can play H.264 but not create it.',
      advice: 'Desktop Chrome or Edge can. Firefox and some Linux builds ship without an H.264 encoder.',
    };
  }

  return { ok: true, video: true, audioEncoder, webAudio, reason: null, advice: null };
}
