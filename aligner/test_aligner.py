"""Tests for the parts of the aligner that don't need the model.

Run with the venv's python:

    aligner/.venv/bin/python -m unittest discover -s aligner -v

The model itself is exercised by scripts/e2e.mjs, which runs a real file
through the whole pipeline and checks the timings against known positions.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lyrics as L  # noqa: E402
import structure as S  # noqa: E402
import forced  # noqa: E402


class TestNormalisation(unittest.TestCase):
    def test_keeps_only_the_model_alphabet(self):
        self.assertEqual(L.normalise_token("Don't"), "don't")
        self.assertEqual(L.normalise_token("Hello,"), "hello")
        self.assertEqual(L.normalise_token("y'all"), "y'all")

    def test_strips_accents_rather_than_dropping_words(self):
        self.assertEqual(L.normalise_token("corazón"), "corazon")
        self.assertEqual(L.normalise_token("Ángel"), "angel")
        self.assertEqual(L.normalise_token("naïve"), "naive")

    def test_unsingable_tokens_become_empty(self):
        for token in ["♪", "—", "…", "🎵", "(", "'"]:
            self.assertEqual(L.normalise_token(token), "", token)

    def test_numbers_are_spelled_out(self):
        self.assertIn("nineteen", L.normalise_token("1999"))
        self.assertIn("twenty", L.normalise_token("24"))
        self.assertEqual(L.normalise_token("7"), "seven")

    def test_edge_apostrophes_are_punctuation(self):
        self.assertEqual(L.normalise_token("singin'"), "singin")
        self.assertEqual(L.normalise_token("'cause"), "cause")


class TestParsing(unittest.TestCase):
    def test_section_markers_never_become_lyrics(self):
        parsed = L.parse("[Chorus]\nsing it out\n\n[Verse 2]\nquietly now\n")
        texts = [line.text for line in parsed.lines]
        self.assertEqual(texts, ["sing it out", "quietly now"])
        self.assertEqual([s.label for s in parsed.sections], ["Chorus", "Verse 2"])
        self.assertTrue(all(s.explicit for s in parsed.sections))

    def test_repeat_suffixes_are_dropped_from_display(self):
        parsed = L.parse("sing it out (x2)\nagain [3x]\n")
        self.assertEqual([l.text for l in parsed.lines], ["sing it out", "again"])

    def test_blank_lines_start_stanzas(self):
        parsed = L.parse("one\ntwo\n\nthree\nfour\n")
        self.assertEqual(parsed.stanza_breaks, [0, 2])

    def test_lines_of_pure_punctuation_are_discarded(self):
        parsed = L.parse("real words\n...\nmore words\n")
        self.assertEqual(len(parsed.lines), 2)

    def test_word_indices_line_up_with_lines(self):
        parsed = L.parse("one two\nthree four five\n")
        for line in parsed.lines:
            for wi in line.words:
                self.assertEqual(parsed.words[wi].line, line.index)

    def test_implicit_sections_are_verses_not_intros(self):
        # "Intro" belongs to instrumental time before the first word; calling
        # the opening stanza an intro would deny it verse treatment.
        parsed = L.parse("first words of the song\n")
        self.assertEqual(parsed.lines[0].section, "Verse")


class TestLanguageGuess(unittest.TestCase):
    def test_english(self):
        self.assertTrue(L.guess_is_english("I know that you don't care about the way"))

    def test_spanish(self):
        self.assertFalse(L.guess_is_english("Yo no sé qué me pasa contigo pero"))

    def test_french(self):
        self.assertFalse(L.guess_is_english("Je ne sais pas ce que tu veux de moi"))

    def test_accents_alone_are_enough(self):
        self.assertFalse(L.guess_is_english("corazón corazón corazón mi corazón"))

    def test_nonsense_defaults_to_the_fast_model(self):
        self.assertTrue(L.guess_is_english("la la la ooh ooh na na"))


def _timed(parsed, spacing=3.0, span=2.5, offset=0.0):
    for i, line in enumerate(parsed.lines):
        line.start = offset + i * spacing
        line.end = line.start + span
    return offset + len(parsed.lines) * spacing


FLAT = {"loudness": [0.5] * 3000, "brightness": [0.5] * 3000, "envelope_hz": 10}


class TestStructure(unittest.TestCase):
    def test_repetition_finds_the_chorus_without_markers(self):
        parsed = L.parse(
            "first verse line\nsecond verse line\n\n"
            "the hook is here\nthe hook is here\n\n"
            "another verse now\n\n"
            "the hook is here\nthe hook is here\n"
        )
        _timed(parsed)
        segments = S.build(parsed, 40.0, FLAT)
        kinds = [s.kind for s in segments if s.lines]
        self.assertEqual(kinds, ["verse", "chorus", "verse", "chorus"])

    def test_explicit_markers_win(self):
        parsed = L.parse("[Verse 1]\na b c\n\n[Bridge]\ng h i\n")
        _timed(parsed)
        segments = S.build(parsed, 20.0, FLAT)
        self.assertEqual([s.kind for s in segments if s.lines], ["verse", "bridge"])

    def test_repeats_point_back_at_the_original(self):
        parsed = L.parse("[Chorus]\nsame words\n\n[Verse]\nother\n\n[Chorus]\nsame words\n")
        _timed(parsed)
        segments = [s for s in S.build(parsed, 20.0, FLAT) if s.lines]
        self.assertIsNone(segments[0].repeat_of)
        self.assertEqual(segments[2].repeat_of, 0)

    def test_long_silences_become_their_own_segments(self):
        parsed = L.parse("only line here\nsecond line\n")
        _timed(parsed, offset=12.0)
        segments = S.build(parsed, 40.0, FLAT)
        self.assertEqual(segments[0].kind, "intro")
        self.assertEqual(segments[-1].kind, "outro")

    def test_the_timeline_is_gapless_and_covers_the_song(self):
        parsed = L.parse("[Verse]\na b\n\n[Chorus]\nc d\n\n[Verse]\ne f\n")
        _timed(parsed, offset=8.0)
        duration = 60.0
        segments = S.build(parsed, duration, FLAT)
        self.assertAlmostEqual(segments[0].start, 0.0, places=3)
        self.assertAlmostEqual(segments[-1].end, duration, places=3)
        for a, b in zip(segments, segments[1:]):
            self.assertAlmostEqual(a.end, b.start, places=3,
                                   msg=f"gap between {a.label} and {b.label}")


class TestTimingHygiene(unittest.TestCase):
    def _parse_and_align(self, text, spans):
        parsed = L.parse(text)
        for word, (start, end, score) in zip(parsed.words, spans):
            word.start, word.end, word.score, word.aligned = start, end, score, True
        return parsed

    def test_interpolates_words_the_model_could_not_score(self):
        parsed = L.parse("hello ♪ world\n")
        parsed.words[0].start, parsed.words[0].end = 1.0, 2.0
        parsed.words[0].aligned = True
        parsed.words[2].start, parsed.words[2].end = 4.0, 5.0
        parsed.words[2].aligned = True

        forced.interpolate_gaps(parsed, 10.0)
        middle = parsed.words[1]
        self.assertGreaterEqual(middle.start, 2.0)
        self.assertLessEqual(middle.end, 4.0 + 1e-6)

    def test_nothing_aligned_still_produces_usable_timings(self):
        parsed = L.parse("one two three four\n")
        forced.interpolate_gaps(parsed, 8.0)
        self.assertAlmostEqual(parsed.words[0].start, 0.0)
        self.assertAlmostEqual(parsed.words[-1].end, 8.0, places=3)

    def test_clean_timings_enforces_the_renderer_invariants(self):
        parsed = L.parse("a b c d\n")
        # Deliberately broken: overlapping, zero-length, out of order, past end.
        for word, (start, end) in zip(parsed.words, [(5, 4), (1, 1), (3, 9), (100, 200)]):
            word.start, word.end, word.aligned = float(start), float(end), True

        forced.clean_timings(parsed, duration=10.0)

        previous = 0.0
        for word in parsed.words:
            self.assertGreaterEqual(word.start, previous - 1e-9)
            self.assertGreater(word.end, word.start)
            self.assertLessEqual(word.end, 10.0 + 1e-9)
            previous = word.end

    def test_line_bounds_follow_their_words(self):
        parsed = L.parse("one two\nthree four\n")
        for i, word in enumerate(parsed.words):
            word.start, word.end, word.aligned = i * 1.0, i * 1.0 + 0.8, True
        forced.clean_timings(parsed, duration=10.0)
        self.assertAlmostEqual(parsed.lines[0].start, parsed.words[0].start)
        self.assertAlmostEqual(parsed.lines[1].end, parsed.words[3].end)


class TestQuality(unittest.TestCase):
    def test_thresholds_differ_per_model(self):
        # The multilingual model spreads probability across many more
        # graphemes, so a perfect alignment scores far lower than the English
        # one. Judging both against a single number would libel every mms run.
        parsed = L.parse("a b c d e f g h\n")
        for word in parsed.words:
            word.aligned, word.score = True, 0.45

        self.assertEqual(forced.alignment_quality(parsed, "mms")["verdict"], "good")
        self.assertNotEqual(forced.alignment_quality(parsed, "base")["verdict"], "good")

    def test_no_alignment_at_all_reports_failure(self):
        parsed = L.parse("a b c\n")
        self.assertEqual(forced.alignment_quality(parsed, "base")["verdict"], "failed")


if __name__ == "__main__":
    unittest.main()
