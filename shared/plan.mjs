/**
 * The video plan: the single document that fully describes a render.
 *
 * Everything upstream (audio analysis, lyric structure, user preferences, the
 * language model) converges into a plan. Everything downstream (preview,
 * encode) reads only a plan. That boundary is what makes the preview an
 * honest preview — it is not an approximation of the render, it is the render
 * with a different sink.
 *
 * `normalisePlan` is the gate. Nothing becomes a plan without going through
 * it, because one of its inputs is a language model and the renderer must
 * never be handed a number it did not expect.
 */

import { TEMPLATES_BY_ID, FONTS_BY_ID, ASPECTS, LYRIC_MODES } from './templates.mjs';
import { PALETTES_BY_ID, ensureContrast } from './palettes.mjs';

export const PLAN_VERSION = 1;

/**
 * How a section behaves. A fixed vocabulary, because these are implemented
 * one by one in the renderer — an unknown treatment must degrade to `drift`
 * rather than produce a blank frame.
 */
export const CUE_TREATMENTS = {
  still: 'Almost motionless. Space and restraint.',
  drift: 'Gentle continuous movement. The default.',
  build: 'Intensity climbs steadily across the section.',
  surge: 'Everything at full power, reacting hard to the beat.',
  strip: 'Background stripped back to flat colour. Type carries it alone.',
  bloom: 'Soft focus, heavy glow, edges dissolving.',
  flicker: 'Unstable and cut-up. Hard changes on the beat.',
};

export const HIGHLIGHT_STYLES = ['fill', 'glow', 'scale', 'underline', 'none'];
export const TEXT_CASES = ['upper', 'sentence', 'as-is'];
export const ALIGNMENTS = ['left', 'center', 'right'];
export const PHOTO_TREATMENTS = ['kenburns', 'flash', 'ghost', 'blend', 'plate'];
export const PHOTO_CHANGE = ['section', 'line', 'downbeat', 'slow'];
export const TITLE_STYLES = ['stamp', 'fade', 'slide', 'none'];
export const RESOLUTIONS = [720, 1080];
export const FPS_CHOICES = [24, 30, 60];

/* --------------------------------- utils -------------------------------- */

const clamp = (v, lo, hi, fallback) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

const pick = (v, allowed, fallback) =>
  (typeof v === 'string' && allowed.includes(v) ? v : fallback);

const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

const isHex = (v) => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());

const hex = (v, fallback) => (isHex(v) ? v.trim().toLowerCase() : fallback);

const str = (v, max, fallback = '') =>
  (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : fallback);

/* ------------------------------- the plan ------------------------------- */

export function defaultPlan() {
  const template = TEMPLATES_BY_ID.aurora;
  const palette = PALETTES_BY_ID.midnight;
  return {
    version: PLAN_VERSION,
    template: template.id,
    aspect: '16:9',
    resolution: 1080,
    fps: 30,

    mood: { words: ['calm'], energy: 0.5, warmth: 0.5, brightness: 0.5 },

    palette: {
      id: palette.id,
      bg: [...palette.bg],
      fg: palette.fg,
      dim: palette.dim,
      accent: palette.accent,
      accent2: palette.accent2,
      glow: palette.glow,
    },

    typography: {
      font: template.typography.font,
      case: template.typography.case,
      weight: template.typography.weight,
      align: template.typography.align,
      tracking: template.typography.tracking,
      scale: 1,
    },

    lyrics: {
      mode: template.defaultLyricMode,
      linesVisible: 2,
      highlight: 'fill',
      maxWordsPerCard: 9,
    },

    background: {
      intensity: 0.6,
      grain: 0.15,
      vignette: 0.35,
      motion: 0.5,
      scrim: 0.35,
    },

    photos: {
      enabled: false,
      treatment: 'kenburns',
      opacity: 0.7,
      tint: 0.4,
      changeOn: 'section',
    },

    reactivity: {
      pulse: template.motion.pulse,
      flash: 0.3,
      shake: 0.1,
      cutOnDownbeat: template.motion.cuts,
    },

    title: { show: true, title: '', artist: '', style: 'fade', holdUntil: 0 },

    cues: [],
    notes: '',
    source: 'default',
  };
}

/**
 * Coerce anything into a valid plan.
 *
 * `base` is the plan to fall back to field by field — usually the
 * deterministic plan, so a language model that returns three sensible fields
 * and garbage for the rest still improves the result instead of wrecking it.
 */
