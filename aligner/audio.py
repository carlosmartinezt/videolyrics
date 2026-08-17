"""Audio decoding and musical feature extraction.

Two consumers, two very different needs:

  * the *aligner* wants 16 kHz mono float32, nothing else;
  * the *director* wants to know what the song is like — how fast, how loud
    where, how bright, where the beats fall, whether it is major or minor.

The browser recomputes fine-grained per-frame reactivity itself at render
time (it has the decoded PCM anyway, and shipping a 30 fps envelope for a
five minute song would be a pointless payload). So everything here is either
sparse (beat times) or heavily downsampled (10 Hz envelopes).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, asdict

import numpy as np


ANALYSIS_RATE = 22050      # librosa's default; plenty for tempo and timbre
ENVELOPE_HZ = 10.0         # resolution of the loudness/brightness curves


def _ffmpeg() -> str:
    exe = os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError(
            "ffmpeg not found. Set FFMPEG_BIN or put ffmpeg on PATH."
        )
    return exe


def _ffprobe() -> str | None:
    return os.environ.get("FFPROBE_BIN") or shutil.which("ffprobe")


def probe_duration(path: str) -> float | None:
    exe = _ffprobe()
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "-v", "quiet", "-print_format", "json", "-show_format", path],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout
        return float(json.loads(out)["format"]["duration"])
    except Exception:
        return None


def decode(path: str, sample_rate: int, dest_dir: str | None = None) -> tuple[np.ndarray, str]:
    """Decode any container ffmpeg understands to mono float32 at `sample_rate`.

    Returns the samples and the path of the temporary wav, which the caller
    owns. We go through a file rather than a pipe so that a truncated or
    corrupt upload fails loudly here instead of halfway through inference.
    """
    fd, wav_path = tempfile.mkstemp(suffix=".wav", dir=dest_dir)
    os.close(fd)
    cmd = [
        _ffmpeg(), "-nostdin", "-v", "error", "-y",
        "-i", path,
        "-ac", "1", "-ar", str(sample_rate),
        "-f", "wav", "-acodec", "pcm_s16le",
        wav_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        os.unlink(wav_path)
        detail = (proc.stderr or "").strip().splitlines()
        raise RuntimeError(
            "Could not decode the audio file. " + (detail[-1] if detail else "")
        )

    import soundfile as sf
    data, sr = sf.read(wav_path, dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != sample_rate:  # ffmpeg was asked for this rate; belt and braces
        raise RuntimeError(f"expected {sample_rate} Hz, got {sr}")
    return data, wav_path


# Krumhansl-Schmuckler profiles, normalised. Used to guess key, which the
# director only uses as a mood nudge (minor -> cooler palettes), so a wrong
# guess costs a little colour, not correctness.
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _estimate_key(chroma_mean: np.ndarray) -> tuple[str, str, float]:
    def corr(profile: np.ndarray) -> np.ndarray:
        out = np.empty(12)
        p = (profile - profile.mean()) / (profile.std() + 1e-9)
        for shift in range(12):
            rolled = np.roll(chroma_mean, -shift)
            c = (rolled - rolled.mean()) / (rolled.std() + 1e-9)
            out[shift] = float((p * c).mean())
        return out

    maj, mnr = corr(_MAJOR), corr(_MINOR)
    if maj.max() >= mnr.max():
        idx = int(maj.argmax())
        return _PITCHES[idx], "major", float(maj.max())
    idx = int(mnr.argmax())
    return _PITCHES[idx], "minor", float(mnr.max())


@dataclass
class AudioFeatures:
    duration: float
    tempo: float
    beats: list[float]          # beat onsets, seconds
    downbeats: list[float]      # every 4th beat, a cheap but useful bar grid
    onsets: list[float]         # percussive events, seconds
    envelope_hz: float
    loudness: list[float]       # 0..1, ENVELOPE_HZ resolution
    brightness: list[float]     # 0..1 spectral centroid, same grid
    bass: list[float]           # 0..1 sub/low band energy, same grid
    key: str
    mode: str
    key_confidence: float
    peak_loudness_at: float     # seconds — where the song is biggest


def _to_unit(x: np.ndarray, lo_pct: float = 5.0, hi_pct: float = 95.0) -> np.ndarray:
    """Robustly squash a curve to 0..1.

    Percentile clipping rather than min/max, because one cymbal crash should
    not flatten the entire rest of the song against the floor.
    """
    if x.size == 0:
        return x
    lo, hi = np.percentile(x, lo_pct), np.percentile(x, hi_pct)
    if hi - lo < 1e-9:
        return np.zeros_like(x)
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


def _resample_curve(curve: np.ndarray, times: np.ndarray, duration: float) -> np.ndarray:
    n = max(1, int(round(duration * ENVELOPE_HZ)))
    grid = np.linspace(0.0, duration, n, endpoint=False)
    if curve.size == 0:
        return np.zeros(n)
    return np.interp(grid, times, curve)


def analyse(samples: np.ndarray, sample_rate: int) -> AudioFeatures:
    import librosa

    duration = float(len(samples) / sample_rate)
    hop = 512

    stft = np.abs(librosa.stft(samples, n_fft=2048, hop_length=hop))
    frame_times = librosa.frames_to_time(np.arange(stft.shape[1]), sr=sample_rate, hop_length=hop)
    freqs = librosa.fft_frequencies(sr=sample_rate, n_fft=2048)

    rms = librosa.feature.rms(S=stft, frame_length=2048, hop_length=hop)[0]
    # Loudness in dB tracks perception far better than linear RMS, and makes
    # quiet verses distinguishable from silence instead of all reading as ~0.
    loud_db = librosa.amplitude_to_db(rms + 1e-8)
    loudness = _to_unit(loud_db)

    centroid = librosa.feature.spectral_centroid(S=stft, sr=sample_rate)[0]
    brightness = _to_unit(centroid)

    bass_band = stft[freqs < 200].sum(axis=0)
    bass = _to_unit(librosa.amplitude_to_db(bass_band + 1e-8))

    onset_env = librosa.onset.onset_strength(S=librosa.power_to_db(stft**2), sr=sample_rate, hop_length=hop)
    tempo_arr, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sample_rate, hop_length=hop, units="frames"
    )
    tempo = float(np.atleast_1d(tempo_arr)[0])
    beats = librosa.frames_to_time(beat_frames, sr=sample_rate, hop_length=hop).tolist()

    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sample_rate, hop_length=hop, backtrack=True
    )
    onsets = librosa.frames_to_time(onset_frames, sr=sample_rate, hop_length=hop).tolist()

    # Assume 4/4 and anchor bars on the strongest beat within the first bar —
    # good enough to sync hard cuts, and wrong only on genuinely odd metres.
    downbeats: list[float] = []
    if len(beats) >= 4:
        strengths = np.interp(beats, frame_times, onset_env)
        offset = int(np.argmax(strengths[:4]))
        downbeats = beats[offset::4]

    chroma = librosa.feature.chroma_cqt(y=samples, sr=sample_rate, hop_length=hop)
    key, mode, key_conf = _estimate_key(chroma.mean(axis=1))

    smooth_loud = np.convolve(loudness, np.ones(43) / 43, mode="same")
    peak_at = float(frame_times[int(np.argmax(smooth_loud))]) if frame_times.size else 0.0

    return AudioFeatures(
        duration=duration,
        tempo=round(tempo, 2),
        beats=[round(b, 4) for b in beats],
        downbeats=[round(b, 4) for b in downbeats],
        onsets=[round(o, 4) for o in onsets],
        envelope_hz=ENVELOPE_HZ,
        loudness=[round(float(v), 4) for v in _resample_curve(loudness, frame_times, duration)],
        brightness=[round(float(v), 4) for v in _resample_curve(brightness, frame_times, duration)],
        bass=[round(float(v), 4) for v in _resample_curve(bass, frame_times, duration)],
        key=key,
        mode=mode,
        key_confidence=round(key_conf, 3),
        peak_loudness_at=round(peak_at, 3),
    )


def features_to_dict(f: AudioFeatures) -> dict:
    return asdict(f)
