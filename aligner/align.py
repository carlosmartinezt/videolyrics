#!/usr/bin/env python
"""Align pasted lyrics to an audio file and describe the song.

Invoked as a subprocess by the Node API, one job at a time:

    python align.py --audio song.mp3 --lyrics lyrics.txt --out result.json

Progress is written to stderr as one JSON object per line so the API can
stream it to the browser without waiting for the whole job:

    {"stage": "analyse", "progress": 0.4, "message": "Listening to the song"}

The result document on stdout/`--out` is the single source of truth for
everything downstream — the director and the browser renderer both read it
and nothing else.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import audio as audio_mod  # noqa: E402
import forced  # noqa: E402
import lyrics as lyrics_mod  # noqa: E402
import structure as structure_mod  # noqa: E402

RESULT_VERSION = 1

# Rough share of wall clock each stage takes, so the progress bar moves at a
# vaguely honest rate instead of sitting at 10% for two minutes.
STAGE_WEIGHTS = [
    ("decode", 0.05, "Decoding the audio"),
    ("analyse", 0.20, "Listening for tempo, beats and dynamics"),
    ("load", 0.10, "Waking up the alignment model"),
    ("align", 0.60, "Matching every word to the vocal"),
    ("finish", 0.05, "Building the timeline"),
]


class Progress:
    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.base = {}
        acc = 0.0
        for name, weight, _ in STAGE_WEIGHTS:
            self.base[name] = (acc, weight)
            acc += weight
        self.messages = {name: msg for name, _, msg in STAGE_WEIGHTS}
        self._last = -1.0

    def __call__(self, stage: str, fraction: float = 1.0) -> None:
        if not self.enabled:
            return
        base, weight = self.base.get(stage, (0.0, 0.0))
        overall = base + weight * min(max(fraction, 0.0), 1.0)
        # Don't spam the pipe with sub-percent updates.
        if overall - self._last < 0.005 and fraction < 1.0:
            return
        self._last = overall
        sys.stderr.write(json.dumps({
            "stage": stage,
            "progress": round(overall, 4),
            "message": self.messages.get(stage, stage),
        }) + "\n")
        sys.stderr.flush()


def run(audio_path: str, lyrics_text: str, model: str, threads: int,
        progress: Progress) -> dict:
    started = time.time()

    parsed = lyrics_mod.parse(lyrics_text)
    if not parsed.words:
        raise ValueError("No lyrics found — the text was empty once markers were removed.")

    if model == "auto":
        # English-only is roughly twice as fast on this hardware and scores
        # higher on English, so take it whenever the lyrics look English.
        model = "base" if lyrics_mod.guess_is_english(lyrics_text) else "mms"

    progress("decode", 0.2)
    samples_16k, wav16 = audio_mod.decode(audio_path, forced.SAMPLE_RATE)
    progress("decode", 0.6)
    samples_analysis, wav_an = audio_mod.decode(audio_path, audio_mod.ANALYSIS_RATE)
    progress("decode", 1.0)

    try:
        duration = len(samples_16k) / forced.SAMPLE_RATE

        progress("analyse", 0.1)
        features = audio_mod.analyse(samples_analysis, audio_mod.ANALYSIS_RATE)
        progress("analyse", 1.0)

        progress("load", 0.1)
        aligner = forced.Aligner(model_name=model, threads=threads)
        progress("load", 1.0)

        token_lists, aligned_words = aligner.tokenise(parsed.alignable)
        if not token_lists:
            raise ValueError(
                "None of the lyrics could be turned into sounds the model knows. "
                "Latin-script lyrics are required."
            )

        log_probs = aligner.emissions(samples_16k, progress)
        spans = aligner.align(log_probs, token_lists)

        progress("finish", 0.2)
        forced.apply_spans(parsed, aligned_words, spans)
        forced.interpolate_gaps(parsed, duration)
        forced.clean_timings(parsed, duration)
        quality = forced.alignment_quality(parsed, model)

        feature_dict = audio_mod.features_to_dict(features)
        segments = structure_mod.build(parsed, duration, feature_dict)
        progress("finish", 1.0)

        return {
            "version": RESULT_VERSION,
            "duration": round(duration, 3),
            "model": model,
            "elapsed": round(time.time() - started, 2),
            "quality": quality,
            "audio": feature_dict,
            "words": [
                {
                    "i": w.index,
                    "t": w.text,
                    "line": w.line,
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "score": round(w.score, 3),
                    "aligned": w.aligned,
                }
                for w in parsed.words
            ],
            "lines": [
                {
                    "i": ln.index,
                    "text": ln.text,
                    "section": ln.section,
                    "words": ln.words,
                    "start": round(ln.start, 3),
                    "end": round(ln.end, 3),
                }
                for ln in parsed.lines
            ],
            "segments": structure_mod.to_dicts(segments),
        }
    finally:
        for path in (wav16, wav_an):
            try:
                os.unlink(path)
            except OSError:
                pass


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--lyrics", required=True, help="path to a UTF-8 text file")
    ap.add_argument("--out", help="write JSON here instead of stdout")
    ap.add_argument("--model", default=os.environ.get("ALIGNER_MODEL", "auto"),
                    choices=["auto", "mms", "base"])
    ap.add_argument("--threads", type=int,
                    default=int(os.environ.get("ALIGNER_THREADS", "2")))
    ap.add_argument("--quiet", action="store_true", help="suppress progress lines")
    args = ap.parse_args()

    progress = Progress(enabled=not args.quiet)

    try:
        with open(args.lyrics, encoding="utf-8") as fh:
            lyrics_text = fh.read()
        result = run(args.audio, lyrics_text, args.model, args.threads, progress)
    except Exception as exc:  # surfaced to the user, so keep it readable
        sys.stderr.write(json.dumps({
            "stage": "error",
            "error": str(exc) or exc.__class__.__name__,
            "trace": traceback.format_exc(limit=4),
        }) + "\n")
        return 1

    payload = json.dumps(result, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(payload)
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
