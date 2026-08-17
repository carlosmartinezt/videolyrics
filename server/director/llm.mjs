/**
 * The language-model layer of the director.
 *
 * Strictly an *upgrade* pass. It receives the deterministic plan and the song
 * and returns a revised plan; anything it gets wrong is replaced field by
 * field with the deterministic value by `normalisePlan`. If the key is
 * missing, the request times out, or the JSON is unparseable, the job carries
 * on with the deterministic plan and says so in the UI.
 *
 * Providers are OpenAI-compatible chat completions, so DeepSeek, Moonshot
 * (Kimi) and anything else speaking that dialect work from the same code.
 */

import { TEMPLATES } from '../../shared/templates.mjs';
import { PALETTES } from '../../shared/palettes.mjs';
import { FONTS } from '../../shared/templates.mjs';
import { CUE_TREATMENTS, HIGHLIGHT_STYLES, TEXT_CASES, normalisePlan } from '../../shared/plan.mjs';

export const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  kimi: {
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2-0905-preview',
  },
};

const MAX_LYRIC_CHARS = 6000;
const REQUEST_TIMEOUT_MS = 45_000;

export function directorConfig(env = process.env) {
  const providerKey = (env.DIRECTOR_PROVIDER || 'deepseek').toLowerCase();
  const preset = PROVIDERS[providerKey] || PROVIDERS.deepseek;
  return {
    provider: providerKey,
    providerName: PROVIDERS[providerKey]?.name || providerKey,
    apiKey: env.DIRECTOR_API_KEY || '',
    baseUrl: (env.DIRECTOR_BASE_URL || preset.baseUrl).replace(/\/+$/, ''),
    model: env.DIRECTOR_MODEL || preset.model,
    enabled: Boolean(env.DIRECTOR_API_KEY),
  };
}

/* ------------------------------- prompting ------------------------------- */

function catalogue() {
  const templates = TEMPLATES.map(
    (t) => `- ${t.id}: ${t.blurb} Suits: ${t.moods.join(', ')}. Lyric modes: ${t.lyricModes.join(' | ')}.`
  ).join('\n');
  const palettes = PALETTES.map(
    (p) => `- ${p.id}: ${p.name}, ${p.moods.join('/')} (accent ${p.accent})`
  ).join('\n');
  const fonts = FONTS.map((f) => `- ${f.id}: ${f.name} (${f.flavour}, weights ${f.weights.join('/')})`).join('\n');
  const treatments = Object.entries(CUE_TREATMENTS).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return { templates, palettes, fonts, treatments };
}

const SYSTEM_PROMPT = `You are the art director for a lyric-video generator. You are given a song that has already been analysed — every word has a timestamp, the structure is known, and a competent baseline design has already been chosen. Your job is to make it better and more specific to THIS song.

You reply with a single JSON object and nothing else. Include only the fields you want to change from the baseline; anything you omit keeps its baseline value. Every value must come from the allowed vocabularies given to you — invented template ids, palette ids, fonts or treatments are discarded.

What good work looks like here:
- The design should feel like it was made for these words. If the song is about a specific image — rain, a car, a room, a city — the palette and template should acknowledge it.
- Sections must not all look the same. Use the cue list. Quiet openings, a bridge that changes the rules, choruses that grow each time they return.
- Restraint is a choice too. A tender acoustic song set to maximum reactivity is worse than one that barely moves.
- Contrast and legibility are enforced downstream; do not sacrifice readability for mood, it will just be corrected.

Never comment on the copyright status of the lyrics; you are describing visuals, not reproducing the song.`;

