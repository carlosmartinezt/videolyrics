/**
 * The deterministic director.
 *
 * Reads the alignment result, the audio analysis and whatever the user asked
 * for, and composes a complete video plan — no network, no model, no
 * randomness that isn't seeded by the song itself.
 *
 * This is not a fallback. It is the baseline the language model is asked to
 * *improve on*, and it has to be good enough to ship alone, because it runs
 * on every job and the model layer is optional.
 */

import { TEMPLATES, TEMPLATES_BY_ID, FONTS_BY_ID } from '../../shared/templates.mjs';
import { PALETTES, PALETTES_BY_ID, scorePalette, hexToRgb, rgbToHsl } from '../../shared/palettes.mjs';
import { defaultPlan, normalisePlan } from '../../shared/plan.mjs';
import { readLyrics } from './lexicon.mjs';

/* ------------------------------- mood ----------------------------------- */

/**
 * Combine what the music sounds like with what the words say.
 *
 * Music wins on arousal — a slow sad song about fire is still slow — and
 * lyrics win on valence, because tempo tells you nothing about whether a
 * major-key 128 BPM track is euphoric or bitter.
 */
export function deriveMood({ audio, lyricsText, userMoods = [] }) {
  const read = readLyrics(lyricsText);

  const tempo = audio.tempo || 100;
  const meanLoud = mean(audio.loudness) || 0.5;
  const meanBright = mean(audio.brightness) || 0.5;

  // Tempo maps to arousal with a knee: below 70 BPM everything reads slow,
  // above 150 the extra speed stops adding perceived energy.
  const tempoEnergy = clamp01((tempo - 65) / 85);
  const onsetDensity = clamp01((audio.onsets?.length || 0) / Math.max(1, audio.duration) / 4);
  const musicalEnergy = clamp01(tempoEnergy * 0.45 + meanLoud * 0.3 + onsetDensity * 0.25);

  const energy = clamp01(musicalEnergy * 0.7 + read.arousal * 0.3 * read.confidence + musicalEnergy * 0.3 * (1 - read.confidence));
  const valence = read.confidence > 0.15
    ? read.valence
    : (audio.mode === 'major' ? 0.25 : -0.25) * (audio.key_confidence ?? 0.5);

  const warmth = clamp01(0.5 + valence * 0.35 + (audio.mode === 'major' ? 0.1 : -0.1));
  const brightness = clamp01(meanBright * 0.6 + (valence + 1) / 2 * 0.4);

  const words = new Set(userMoods.map((w) => String(w).toLowerCase().trim()).filter(Boolean));

  // Only add derived words when the user gave us little to go on, so their
  // stated intent is never diluted by our guesswork.
  if (words.size < 3) {
    if (energy > 0.68) words.add('energetic');
    else if (energy < 0.3) words.add('calm');
    if (valence > 0.3) words.add(energy > 0.6 ? 'euphoric' : 'hopeful');
    else if (valence < -0.3) words.add(energy > 0.6 ? 'intense' : 'melancholy');
    if (audio.mode === 'minor' && valence <= 0) words.add('dark');
    if (brightness < 0.35) words.add('cold');
    for (const tag of read.tags) { if (words.size < 6) words.add(tag); }
  }

  return {
    words: [...words].slice(0, 6),
    energy: round(energy),
    warmth: round(warmth),
    brightness: round(brightness),
    valence: round(valence),
    lyricConfidence: round(read.confidence),
  };
}

/* ------------------------------ template -------------------------------- */

export function chooseTemplate({ mood, audio, hasPhotos, forced }) {
  if (forced && TEMPLATES_BY_ID[forced]) return TEMPLATES_BY_ID[forced];

  const tempo = audio.tempo || 100;
  let best = TEMPLATES[0];
  let bestScore = -Infinity;

  for (const tpl of TEMPLATES) {
    let score = 0;
    for (const word of mood.words) {
      if (tpl.moods.includes(word)) score += 3;
      else if (tpl.moods.some((m) => m.includes(word) || word.includes(m))) score += 1;
    }

    // Energy affinity: how fast does this template want to move?
    const pace = { slow: 0.2, medium: 0.55, fast: 0.9 }[tpl.motion.pace] ?? 0.5;
    score += (1 - Math.abs(pace - mood.energy)) * 2.5;

    const [lo, hi] = tpl.tempoRange;
    if (tempo < lo || tempo > hi) score -= 2;

    if (hasPhotos) {
      if (tpl.usesPhotos === 'preferred') score += 3;
      else if (tpl.usesPhotos === 'optional') score += 0.5;
    } else if (tpl.usesPhotos === 'preferred') {
      // A photo-first template with no photographs still renders — Filmstrip
      // falls back to a projected film gate — but it is never the best answer
      // when something built for an empty frame is available. The penalty has
      // to outweigh a couple of mood matches, or "preferred" means nothing:
      // lyrics mentioning a photograph would pick Filmstrip on vocabulary
      // alone, which is how the first version of this got it wrong.
      score -= 4.5;
    }

    if (score > bestScore) { bestScore = score; best = tpl; }
  }
  return best;
}

