/**
 * The deterministic director runs on every job and is what ships when no
 * model key is set, so it needs to be right on its own — not merely a
 * plausible starting point for something else to fix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { directDeterministic, deriveMood, buildCues, chooseLyricMode } from './deterministic.mjs';
import { readLyrics } from './lexicon.mjs';
import { TEMPLATES_BY_ID } from '../../shared/templates.mjs';

/* ------------------------------- fixtures -------------------------------- */

function audio(overrides = {}) {
  return {
    duration: 200, tempo: 120, beats: [], downbeats: [],
    onsets: Array.from({ length: 400 }, (_, i) => i * 0.5),
    envelope_hz: 10,
    loudness: Array(2000).fill(0.5),
    brightness: Array(2000).fill(0.5),
    bass: Array(2000).fill(0.5),
    key: 'C', mode: 'major', key_confidence: 0.7, peak_loudness_at: 100,
    ...overrides,
  };
}

function song({ lines = 12, lyricsText = 'la la la', segmentKinds = ['verse', 'chorus'], audioOverrides = {} } = {}) {
  const alignmentLines = Array.from({ length: lines }, (_, i) => ({
    i, text: 'a line of words here', section: 'Verse',
    words: [i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 3],
    start: i * 8, end: i * 8 + 5,
  }));
  const segments = segmentKinds.map((kind, i) => ({
    index: i, kind, label: kind[0].toUpperCase() + kind.slice(1),
    start: i * 40, end: (i + 1) * 40, lines: [], energy: 0.4 + i * 0.15,
    brightness: 0.5, repeat_of: null,
  }));
  return {
    alignment: {
      duration: 200, audio: audio(audioOverrides),
      words: Array.from({ length: lines * 4 }, (_, i) => ({ i, t: 'word', line: Math.floor(i / 4) })),
      lines: alignmentLines,
      segments,
    },
    lyricsText,
  };
}

/* --------------------------------- mood ---------------------------------- */

test('reads a bleak lyric as low valence', () => {
  const read = readLyrics('alone in the empty cold rain, everything I lost is gone');
  assert.ok(read.valence < -0.3, `valence was ${read.valence}`);
  assert.ok(read.confidence > 0.2);
});

test('reads a euphoric lyric as high valence and arousal', () => {
  const read = readLyrics('dance all night, we are alive and free, fire in the sky tonight');
  assert.ok(read.valence > 0.2, `valence was ${read.valence}`);
  assert.ok(read.arousal > 0.6, `arousal was ${read.arousal}`);
});

test('tempo drives energy more than words do', () => {
  const slow = deriveMood({ audio: audio({ tempo: 62 }), lyricsText: 'fire burn wild run tonight' });
  const fast = deriveMood({ audio: audio({ tempo: 168 }), lyricsText: 'quiet calm still rest slow' });
  assert.ok(fast.energy > slow.energy, `${fast.energy} should exceed ${slow.energy}`);
});

test('the user\'s own mood words are never diluted', () => {
  const mood = deriveMood({
    audio: audio({ tempo: 170 }),
    lyricsText: 'rage fight scream war blood',
    userMoods: ['tender', 'intimate', 'acoustic'],
  });
  assert.deepEqual(mood.words, ['tender', 'intimate', 'acoustic']);
});

/* ------------------------------ lyric modes ------------------------------ */

test('dense lyrics never get one-word-at-a-time', () => {
  const template = TEMPLATES_BY_ID.neon; // supports karaoke, wordPop, hero
  // 40 words in 5 seconds is a rap verse.
  const lines = [{ i: 0, words: Array.from({ length: 40 }, (_, i) => i), start: 0, end: 5, text: 'x' }];
  const mode = chooseLyricMode({ template, lines, duration: 5 });
  assert.notEqual(mode, 'wordPop');
  assert.notEqual(mode, 'hero');
});

test('sparse lyrics get the big treatment', () => {
  const template = TEMPLATES_BY_ID.kinetic; // wordPop, hero, karaoke
  const lines = Array.from({ length: 4 }, (_, i) => ({
    i, words: [0, 1, 2], start: i * 12, end: i * 12 + 6, text: 'few words here',
  }));
  const mode = chooseLyricMode({ template, lines, duration: 48 });
  assert.ok(['hero', 'wordPop'].includes(mode), `got ${mode}`);
});

test('a forced mode the template cannot do is refused', () => {
  const template = TEMPLATES_BY_ID.editorial;
  const lines = [{ i: 0, words: [0, 1], start: 0, end: 4, text: 'x' }];
  const mode = chooseLyricMode({ template, lines, duration: 10, forced: 'hero' });
  assert.ok(template.lyricModes.includes(mode));
});

/* --------------------------------- cues ---------------------------------- */

