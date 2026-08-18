"""CTC forced alignment of known lyrics to sung audio.

Why forced alignment rather than transcription: we already know every word.
Running ASR on singing and then trying to match its output to the lyrics
means fighting hallucinated word order, dropped lines and melisma. Forced
alignment inverts the problem — the token sequence is fixed, and the only
free variable is *when* each token happens. It physically cannot emit the
wrong words, and it degrades into "roughly the right place" rather than
nonsense when the vocal is buried.

The model is MMS_FA (wav2vec2, Latin-script multilingual, trained by Meta
specifically as an alignment model), or the lighter English-only
WAV2VEC2_ASR_BASE_960H when speed matters more than language coverage.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Iterable

import numpy as np
import torch
import torchaudio
import torchaudio.functional as AF

from lyrics import ParsedLyrics, Word

SAMPLE_RATE = 16000

# Emissions are computed in windows so peak memory stays flat regardless of
# song length. 30 s at 16 kHz is ~480k samples; the conv feature extractor's
# activations for that are comfortably under a gigabyte.
CHUNK_SECONDS = 30.0
CHUNK_OVERLAP_SECONDS = 2.0

ProgressFn = Callable[[str, float], None]


@dataclass
class WordSpan:
    start: float
    end: float
    score: float


class Aligner:
    """Wraps a CTC acoustic model and torchaudio's Viterbi forced aligner."""

    def __init__(self, model_name: str = "mms", threads: int = 2):
        torch.set_num_threads(max(1, threads))
        self.model_name = model_name

        if model_name == "base":
            bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
            labels = bundle.get_labels()
            # This bundle's labels are uppercase with "|" as the word
            # separator; normalise to the same lowercase char->id contract
            # MMS_FA exposes so the rest of the module is model-agnostic.
            self.dictionary = {
                label.lower(): idx
                for idx, label in enumerate(labels)
                if label not in ("-", "|")
            }
            self.star_id = None
        else:
            bundle = torchaudio.pipelines.MMS_FA
            self.dictionary = dict(bundle.get_dict())
            self.star_id = self.dictionary.get("*")

        self.blank_id = 0
        self.model = bundle.get_model()
        self.model.eval()
        self.sample_rate = bundle.sample_rate

    # -- emissions ---------------------------------------------------------

    @torch.inference_mode()
    def emissions(self, samples: np.ndarray, progress: ProgressFn | None = None) -> torch.Tensor:
        """Log-probabilities over the label set, (T, C), for the whole song.

        Windows overlap and each window's overlap region is trimmed in half,
        so every output frame comes from a position with real acoustic context
        on both sides rather than from a window edge.
        """
        waveform = torch.from_numpy(samples).unsqueeze(0)
        total = waveform.shape[1]

        chunk = int(CHUNK_SECONDS * self.sample_rate)
        overlap = int(CHUNK_OVERLAP_SECONDS * self.sample_rate)
        stride = chunk - overlap

        if total <= chunk:
            emission, _ = self.model(waveform)
            if progress:
                progress("align", 1.0)
            return torch.log_softmax(emission[0], dim=-1)

        pieces: list[torch.Tensor] = []
        starts = list(range(0, total, stride))
        for i, start in enumerate(starts):
            end = min(start + chunk, total)
            if end - start < self.sample_rate // 2 and pieces:
                break  # a sub-half-second tail adds nothing but edge artefacts
            window = waveform[:, start:end]
            emission, _ = self.model(window)
            emission = emission[0]

            # Frames per sample, measured from this window rather than assumed,
            # so a change of model stride can't silently skew every timestamp.
            frames_per_sample = emission.shape[0] / (end - start)
            trim_head = 0 if i == 0 else int(round(overlap / 2 * frames_per_sample))
            trim_tail = 0 if end >= total else int(round(overlap / 2 * frames_per_sample))
            if trim_tail:
                emission = emission[trim_head: emission.shape[0] - trim_tail]
            elif trim_head:
                emission = emission[trim_head:]
            pieces.append(emission)

            if progress:
                progress("align", (i + 1) / len(starts))

        return torch.log_softmax(torch.cat(pieces, dim=0), dim=-1)

    # -- tokenisation ------------------------------------------------------

    def tokenise(self, words: Iterable[Word]) -> tuple[list[list[int]], list[Word]]:
        """Map normalised words to label ids, dropping what we cannot score.

        A character outside the dictionary becomes the star token when the
        model has one (MMS_FA does — it means "some sound here"), otherwise it
        is dropped. A word that ends up empty is excluded from alignment
        entirely and its timing is interpolated later.
        """
        token_lists: list[list[int]] = []
        kept: list[Word] = []
        for word in words:
            ids: list[int] = []
            for ch in word.norm:
                if ch in self.dictionary:
                    ids.append(self.dictionary[ch])
                elif self.star_id is not None:
                    ids.append(self.star_id)
            if ids:
                token_lists.append(ids)
                kept.append(word)
        return token_lists, kept

    # -- alignment ---------------------------------------------------------

    @torch.inference_mode()
    def align(
        self, log_probs: torch.Tensor, token_lists: list[list[int]]
    ) -> list[WordSpan]:
        flat = [t for word in token_lists for t in word]
        num_frames = log_probs.shape[0]

        # CTC cannot emit more labels than it has frames. Songs with dense
        # lyrics and heavy melisma can get close; bail out with a clear error
        # rather than a cryptic one from the C++ kernel.
        if len(flat) > num_frames:
            raise ValueError(
                "There are more lyric characters than the audio has frames. "
                "the lyrics are much longer than the song."
            )

        targets = torch.tensor([flat], dtype=torch.int32)
        alignments, scores = AF.forced_align(
            log_probs.unsqueeze(0), targets, blank=self.blank_id
        )
        alignments, scores = alignments[0], scores[0].exp()

        spans = AF.merge_tokens(alignments, scores)
        assert len(spans) == len(flat), (
            f"aligner returned {len(spans)} spans for {len(flat)} tokens"
        )

        seconds_per_frame = self._seconds_per_frame(num_frames)

        out: list[WordSpan] = []
        cursor = 0
        for ids in token_lists:
            group = spans[cursor: cursor + len(ids)]
            cursor += len(ids)
            weight = sum(s.end - s.start for s in group) or 1
            out.append(
                WordSpan(
                    start=group[0].start * seconds_per_frame,
                    end=group[-1].end * seconds_per_frame,
                    score=sum(s.score * (s.end - s.start) for s in group) / weight,
                )
            )
        return out

    def _seconds_per_frame(self, num_frames: int) -> float:
        # wav2vec2's feature extractor has a 320-sample stride at 16 kHz.
        return 320 / self.sample_rate