/* ------------------------------- palette -------------------------------- */

/**
 * Pick a palette, then bend it towards the user's own colours.
 *
 * Inspiration images are reduced to a handful of dominant colours *in the
 * browser* and posted as hex — the pictures themselves never reach the
 * server. We use those hues to shift the accent, not to replace the palette,
 * because a photograph's dominant colour is very often mud.
 */
export function choosePalette({ mood, imageColors = [], forced }) {
  let chosen = PALETTES_BY_ID[forced];

  if (!chosen) {
    let bestScore = -Infinity;
    for (const palette of PALETTES) {
      let score = scorePalette(palette, mood.words);

      const bgHsl = rgbToHsl(hexToRgb(palette.bg[1] || palette.bg[0]));
      const accentHsl = rgbToHsl(hexToRgb(palette.accent));
      // Warm palettes for warm moods: hue 0-0.12 and 0.9-1 is red/orange.
      const paletteWarmth = isWarmHue(accentHsl.h) ? 0.75 : 0.25;
      score += (1 - Math.abs(paletteWarmth - mood.warmth)) * 1.5;
      score += (1 - Math.abs(bgHsl.l * 2.2 - mood.brightness)) * 0.8;
      score += (1 - Math.abs(accentHsl.s - (0.4 + mood.energy * 0.5))) * 1.2;

      if (imageColors.length) {
        score += hueAffinity(palette.accent, imageColors) * 2;
      }
      if (score > bestScore) { bestScore = score; chosen = palette; }
    }
  }

  const palette = {
    id: chosen.id,
    bg: [...chosen.bg],
    fg: chosen.fg,
    dim: chosen.dim,
    accent: chosen.accent,
    accent2: chosen.accent2,
    glow: chosen.glow,
  };

  // Borrow the most saturated image colour as the secondary accent, which is
  // where a bit of the user's own world shows up without risking legibility.
  const vivid = mostVivid(imageColors);
  if (vivid) palette.accent2 = vivid;

  return palette;
}

function isWarmHue(h) { return h < 0.12 || h > 0.88 || (h > 0.05 && h < 0.19); }

function hueAffinity(hex, colors) {
  const target = rgbToHsl(hexToRgb(hex)).h;
  let best = 0;
  for (const c of colors) {
    const { h, s } = rgbToHsl(hexToRgb(c));
    if (s < 0.15) continue;
    const d = Math.abs(h - target);
    best = Math.max(best, 1 - Math.min(d, 1 - d) * 2);
  }
  return best;
}