function buildUserPrompt({ alignment, lyricsText, plan, prefs, mood }) {
  const cat = catalogue();
  const audio = alignment.audio || {};
  const segments = alignment.segments || [];

  const structure = segments.map((s) => {
    const firstLine = s.lines.length ? alignment.lines[s.lines[0]]?.text : '(no words)';
    return `  ${s.index}. ${s.label} [${s.kind}] ${fmt(s.start)}–${fmt(s.end)} energy ${s.energy.toFixed(2)}${
      s.repeat_of != null ? ` (repeat of ${s.repeat_of})` : ''
    } — "${truncate(firstLine || '', 48)}"`;
  }).join('\n');

  const userAsk = [
    prefs.moods?.length ? `mood words: ${prefs.moods.join(', ')}` : null,
    prefs.template ? `they chose the ${prefs.template} template — keep it` : null,
    prefs.palette ? `they chose the ${prefs.palette} palette — keep it` : null,
    prefs.font ? `they chose the ${prefs.font} font — keep it` : null,
    prefs.imageColors?.length ? `colours pulled from their reference pictures: ${prefs.imageColors.join(', ')}` : null,
    prefs.photoCount ? `they uploaded ${prefs.photoCount} picture(s) to use in the video` : null,
    prefs.notes ? `their own note: "${truncate(prefs.notes, 300)}"` : null,
  ].filter(Boolean);

  return `SONG
Duration ${fmt(alignment.duration)}, ${Math.round(audio.tempo || 0)} BPM, key ${audio.key} ${audio.mode}.
Loudest moment at ${fmt(audio.peak_loudness_at || 0)}. ${segments.length} sections.
Alignment confidence: ${alignment.quality?.verdict || 'unknown'}.

STRUCTURE
${structure}

LYRICS
${truncate(lyricsText, MAX_LYRIC_CHARS)}

WHAT THE USER ASKED FOR
${userAsk.length ? userAsk.map((l) => `- ${l}`).join('\n') : '- nothing specific; it is all up to you'}

BASELINE PLAN (already valid — improve on it)
${JSON.stringify(compactPlan(plan), null, 1)}
Baseline reasoning: ${mood ? `energy ${mood.energy}, warmth ${mood.warmth}, valence ${mood.valence}` : 'n/a'}

TEMPLATES
${cat.templates}

PALETTES
${cat.palettes}

FONTS
${cat.fonts}

SECTION TREATMENTS (for cues)
${cat.treatments}

Reply with JSON using any of these keys:
{
  "template": "<template id>",
  "palette": { "id": "<palette id>", "accent": "#rrggbb", "accent2": "#rrggbb" },
  "typography": { "font": "<font id>", "case": ${JSON.stringify(TEXT_CASES)}, "weight": <number>, "align": "left|center|right", "tracking": <-0.05..0.25>, "scale": <0.6..1.6> },
  "lyrics": { "mode": "<one the template supports>", "linesVisible": 1-4, "highlight": ${JSON.stringify(HIGHLIGHT_STYLES)} },
  "background": { "intensity": 0-1, "grain": 0-0.6, "vignette": 0-1, "motion": 0-1, "scrim": 0-0.85 },
  "photos": { "treatment": "kenburns|flash|ghost|blend|plate", "opacity": 0.1-1, "tint": 0-1, "changeOn": "section|line|downbeat|slow" },
  "reactivity": { "pulse": 0-1, "flash": 0-1, "shake": 0-0.5, "cutOnDownbeat": true|false },
  "mood": { "words": ["..."], "energy": 0-1, "warmth": 0-1, "brightness": 0-1 },
  "cues": [ { "segment": <index>, "treatment": "<treatment>", "intensity": 0-1, "accentShift": -0.5..0.5, "note": "<why, max 120 chars>" } ],
  "notes": "<2-3 sentences on the visual idea, shown to the user>"
}
Give a cue for every section listed above.`;
}

/** The plan the model sees — everything it may change, nothing it may not. */
function compactPlan(plan) {
  return {
    template: plan.template,
    palette: { id: plan.palette.id, accent: plan.palette.accent, accent2: plan.palette.accent2 },
    typography: plan.typography,
    lyrics: plan.lyrics,
    background: plan.background,
    photos: { treatment: plan.photos.treatment, opacity: plan.photos.opacity, tint: plan.photos.tint, changeOn: plan.photos.changeOn },
    reactivity: plan.reactivity,
    mood: plan.mood,
    cues: plan.cues.map((c) => ({ segment: c.segment, treatment: c.treatment, intensity: c.intensity })),
  };
}

/* ------------------------------- the call -------------------------------- */

export async function refinePlan({ alignment, lyricsText, plan, prefs, mood, config = directorConfig() }) {
  if (!config.enabled) {
    return { plan, used: false, reason: 'no API key configured' };
  }

  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt({ alignment, lyricsText, plan, prefs, mood }) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
    max_tokens: 4000,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = truncate(await response.text().catch(() => ''), 200);
      return { plan, used: false, reason: `${config.providerName} returned ${response.status}: ${detail}` };
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) return { plan, used: false, reason: 'empty response' };

    const parsed = parseJson(content);
    if (!parsed) return { plan, used: false, reason: 'response was not valid JSON' };

    const { plan: merged, warnings } = normalisePlan(
      { ...parsed, source: `llm:${config.provider}` },
      { base: plan, segments: alignment.segments || [] }
    );

    return {
      plan: applyUserOverrides(merged, prefs, plan),
      used: true,
      warnings,
      model: config.model,
      provider: config.providerName,
      usage: payload.usage || null,
    };
  } catch (error) {
    const reason = error.name === 'AbortError'
      ? `${config.providerName} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : `${config.providerName} request failed: ${error.message}`;
    return { plan, used: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The user outranks the model.
 *
 * If someone explicitly picked Neon and gold, a model that decides Editorial
 * and teal would be right in the abstract and wrong in the room.
 */
function applyUserOverrides(plan, prefs, fallback) {
  const out = { ...plan };
  if (prefs.template) out.template = fallback.template;
  if (prefs.palette) out.palette = fallback.palette;
  if (prefs.font) out.typography = { ...out.typography, font: fallback.typography.font };
  if (prefs.lyricMode) out.lyrics = { ...out.lyrics, mode: fallback.lyrics.mode };
  if (prefs.aspect) out.aspect = fallback.aspect;
  if (prefs.resolution) out.resolution = fallback.resolution;
  if (prefs.fps) out.fps = fallback.fps;
  return out;
}

function parseJson(text) {
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Models occasionally wrap JSON in prose or a code fence despite being
    // asked not to; take the outermost object rather than give up.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function fmt(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