def apply_spans(parsed: ParsedLyrics, aligned_words: list[Word], spans: list[WordSpan]) -> None:
    """Write measured timings back onto the words, in place."""
    for word, span in zip(aligned_words, spans):
        word.start = span.start
        word.end = span.end
        word.score = span.score
        word.aligned = True


def interpolate_gaps(parsed: ParsedLyrics, duration: float) -> None:
    """Give every unaligned word a plausible timing.

    Unaligned words are the ones that normalised to nothing — "♪", "(x2)"
    leftovers, emoji. They still occupy a slot on screen, so they need a start
    and an end. Sharing the gap between their measured neighbours keeps the
    karaoke highlight moving smoothly instead of jumping over them.
    """
    words = parsed.words
    if not words:
        return

    measured = [i for i, w in enumerate(words) if w.aligned]
    if not measured:
        # Nothing aligned at all: spread the lyrics evenly and let the UI warn.
        step = duration / max(1, len(words))
        for i, w in enumerate(words):
            w.start, w.end = i * step, (i + 1) * step
        return

    first, last = measured[0], measured[-1]

    for i in range(first):
        # Leading unalignable words share the run-up to the first sung word.
        span = words[first].start / max(1, first)
        words[i].start, words[i].end = i * span, (i + 1) * span

    for i in range(last + 1, len(words)):
        span = max(0.2, (duration - words[last].end) / max(1, len(words) - last - 1))
        words[i].start = words[last].end + (i - last - 1) * span
        words[i].end = words[i].start + span

    for a, b in zip(measured, measured[1:]):
        if b - a == 1:
            continue
        gap_start, gap_end = words[a].end, words[b].start
        span = (gap_end - gap_start) / (b - a)
        for k, i in enumerate(range(a + 1, b)):
            words[i].start = gap_start + k * span
            words[i].end = gap_start + (k + 1) * span


def clean_timings(parsed: ParsedLyrics, duration: float, min_word: float = 0.06) -> None:
    """Enforce the invariants the renderer relies on.

    Monotonic, non-overlapping, non-degenerate, inside the song. Forced
    alignment usually gives all of this for free, but a mis-scored token on a
    long held note can produce a zero-length span, and a zero-length span
    makes a word flash for a single frame.
    """
    words = parsed.words
    # Reserve the final sliver so a word clamped to the end of the song still
    # has somewhere to be. Without this, a start pinned at `duration` and an
    # end also pinned at `duration` produce a zero-length span, and a
    # zero-length span makes a word flash for a single frame.
    latest_start = max(0.0, duration - min_word)

    previous_end = 0.0
    for word in words:
        word.start = min(max(word.start, previous_end), latest_start)
        word.end = min(max(word.end, word.start + min_word), duration)
        if word.end <= word.start:
            word.end = min(duration, word.start + min_word)
        previous_end = word.end

    for line in parsed.lines:
        if not line.words:
            continue
        line.start = words[line.words[0]].start
        line.end = words[line.words[-1]].end


# The two models put their probability mass differently: the English ASR
# model is confident (a clean alignment scores ~0.9), the multilingual one
# spreads across many more plausible graphemes (a *perfect* alignment scores
# ~0.45). Judging both against one threshold would libel every mms run.
QUALITY_THRESHOLDS = {
    "base": {"good": 0.62, "fair": 0.40},
    "mms": {"good": 0.34, "fair": 0.22},
}


def alignment_quality(parsed: ParsedLyrics, model_name: str = "mms") -> dict:
    """A blunt confidence summary, surfaced in the UI.

    Low mean score almost always means one of three things: the lyrics don't
    match this recording, the vocal is mixed very low, or the language is not
    Latin-script. All three are worth telling the user about before they wait
    on a render.
    """
    scored = [w.score for w in parsed.words if w.aligned]
    if not scored:
        return {"mean_score": 0.0, "aligned_ratio": 0.0, "verdict": "failed"}

    mean = float(np.mean(scored))
    ratio = len(scored) / max(1, len(parsed.words))
    thresholds = QUALITY_THRESHOLDS.get(model_name, QUALITY_THRESHOLDS["mms"])
    weak_floor = thresholds["fair"] * 0.75
    weak = sum(1 for s in scored if s < weak_floor) / len(scored)

    if mean >= thresholds["good"] and weak < 0.25:
        verdict = "good"
    elif mean >= thresholds["fair"]:
        verdict = "fair"
    else:
        verdict = "poor"

    return {
        "mean_score": round(mean, 3),
        "aligned_ratio": round(ratio, 3),
        "weak_fraction": round(weak, 3),
        "verdict": verdict,
    }