function mostVivid(colors) {
  let best = null;
  let bestScore = 0.3; // ignore anything muddier than this
  for (const c of colors) {
    const { s, l } = rgbToHsl(hexToRgb(c));
    const score = s * (1 - Math.abs(l - 0.55) * 1.4);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/* ---------------------------- lyric behaviour ---------------------------- */

/**
 * Word density decides how the lyrics can be presented.
 *
 * A rap verse at six words a second cannot use one-word-at-a-time without
 * becoming a strobe; a ballad with four words in eight seconds looks empty in
 * a scrolling column. So the *user's* choice of template gives us a shortlist
 * and the song picks from it.
 */
export function chooseLyricMode({ template, lines, duration, forced }) {
  if (forced && template.lyricModes.includes(forced)) return forced;

  const sung = lines.reduce((n, l) => n + l.words.length, 0);
  const sungTime = lines.reduce((t, l) => t + Math.max(0, l.end - l.start), 0) || duration || 1;
  const wordsPerSecond = sung / sungTime;
  const meanLineWords = sung / Math.max(1, lines.length);

  const prefer = (...modes) => modes.find((m) => template.lyricModes.includes(m));

  if (wordsPerSecond > 3.4) {
    // Very dense: only whole-line presentations stay readable.
    return prefer('cascade', 'karaoke', 'lineFade') || template.defaultLyricMode;
  }
  if (wordsPerSecond < 0.9 && meanLineWords <= 5) {
    return prefer('hero', 'wordPop', 'lineFade') || template.defaultLyricMode;
  }
  if (wordsPerSecond < 1.8) {
    return prefer('wordPop', 'karaoke', 'lineFade') || template.defaultLyricMode;
  }
  return prefer('karaoke', 'lineFade', 'cascade') || template.defaultLyricMode;
}

/* -------------------------------- cues ---------------------------------- */

/**
 * One cue per segment: the shot list.
 *
 * The rules are the boring ones a human would apply — quiet at the start,
 * biggest at the loudest chorus, pull the background away under the bridge,
 * dissolve at the end — plus one that matters more than it sounds:
 * repeated choruses escalate. A chorus that looks identical the third time is
 * what makes these videos feel automated.
 */
export function buildCues({ segments, mood, audio }) {
  const loudest = Math.max(0.001, ...segments.map((s) => s.energy));
  const chorusOrdinals = new Map();
  let chorusCount = 0;

  return segments.map((seg, i) => {
    const relative = seg.energy / loudest;
    const next = segments[i + 1];
    let treatment = 'drift';
    let intensity = 0.35 + relative * 0.4;
    let note = '';

    switch (seg.kind) {
      case 'intro':
        treatment = mood.energy > 0.7 ? 'build' : 'still';
        intensity = 0.2 + mood.energy * 0.2;
        note = 'Hold back. Let the title land before anything moves.';
        break;

      case 'break':
        // An instrumental that leads into a chorus is a run-up, not a rest.
        if (next && next.kind === 'chorus') {
          treatment = 'build';
          intensity = 0.5 + relative * 0.35;
          note = 'Ramp into the chorus.';
        } else {
          treatment = seg.duration > 12 ? 'bloom' : 'drift';
          intensity = 0.3 + relative * 0.25;
          note = 'Instrumental. Breathe.';
        }
        break;

      case 'chorus': {
        chorusCount += 1;
        chorusOrdinals.set(i, chorusCount);
        treatment = 'surge';
        // Each return of the chorus is bigger than the last, capped so the
        // final one still has somewhere to go.
        const escalation = Math.min(0.22, (chorusCount - 1) * 0.09);
        intensity = Math.min(1, 0.62 + relative * 0.25 + escalation);
        note = chorusCount === 1 ? 'First chorus. Open it up.' : `Chorus ${chorusCount}. Bigger than the last.`;
        break;
      }

      case 'bridge':
        treatment = 'strip';
        intensity = 0.3 + relative * 0.2;
        note = 'Strip it back so the change registers.';
        break;

      case 'outro':
        treatment = 'bloom';
        intensity = Math.max(0.12, 0.4 - (i / segments.length) * 0.1);
        note = 'Dissolve.';
        break;

      default: // verse
        treatment = relative > 0.82 && mood.energy > 0.65 ? 'flicker' : 'drift';
        intensity = 0.32 + relative * 0.34;
        note = 'Keep it moving, keep it readable.';
    }

    // Rotate the accent hue a little on later choruses so the escalation is
    // visible in colour and not only in amplitude.
    const ordinal = chorusOrdinals.get(i) || 0;
    const accentShift = ordinal > 1 ? Math.min(0.16, (ordinal - 1) * 0.06) : 0;

    return {
      segment: i,
      treatment,
      intensity: round(clamp01(intensity)),
      lyricMode: null,
      accentShift: round(accentShift),
      note,
    };
  });
}

/* ------------------------------ the whole ------------------------------- */

export function directDeterministic({ alignment, lyricsText, prefs = {}, watermark = null }) {
  const audio = alignment.audio || {};
  const segments = alignment.segments || [];
  const lines = alignment.lines || [];
  const duration = alignment.duration || audio.duration || 1;

  const mood = deriveMood({ audio, lyricsText, userMoods: prefs.moods || [] });
  const hasPhotos = Number(prefs.photoCount || 0) > 0;

  const template = chooseTemplate({ mood, audio, hasPhotos, forced: prefs.template });
  const palette = choosePalette({ mood, imageColors: prefs.imageColors || [], forced: prefs.palette });
  const lyricMode = chooseLyricMode({ template, lines, duration, forced: prefs.lyricMode });

  const font = FONTS_BY_ID[prefs.font] ? prefs.font : template.typography.font;

  // How long before the first word? That window is the title card's budget.
  const firstWord = lines.length ? lines[0].start : 0;
  const titleWindow = Math.max(0, firstWord - 0.4);

  const base = defaultPlan();
  const draft = {
    ...base,
    template: template.id,
    aspect: prefs.aspect || base.aspect,
    resolution: prefs.resolution || base.resolution,
    fps: prefs.fps || base.fps,

    mood: {
      words: mood.words,
      energy: mood.energy,
      warmth: mood.warmth,
      brightness: mood.brightness,
    },

    palette,

    typography: {
      font,
      case: template.typography.case,
      weight: FONTS_BY_ID[font].weights.includes(template.typography.weight)
        ? template.typography.weight
        : FONTS_BY_ID[font].weights[0],
      align: template.typography.align,
      tracking: template.typography.tracking,
      // Sparse lyrics can afford to be larger; dense ones must not collide.
      scale: clamp(0.85 + (1 - Math.min(1, meanLineLength(lines) / 42)) * 0.3, 0.75, 1.25),
    },

    lyrics: {
      mode: lyricMode,
      linesVisible: lyricMode === 'cascade' ? 3 : lyricMode === 'hero' ? 1 : 2,
      highlight: mood.energy > 0.6 ? 'glow' : 'fill',
      maxWordsPerCard: meanLineLength(lines) > 34 ? 12 : 9,
    },

    background: {
      intensity: round(0.35 + mood.energy * 0.45),
      grain: round(template.id === 'filmstrip' ? 0.3 : 0.1 + (1 - mood.brightness) * 0.12),
      vignette: round(0.25 + (1 - mood.brightness) * 0.3),
      motion: round(0.25 + mood.energy * 0.6),
      scrim: hasPhotos ? 0.45 : 0.3,
    },

    photos: {
      enabled: hasPhotos,
      treatment: template.photoTreatment,
      opacity: template.usesPhotos === 'preferred' ? 0.85 : 0.55,
      tint: round(0.25 + (1 - mood.brightness) * 0.35),
      changeOn: mood.energy > 0.75 ? 'downbeat' : 'section',
    },

    reactivity: {
      pulse: round(clamp01(template.motion.pulse * (0.6 + mood.energy * 0.7))),
      flash: round(clamp01(mood.energy * 0.55)),
      shake: round(clamp01(Math.max(0, mood.energy - 0.6) * 0.4)),
      cutOnDownbeat: template.motion.cuts && mood.energy > 0.45,
    },

    title: {
      show: prefs.title !== '' && titleWindow > 1.2,
      title: prefs.title || '',
      artist: prefs.artist || '',
      style: mood.energy > 0.65 ? 'stamp' : 'fade',
      holdUntil: round(Math.min(titleWindow, 9)),
    },

    cues: buildCues({ segments, mood, audio }),
    notes: describe({ mood, template, palette, audio, lyricMode }),
    source: 'deterministic',
  };

  if (watermark) draft.watermark = { ...base.watermark, ...watermark };

  const { plan } = normalisePlan(draft, { base: draft, segments });
  return { plan, mood };
}

function describe({ mood, template, palette, audio, lyricMode }) {
  const tempo = Math.round(audio.tempo || 0);
  return [
    `${tempo} BPM, ${audio.key || '?'} ${audio.mode || ''}`.trim() + '.',
    `Read as ${mood.words.slice(0, 3).join(', ')}.`,
    `${template.name} on ${PALETTES_BY_ID[palette.id]?.name || palette.id}, ${lyricMode} lyrics.`,
  ].join(' ');
}

/* -------------------------------- helpers -------------------------------- */

function meanLineLength(lines) {
  if (!lines.length) return 30;
  return lines.reduce((n, l) => n + (l.text?.length || 0), 0) / lines.length;
}

function mean(arr) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v) => Math.round(v * 1000) / 1000;
