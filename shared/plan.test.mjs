/**
 * `normalisePlan` is the only thing standing between a language model and the
 * renderer, so it gets tested like a security boundary rather than a helper.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalisePlan, defaultPlan, CUE_TREATMENTS } from './plan.mjs';
import { TEMPLATES_BY_ID } from './templates.mjs';
import { contrastRatio, ensureContrast, PALETTES } from './palettes.mjs';

const segments = Array.from({ length: 4 }, (_, i) => ({ index: i }));

test('passes a sane plan through untouched', () => {
  const base = defaultPlan();
  const { plan, warnings } = normalisePlan(base, { base, segments: [] });
  assert.equal(plan.template, base.template);
  assert.equal(plan.typography.font, base.typography.font);
  assert.deepEqual(warnings, []);
});

test('rejects unknown templates, fonts and treatments', () => {
  const base = defaultPlan();
  const { plan, warnings } = normalisePlan({
    template: 'holographic',
    typography: { font: 'comic-sans' },
    cues: [{ segment: 0, treatment: 'explode', intensity: 0.5 }],
  }, { base, segments });

  assert.equal(plan.template, base.template);
  assert.equal(plan.typography.font, base.typography.font);
  assert.equal(plan.cues[0].treatment, 'drift');
  assert.ok(warnings.some((w) => w.includes('holographic')));
  assert.ok(warnings.some((w) => w.includes('comic-sans')));
});

test('clamps every numeric field into range', () => {
  const base = defaultPlan();
  const { plan } = normalisePlan({
    background: { intensity: 99, grain: -4, vignette: 'lots', motion: NaN, scrim: 12 },
    reactivity: { pulse: 5, flash: -1, shake: 3 },
    typography: { tracking: 40, scale: 0 },
    lyrics: { linesVisible: 99, maxWordsPerCard: -3 },
  }, { base, segments: [] });

  assert.equal(plan.background.intensity, 1);
  assert.equal(plan.background.grain, 0);
  assert.equal(plan.background.vignette, base.background.vignette, 'garbage falls back');
  assert.equal(plan.background.motion, base.background.motion, 'NaN falls back');
  assert.equal(plan.background.scrim, 0.85);
  assert.equal(plan.reactivity.pulse, 1);
  assert.equal(plan.reactivity.shake, 0.5);
  assert.equal(plan.typography.tracking, 0.25);
  assert.equal(plan.typography.scale, 0.6);
  assert.equal(plan.lyrics.linesVisible, 4);
  assert.equal(plan.lyrics.maxWordsPerCard, 3);
});

test('only accepts lyric modes the chosen template implements', () => {
  const base = defaultPlan();
  // Editorial has no wordPop.
  const { plan, warnings } = normalisePlan(
    { template: 'editorial', lyrics: { mode: 'wordPop' } },
    { base, segments: [] },
  );
  assert.ok(TEMPLATES_BY_ID.editorial.lyricModes.includes(plan.lyrics.mode));
  assert.notEqual(plan.lyrics.mode, 'wordPop');
  assert.ok(warnings.some((w) => w.includes('wordPop')));
});

test('forces legible lyric colour even when asked for the opposite', () => {
  const base = defaultPlan();
  const { plan, warnings } = normalisePlan({
    palette: { bg: ['#101010', '#151515'], fg: '#141414', accent: '#161616' },
  }, { base, segments: [] });

  assert.ok(
    contrastRatio(plan.palette.fg, plan.palette.bg[0]) >= 7,
    `expected >=7:1, got ${contrastRatio(plan.palette.fg, plan.palette.bg[0]).toFixed(1)}`,
  );
  assert.ok(contrastRatio(plan.palette.accent, plan.palette.bg[0]) >= 4.5);
  assert.ok(warnings.some((w) => w.includes('lyric colour')));
});

test('emits exactly one cue per segment, in order', () => {
  const base = defaultPlan();
  const { plan } = normalisePlan({
    cues: [
      { segment: 3, treatment: 'surge', intensity: 0.9 },
      { segment: 0, treatment: 'still', intensity: 0.2 },
      { segment: 47, treatment: 'surge' },
    ],
  }, { base, segments });

  assert.equal(plan.cues.length, segments.length);
  plan.cues.forEach((cue, i) => assert.equal(cue.segment, i));
  assert.equal(plan.cues[0].treatment, 'still');
  assert.equal(plan.cues[3].treatment, 'surge');
  assert.equal(plan.cues[1].treatment, 'drift', 'unmentioned segments get a default');
});

test('survives hostile input without throwing', () => {
  const base = defaultPlan();
  for (const nasty of [null, undefined, 42, 'a string', [], { cues: 'nope' },
    { palette: { bg: 'red' } }, { typography: null }, { cues: [null, 1, {}] }]) {
    const { plan } = normalisePlan(nasty, { base, segments });
    assert.equal(plan.version, 1);
    assert.ok(TEMPLATES_BY_ID[plan.template]);
    assert.equal(plan.cues.length, segments.length);
  }
});

test('every shipped palette is legible out of the box', () => {
  for (const palette of PALETTES) {
    const ratio = contrastRatio(palette.fg, palette.bg[0]);
    assert.ok(ratio >= 7, `${palette.id}: lyric colour is ${ratio.toFixed(1)}:1 on its own background`);
    const accent = contrastRatio(palette.accent, palette.bg[0]);
    assert.ok(accent >= 3, `${palette.id}: accent is ${accent.toFixed(1)}:1`);
  }
});

test('ensureContrast always reaches its target or goes monochrome', () => {
  for (const bg of ['#000000', '#ffffff', '#3d1a17', '#8fe5f5']) {
    const fixed = ensureContrast('#808080', bg, 7);
    assert.ok(contrastRatio(fixed, bg) >= 6.9, `${bg} -> ${fixed}`);
  }
});

test('the treatment vocabulary is closed', () => {
  const base = defaultPlan();
  for (const treatment of Object.keys(CUE_TREATMENTS)) {
    const { plan } = normalisePlan(
      { cues: [{ segment: 0, treatment }] }, { base, segments },
    );
    assert.equal(plan.cues[0].treatment, treatment);
  }
});
