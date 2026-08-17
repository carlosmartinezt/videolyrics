"""Song structure: turn timed lines into a timeline of labelled segments.

The director needs to know more than "here are 200 timed words". It needs to
know that seconds 0-14 are an instrumental intro, that the thing at 0:48 is
the chorus and it comes back three times, and that the last 20 seconds are an
outro with no words at all. That is what lets the visuals *arrive* somewhere
instead of cycling aimlessly.

Everything here is derived from data we already have — timings, repetition,
loudness — so it works with no user input and no model call.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict

from lyrics import ParsedLyrics

# A silence longer than this between sung lines is treated as a musical event
# in its own right, not just a breath.
BREAK_SECONDS = 4.0

CHORUS_HINTS = ("chorus", "hook", "refrain", "estribillo")
BRIDGE_HINTS = ("bridge", "puente")
VERSE_HINTS = ("verse", "verso", "strofa")


@dataclass
class Segment:
    index: int
    kind: str          # intro | verse | chorus | bridge | break | outro | lyric
    label: str         # human label, e.g. "Chorus" or "Instrumental"
    start: float
    end: float
    lines: list[int]
    energy: float      # mean loudness 0..1 over the segment
    brightness: float
    repeat_of: int | None = None   # index of the first segment with this text

    @property
    def duration(self) -> float:
        return self.end - self.start


def _fingerprint(parsed: ParsedLyrics, line_indices: list[int]) -> str:
    words = []
    for li in line_indices:
        words.extend(parsed.words[wi].norm for wi in parsed.lines[li].words)
    return " ".join(w for w in words if w)


def _kind_from_label(label: str) -> str | None:
    low = label.lower()
    if any(h in low for h in CHORUS_HINTS):
        return "chorus"
    if any(h in low for h in BRIDGE_HINTS):
        return "bridge"
    if any(h in low for h in VERSE_HINTS):
        return "verse"
    if "intro" in low:
        return "intro"
    if "outro" in low:
        return "outro"
    return None


def _mean_over(curve: list[float], hz: float, start: float, end: float) -> float:
    if not curve or end <= start:
        return 0.0
    lo = max(0, int(start * hz))
    hi = min(len(curve), max(lo + 1, int(end * hz)))
    window = curve[lo:hi]
    return round(sum(window) / len(window), 4) if window else 0.0


def build(parsed: ParsedLyrics, duration: float, features: dict) -> list[Segment]:
    """Produce a gapless timeline of segments covering the whole song."""
    loud = features.get("loudness") or []
    bright = features.get("brightness") or []
    hz = features.get("envelope_hz") or 10.0

    # Only labels the user actually typed carry meaning. Implicit blocks are
    # all labelled "Verse" by the parser, and trusting that would suppress the
    # repetition test below — which is the only thing that can find the chorus
    # in the common case of lyrics pasted with no markers at all.
    explicit_labels = {s.label for s in parsed.sections if s.explicit}

    # Group lines into blocks. Explicit [Chorus] markers win; otherwise a block
    # boundary is either a stanza break or a long instrumental gap.
    blocks: list[list[int]] = []
    current: list[int] = []
    stanza_starts = set(parsed.stanza_breaks)

    for line in parsed.lines:
        boundary = False
        if current:
            previous = parsed.lines[current[-1]]
            if line.section != previous.section:
                boundary = True
            elif line.index in stanza_starts:
                boundary = True
            elif line.start - previous.end >= BREAK_SECONDS:
                boundary = True
        if boundary:
            blocks.append(current)
            current = []
        current.append(line.index)
    if current:
        blocks.append(current)

    # Repetition: identical lyric content appearing more than once is a chorus
    # in all but name, which is how we label songs pasted without markers.
    seen: dict[str, int] = {}
    repeat_of: list[int | None] = []
    counts: dict[str, int] = {}
    for i, block in enumerate(blocks):
        fp = _fingerprint(parsed, block)
        counts[fp] = counts.get(fp, 0) + 1
        if fp in seen:
            repeat_of.append(seen[fp])
        else:
            seen[fp] = i
            repeat_of.append(None)

    segments: list[Segment] = []

    def add(kind: str, label: str, start: float, end: float,
            lines: list[int], repeat: int | None = None) -> None:
        if end - start <= 0.05:
            return
        segments.append(Segment(
            index=len(segments), kind=kind, label=label,
            start=round(start, 3), end=round(end, 3), lines=lines,
            energy=_mean_over(loud, hz, start, end),
            brightness=_mean_over(bright, hz, start, end),
            repeat_of=repeat,
        ))

    cursor = 0.0
    for i, block in enumerate(blocks):
        block_start = parsed.lines[block[0]].start
        block_end = parsed.lines[block[-1]].end
        fp = _fingerprint(parsed, block)

        if block_start - cursor >= BREAK_SECONDS:
            label = "Intro" if not segments else "Instrumental"
            add("intro" if not segments else "break", label, cursor, block_start, [])
            cursor = block_start

        section_label = parsed.lines[block[0]].section
        stated = _kind_from_label(section_label) if section_label in explicit_labels else None
        kind = stated or ("chorus" if counts.get(fp, 0) > 1 else "verse")
        label = section_label if stated else kind.capitalize()

        # Start at the cursor, not at the block's first word. Short gaps
        # between stanzas — a breath, two beats — get absorbed into the
        # preceding section, because the renderer treats this as a partition
        # of the song and a hole in it would leave a frame with no cue at all.
        add(kind, label, cursor, block_end, block, repeat_of[i])
        cursor = max(cursor, block_end)

    if duration - cursor >= BREAK_SECONDS:
        add("outro", "Outro", cursor, duration, [])
    elif segments:
        segments[-1].end = round(duration, 3)

    return segments


def to_dicts(segments: list[Segment]) -> list[dict]:
    return [asdict(s) for s in segments]
