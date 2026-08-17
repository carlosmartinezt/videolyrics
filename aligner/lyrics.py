"""Lyric parsing and normalisation.

The user pastes lyrics as free text. We need two views of that text:

  * the *display* view, which keeps their capitalisation, punctuation and line
    breaks, because that is what ends up on screen; and
  * the *alignment* view, a flat sequence of lowercase a-z tokens that the CTC
    acoustic model's dictionary can actually score.

Keeping both, linked by index, is the whole job of this module.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

# Section markers people paste from Genius et al: [Chorus], [Verse 2],
# {Bridge}, (Pre-Chorus). These are metadata, never sung, so they are lifted
# out of the alignment stream and kept as structure hints for the director.
SECTION_RE = re.compile(r"^\s*[\[\{\(]\s*([^\]\}\)]{1,40})\s*[\]\}\)]\s*$")

# Repeat suffixes — "(x2)", "[2x]" — trailing a real lyric line.
REPEAT_RE = re.compile(r"\s*[\[\(]\s*[x×]?\s*\d+\s*[x×]?\s*[\]\)]\s*$", re.IGNORECASE)

_NUMBERS = {
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
}

_TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
          "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
         "eighty", "ninety"]


def _int_to_words(n: int) -> str:
    """Spell out an integer so the acoustic model has something to match.

    Only covers what shows up in lyrics — years, "24", "1999". Anything
    bigger falls back to digit-by-digit, which is also how people sing
    phone numbers and the like.
    """
    if n < 0:
        return "minus " + _int_to_words(-n)
    if n < 10:
        return _NUMBERS[str(n)]
    if n < 20:
        return _TEENS[n - 10]
    if n < 100:
        tens, ones = divmod(n, 10)
        return _TENS[tens] + ("" if ones == 0 else " " + _NUMBERS[str(ones)])
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        out = _NUMBERS[str(hundreds)] + " hundred"
        return out if rest == 0 else out + " " + _int_to_words(rest)
    if 1000 <= n <= 2099:
        # Years get read as pairs: 1999 -> "nineteen ninety nine".
        hi, lo = divmod(n, 100)
        if lo == 0:
            return _int_to_words(hi) + " hundred"
        return _int_to_words(hi) + " " + _int_to_words(lo)
    return " ".join(_NUMBERS[d] for d in str(n))


def normalise_token(raw: str) -> str:
    """Reduce one display word to the model's alphabet: a-z and apostrophe.

    Returns "" when nothing survives — an emoji, a lone dash, "♪". Those words
    stay in the display stream but are skipped by the aligner and get their
    timing interpolated from neighbours.
    """
    # Strip accents: "corazón" -> "corazon". MMS_FA's Latin dictionary has no
    # precomposed accented characters, and this is exactly what its own
    # romanisation step does for Latin-script languages.
    decomposed = unicodedata.normalize("NFKD", raw)
    ascii_ish = "".join(c for c in decomposed if not unicodedata.combining(c))
    lowered = ascii_ish.lower()

    # Curly apostrophes are extremely common in pasted lyrics.
    lowered = lowered.replace("’", "'").replace("ʼ", "'")

    if any(c.isdigit() for c in lowered):
        digits = re.sub(r"[^\d]", "", lowered)
        if digits and len(digits) <= 6:
            lowered = _int_to_words(int(digits))

    kept = re.sub(r"[^a-z']", "", lowered)
    # A leading or trailing apostrophe is punctuation ('cause, singin'); the
    # model has no token for a word-final quote, so trim to letters at the ends
    # but keep internal ones (don't, y'all).
    kept = kept.strip("'")
    return kept


# Function words are the cheapest reliable language signal in short text:
# they are frequent, they are short, and they barely overlap between these
# languages. We only need "is this English?" — the answer picks the model.
_ENGLISH_MARKERS = {
    "the", "and", "you", "your", "that", "this", "with", "have", "was", "were",
    "when", "what", "just", "like", "know", "don't", "i'm", "can't", "it's",
    "of", "to", "but", "for", "she", "he", "they", "we", "not", "all", "my",
}
_NON_ENGLISH_MARKERS = {
    # Spanish / Portuguese / Italian / French function words.
    "que", "los", "las", "una", "por", "con", "para", "como", "pero", "más",
    "mi", "tu", "es", "en", "yo", "te", "se", "del", "al", "eu", "não", "você",
    "je", "le", "les", "des", "est", "pas", "vous", "nous", "dans", "qui",
    "che", "non", "sono", "sei", "della", "ich", "und", "nicht", "du", "ist",
}


def guess_is_english(text: str) -> bool:
    """Decide whether the English-only acoustic model is the right pick.

    Wrong either way is survivable — the English model still aligns Spanish
    letters, just less confidently — so this leans towards the multilingual
    model whenever the evidence is thin.
    """
    tokens = re.findall(r"[^\W\d_]+(?:'[^\W\d_]+)?", text.lower(), flags=re.UNICODE)
    if not tokens:
        return True

    english = sum(1 for t in tokens if t in _ENGLISH_MARKERS)
    other = sum(1 for t in tokens if t in _NON_ENGLISH_MARKERS)

    # Accented characters that English never uses natively are strong evidence.
    accented = sum(1 for c in text if unicodedata.combining(c)
                   or (c.isalpha() and c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"))
    if accented > len(tokens) * 0.02:
        return False

    if english + other == 0:
        return True  # no function words at all — English model is faster
    return english > other


@dataclass
class Word:
    """One display word, plus where it sits in the alignment stream."""
    index: int
    text: str            # exactly as the user typed it
    norm: str            # model alphabet, "" if unalignable
    line: int
    start: float = 0.0
    end: float = 0.0
    score: float = 0.0
    aligned: bool = False  # False => timing was interpolated, not measured


@dataclass
class Line:
    index: int
    text: str
    section: str          # label of the section this line belongs to
    words: list[int] = field(default_factory=list)
    start: float = 0.0
    end: float = 0.0


@dataclass
class Section:
    index: int
    label: str            # "Chorus", "Verse 2", or a derived "Verse"/"Break"
    explicit: bool        # True when the user actually typed a [marker]
    lines: list[int] = field(default_factory=list)


@dataclass
class ParsedLyrics:
    words: list[Word]
    lines: list[Line]
    sections: list[Section]
    stanza_breaks: list[int]   # line indices that start a new stanza

    @property
    def alignable(self) -> list[Word]:
        return [w for w in self.words if w.norm]


def parse(raw_text: str) -> ParsedLyrics:
    """Turn pasted lyrics into words / lines / sections.

    Blank lines separate stanzas. Bracketed lines become section boundaries.
    When the user typed no markers at all we still emit one implicit section
    per stanza, so downstream code never has to special-case "no structure".
    """
    words: list[Word] = []
    lines: list[Line] = []
    sections: list[Section] = []
    stanza_breaks: list[int] = []

    current_label = "Verse"
    explicit_label = False
    pending_stanza_break = True

    def ensure_section(label: str, explicit: bool) -> Section:
        if sections and sections[-1].label == label and sections[-1].explicit == explicit:
            return sections[-1]
        sec = Section(index=len(sections), label=label, explicit=explicit)
        sections.append(sec)
        return sec

    for raw_line in raw_text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        stripped = raw_line.strip()

        if not stripped:
            pending_stanza_break = True
            continue

        marker = SECTION_RE.match(stripped)
        if marker:
            current_label = marker.group(1).strip()
            explicit_label = True
            pending_stanza_break = True
            # Start the section now so an empty section still shows up in the
            # structure the director reasons over.
            ensure_section(current_label, True)
            continue

        display = REPEAT_RE.sub("", stripped).strip() or stripped

        if pending_stanza_break:
            stanza_breaks.append(len(lines))
            pending_stanza_break = False
            if not explicit_label:
                # Every implicit block is a verse. "Intro" is reserved for
                # instrumental time before the first sung word, which only the
                # timeline knows about — labelling the first *stanza* Intro
                # would mean the opening lyric never gets verse treatment.
                current_label = "Verse"

        section = ensure_section(current_label, explicit_label)

        # Build the line's words before committing any of them. A line of pure
        # punctuation ("...", "♪") has tokens but nothing singable, and it must
        # be dropped whole: appending its words first and then skipping the
        # line would leave orphan words pointing at a line index that the next
        # real line goes on to use.
        tokens = [
            Word(index=-1, text=raw, norm=normalise_token(raw), line=len(lines))
            for raw in display.split()
        ]
        if not any(token.norm for token in tokens):
            continue

        line = Line(index=len(lines), text=display, section=section.label)
        for token in tokens:
            token.index = len(words)
            words.append(token)
            line.words.append(token.index)

        section.lines.append(line.index)
        lines.append(line)

    if not sections:
        sections.append(Section(index=0, label="Verse", explicit=False))

    return ParsedLyrics(
        words=words, lines=lines, sections=sections, stanza_breaks=stanza_breaks
    )