export function normalisePlan(raw, { base = defaultPlan(), segments = [] } = {}) {
  const warnings = [];
  const input = raw && typeof raw === 'object' ? raw : {};
  const note = (msg) => { if (warnings.length < 24) warnings.push(msg); };

  const template = TEMPLATES_BY_ID[input.template] ? input.template : base.template;
  if (input.template && template !== input.template) note(`unknown template "${input.template}"`);
  const tpl = TEMPLATES_BY_ID[template];

  const plan = {
    version: PLAN_VERSION,
    template,
    aspect: pick(input.aspect, Object.keys(ASPECTS), base.aspect),
    resolution: RESOLUTIONS.includes(input.resolution) ? input.resolution : base.resolution,
    fps: FPS_CHOICES.includes(input.fps) ? input.fps : base.fps,
  };

  /* mood ---------------------------------------------------------------- */
  const moodIn = input.mood || {};
  plan.mood = {
    words: Array.isArray(moodIn.words)
      ? moodIn.words.filter((w) => typeof w === 'string').map((w) => str(w, 24)).filter(Boolean).slice(0, 6)
      : base.mood.words,
    energy: clamp(moodIn.energy, 0, 1, base.mood.energy),
    warmth: clamp(moodIn.warmth, 0, 1, base.mood.warmth),
    brightness: clamp(moodIn.brightness, 0, 1, base.mood.brightness),
  };

  /* palette ------------------------------------------------------------- */
  const palIn = input.palette || {};
  const named = PALETTES_BY_ID[palIn.id];
  const palBase = named
    ? { id: named.id, bg: [...named.bg], fg: named.fg, dim: named.dim, accent: named.accent, accent2: named.accent2, glow: named.glow }
    : base.palette;

  const bg = Array.isArray(palIn.bg) && palIn.bg.length >= 2 && palIn.bg.every(isHex)
    ? palIn.bg.slice(0, 3).map((c) => hex(c, palBase.bg[0]))
    : [...palBase.bg];

  plan.palette = {
    id: palBase.id,
    bg,
    fg: hex(palIn.fg, palBase.fg),
    dim: hex(palIn.dim, palBase.dim),
    accent: hex(palIn.accent, palBase.accent),
    accent2: hex(palIn.accent2, palBase.accent2),
    glow: hex(palIn.glow, palBase.glow),
  };

  // Legibility is not negotiable, and it is exactly the thing a language
  // model gets wrong when it picks colours by vibe.
  const darkest = plan.palette.bg[0];
  const fgFixed = ensureContrast(plan.palette.fg, darkest, 7);
  if (fgFixed !== plan.palette.fg) {
    note('lyric colour was too close to the background; lightened it');
    plan.palette.fg = fgFixed;
  }
  const accentFixed = ensureContrast(plan.palette.accent, darkest, 4.5);
  if (accentFixed !== plan.palette.accent) {
    note('accent colour was too close to the background; lightened it');
    plan.palette.accent = accentFixed;
  }

  /* typography ---------------------------------------------------------- */
  const typoIn = input.typography || {};
  const font = FONTS_BY_ID[typoIn.font] ? typoIn.font : base.typography.font;
  if (typoIn.font && font !== typoIn.font) note(`unknown font "${typoIn.font}"`);
  const fontDef = FONTS_BY_ID[font];
  const requestedWeight = Number.parseInt(typoIn.weight, 10);
  plan.typography = {
    font,
    case: pick(typoIn.case, TEXT_CASES, base.typography.case),
    // Only weights we actually shipped a file for; asking for 700 of a
    // single-weight display face gives a synthesised bold that looks broken.
    weight: fontDef.weights.includes(requestedWeight) ? requestedWeight : fontDef.weights[0],
    align: pick(typoIn.align, ALIGNMENTS, base.typography.align),
    tracking: clamp(typoIn.tracking, -0.05, 0.25, base.typography.tracking),
    scale: clamp(typoIn.scale, 0.6, 1.6, base.typography.scale),
  };

  /* lyric behaviour ------------------------------------------------------ */
  const lyrIn = input.lyrics || {};
  let mode = pick(lyrIn.mode, Object.values(LYRIC_MODES), base.lyrics.mode);
  if (!tpl.lyricModes.includes(mode)) {
    if (lyrIn.mode) note(`${tpl.name} does not support "${mode}"; used ${tpl.defaultLyricMode}`);
    mode = tpl.lyricModes.includes(base.lyrics.mode) ? base.lyrics.mode : tpl.defaultLyricMode;
  }
  plan.lyrics = {
    mode,
    linesVisible: clamp(Math.round(lyrIn.linesVisible), 1, 4, base.lyrics.linesVisible),
    highlight: pick(lyrIn.highlight, HIGHLIGHT_STYLES, base.lyrics.highlight),
    maxWordsPerCard: clamp(Math.round(lyrIn.maxWordsPerCard), 3, 16, base.lyrics.maxWordsPerCard),
  };

  /* background ----------------------------------------------------------- */
  const bgIn = input.background || {};
  plan.background = {
    intensity: clamp(bgIn.intensity, 0, 1, base.background.intensity),
    grain: clamp(bgIn.grain, 0, 0.6, base.background.grain),
    vignette: clamp(bgIn.vignette, 0, 1, base.background.vignette),
    motion: clamp(bgIn.motion, 0, 1, base.background.motion),
    scrim: clamp(bgIn.scrim, 0, 0.85, base.background.scrim),
  };

  /* photos --------------------------------------------------------------- */
  const phIn = input.photos || {};
  plan.photos = {
    enabled: bool(phIn.enabled, base.photos.enabled),
    treatment: pick(phIn.treatment, PHOTO_TREATMENTS, base.photos.treatment),
    opacity: clamp(phIn.opacity, 0.1, 1, base.photos.opacity),
    tint: clamp(phIn.tint, 0, 1, base.photos.tint),
    changeOn: pick(phIn.changeOn, PHOTO_CHANGE, base.photos.changeOn),
  };

  /* reactivity ----------------------------------------------------------- */
  const reIn = input.reactivity || {};
  plan.reactivity = {
    pulse: clamp(reIn.pulse, 0, 1, base.reactivity.pulse),
    flash: clamp(reIn.flash, 0, 1, base.reactivity.flash),
    shake: clamp(reIn.shake, 0, 0.5, base.reactivity.shake),
    cutOnDownbeat: bool(reIn.cutOnDownbeat, base.reactivity.cutOnDownbeat),
  };

  /* title ---------------------------------------------------------------- */
  const tiIn = input.title || {};
  plan.title = {
    show: bool(tiIn.show, base.title.show),
    title: str(tiIn.title, 90, base.title.title),
    artist: str(tiIn.artist, 90, base.title.artist),
    style: pick(tiIn.style, TITLE_STYLES, base.title.style),
    holdUntil: clamp(tiIn.holdUntil, 0, 60, base.title.holdUntil),
  };

  /* cues ----------------------------------------------------------------- */
  const cuesIn = Array.isArray(input.cues) ? input.cues : [];
  const byIndex = new Map();
  for (const cue of cuesIn.slice(0, 64)) {
    if (!cue || typeof cue !== 'object') continue;
    const idx = Number.parseInt(cue.segment, 10);
    if (!Number.isInteger(idx) || idx < 0 || (segments.length && idx >= segments.length)) {
      note(`cue for segment ${cue.segment} does not exist`);
      continue;
    }
    const cueMode = pick(cue.lyricMode, Object.values(LYRIC_MODES), null);
    byIndex.set(idx, {
      segment: idx,
      treatment: pick(cue.treatment, Object.keys(CUE_TREATMENTS), 'drift'),
      intensity: clamp(cue.intensity, 0, 1, 0.5),
      lyricMode: cueMode && tpl.lyricModes.includes(cueMode) ? cueMode : null,
      accentShift: clamp(cue.accentShift, -0.5, 0.5, 0),
      note: str(cue.note, 120),
    });
  }

  // A cue per segment, always — the renderer should never have to ask
  // "what happens here?" and get no answer.
  plan.cues = segments.length
    ? segments.map((_, i) => byIndex.get(i) || (base.cues && base.cues[i]) || {
        segment: i, treatment: 'drift', intensity: 0.5, lyricMode: null, accentShift: 0, note: '',
      })
    : [...byIndex.values()].sort((a, b) => a.segment - b.segment);

  plan.notes = str(input.notes, 600, base.notes);
  plan.source = str(input.source, 24, base.source || 'default');

  return { plan, warnings };
}