test('choruses escalate each time they come back', () => {
  const segments = [
    { index: 0, kind: 'chorus', energy: 0.8, duration: 20 },
    { index: 1, kind: 'verse', energy: 0.5, duration: 20 },
    { index: 2, kind: 'chorus', energy: 0.8, duration: 20 },
    { index: 3, kind: 'chorus', energy: 0.8, duration: 20 },
  ];
  const cues = buildCues({ segments, mood: { energy: 0.6 }, audio: audio() });
  const choruses = [0, 2, 3].map((i) => cues[i].intensity);
  assert.ok(choruses[1] > choruses[0], 'second chorus should be bigger');
  assert.ok(choruses[2] >= choruses[1], 'third should not shrink');
  assert.ok(cues[2].accentShift > 0, 'later choruses shift hue');
});

test('an instrumental before a chorus builds, one before a verse does not', () => {
  const intoChorus = buildCues({
    segments: [
      { index: 0, kind: 'break', energy: 0.5, duration: 15 },
      { index: 1, kind: 'chorus', energy: 0.9, duration: 20 },
    ],
    mood: { energy: 0.6 }, audio: audio(),
  });
  assert.equal(intoChorus[0].treatment, 'build');

  const intoVerse = buildCues({
    segments: [
      { index: 0, kind: 'break', energy: 0.5, duration: 15 },
      { index: 1, kind: 'verse', energy: 0.5, duration: 20 },
    ],
    mood: { energy: 0.6 }, audio: audio(),
  });
  assert.notEqual(intoVerse[0].treatment, 'build');
});

test('bridges strip the background back', () => {
  const cues = buildCues({
    segments: [{ index: 0, kind: 'bridge', energy: 0.4, duration: 20 }],
    mood: { energy: 0.5 }, audio: audio(),
  });
  assert.equal(cues[0].treatment, 'strip');
});

/* ------------------------------ end to end -------------------------------- */

test('produces a complete, valid plan with no preferences at all', () => {
  const { alignment, lyricsText } = song();
  const { plan } = directDeterministic({ alignment, lyricsText, prefs: {} });

  assert.ok(TEMPLATES_BY_ID[plan.template]);
  assert.equal(plan.cues.length, alignment.segments.length);
  assert.ok(plan.palette.bg.length >= 2);
  assert.ok(plan.notes.length > 0);
  assert.equal(plan.source, 'deterministic');
  assert.ok(TEMPLATES_BY_ID[plan.template].lyricModes.includes(plan.lyrics.mode));
});

test('honours an explicitly chosen template and palette', () => {
  const { alignment, lyricsText } = song();
  const { plan } = directDeterministic({
    alignment, lyricsText,
    prefs: { template: 'neon', palette: 'ember', font: 'oswald' },
  });
  assert.equal(plan.template, 'neon');
  assert.equal(plan.palette.id, 'ember');
  assert.equal(plan.typography.font, 'oswald');
});

test('a font that lacks the template weight is not asked for a fake bold', () => {
  const { alignment, lyricsText } = song();
  // Neon wants weight 700; Anton only ships 400.
  const { plan } = directDeterministic({
    alignment, lyricsText, prefs: { template: 'neon', font: 'anton' },
  });
  assert.equal(plan.typography.weight, 400);
});

test('a photo-first template is not chosen on a whim', () => {
  // Nothing in these words points at nostalgia, so the photo penalty should
  // be decisive and Filmstrip should lose.
  const { alignment, lyricsText } = song({ lyricsText: 'electric lights, we run all night, louder' });
  const plan = directDeterministic({ alignment, lyricsText, prefs: {} }).plan;
  assert.notEqual(plan.template, 'filmstrip');
});

test('a strongly nostalgic song may still pick Filmstrip, and it must hold up empty', () => {
  // Every mood word here is an exact Filmstrip tag, and it does have a
  // no-photograph look (a projected film gate), so choosing it is correct —
  // what must not happen is a plan that quietly assumes pictures exist.
  const { alignment, lyricsText } = song({
    lyricsText: 'a photograph of a memory, the radio and the rain, a vintage kind of sad',
  });
  const plan = directDeterministic({ alignment, lyricsText, prefs: {} }).plan;
  assert.equal(plan.photos.enabled, false);
  assert.ok(plan.background.intensity > 0.2, 'the background has to carry the frame alone');
  assert.equal(plan.cues.length, alignment.segments.length);
});

test('supplying pictures turns them on', () => {
  const { alignment, lyricsText } = song({ lyricsText: 'a photograph of a memory, the radio and the rain' });
  const plan = directDeterministic({ alignment, lyricsText, prefs: { photoCount: 4 } }).plan;
  assert.equal(plan.photos.enabled, true);
  assert.ok(plan.background.scrim >= 0.4, 'type over photographs needs a scrim');
});

test('the title card only appears when there is room for it', () => {
  const early = song();
  early.alignment.lines[0].start = 0.3;
  const noRoom = directDeterministic({ ...early, prefs: { title: 'Song' } }).plan;
  assert.equal(noRoom.title.show, false);

  const late = song();
  for (const line of late.alignment.lines) { line.start += 12; line.end += 12; }
  const roomy = directDeterministic({ ...late, prefs: { title: 'Song' } }).plan;
  assert.equal(roomy.title.show, true);
  assert.ok(roomy.title.holdUntil > 1);
});
