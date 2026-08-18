/**
 * A small affect lexicon for reading lyrics without a model.
 *
 * This is deliberately modest — a few hundred words with valence (unpleasant
 * to pleasant) and arousal (still to activated). It will never understand a
 * metaphor. What it reliably does is separate "burning, run, fire, tonight"
 * from "quiet, rain, remember, alone", and that separation is enough to pick
 * a palette and a template that don't fight the song.
 *
 * Values are hand-set on a -1..1 scale for valence and 0..1 for arousal,
 * following the shape of the ANEW / NRC-VAD norms without reproducing them.
 */

const V = (valence, arousal) => ({ v: valence, a: arousal });

export const AFFECT = {
  // high arousal, positive
  love: V(0.9, 0.7), fire: V(0.3, 0.9), dance: V(0.8, 0.85), alive: V(0.8, 0.75),
  burn: V(0.1, 0.85), wild: V(0.4, 0.9), free: V(0.85, 0.7), fly: V(0.8, 0.75),
  shine: V(0.85, 0.6), light: V(0.75, 0.5), sun: V(0.8, 0.55), gold: V(0.7, 0.5),
  electric: V(0.5, 0.9), high: V(0.6, 0.8), loud: V(0.3, 0.9),
  run: V(0.2, 0.85), jump: V(0.5, 0.85), party: V(0.85, 0.9), tonight: V(0.6, 0.8),
  young: V(0.7, 0.7), dream: V(0.7, 0.45), heaven: V(0.9, 0.5), forever: V(0.6, 0.4),
  beautiful: V(0.9, 0.5), sweet: V(0.8, 0.4), smile: V(0.85, 0.5), laugh: V(0.85, 0.65),
  hope: V(0.8, 0.45), rise: V(0.65, 0.7), win: V(0.8, 0.75), king: V(0.6, 0.6),
  queen: V(0.6, 0.6), money: V(0.4, 0.6), diamond: V(0.6, 0.5), star: V(0.7, 0.5),
  glow: V(0.7, 0.45), kiss: V(0.85, 0.6), touch: V(0.6, 0.5), body: V(0.4, 0.6),
  summer: V(0.8, 0.55), ocean: V(0.6, 0.35), sky: V(0.6, 0.35), heart: V(0.5, 0.55),

  // low arousal, positive
  quiet: V(0.4, 0.15), calm: V(0.6, 0.12), soft: V(0.6, 0.2), slow: V(0.3, 0.15),
  home: V(0.7, 0.3), warm: V(0.7, 0.3), rest: V(0.5, 0.12), peace: V(0.8, 0.15),
  sleep: V(0.4, 0.1), morning: V(0.5, 0.3), still: V(0.35, 0.12), gentle: V(0.65, 0.2),
  remember: V(0.3, 0.3), always: V(0.4, 0.3), together: V(0.75, 0.4),

  // low arousal, negative
  alone: V(-0.7, 0.3), lonely: V(-0.8, 0.3), empty: V(-0.7, 0.25), cold: V(-0.5, 0.3),
  rain: V(-0.2, 0.25), grey: V(-0.4, 0.2), gray: V(-0.4, 0.2), tired: V(-0.5, 0.15),
  fade: V(-0.4, 0.2), gone: V(-0.6, 0.3), lost: V(-0.7, 0.35), miss: V(-0.6, 0.35),
  sad: V(-0.8, 0.3), cry: V(-0.7, 0.5), tears: V(-0.7, 0.4), sorry: V(-0.4, 0.35),
  goodbye: V(-0.6, 0.4), leave: V(-0.5, 0.4), end: V(-0.4, 0.3), over: V(-0.4, 0.3),
  ghost: V(-0.5, 0.3), shadow: V(-0.4, 0.3), winter: V(-0.3, 0.25), silence: V(-0.3, 0.15),
  drown: V(-0.8, 0.5), sink: V(-0.6, 0.4), fall: V(-0.4, 0.45), broken: V(-0.8, 0.4),
  hurt: V(-0.8, 0.5), ache: V(-0.7, 0.35), nothing: V(-0.6, 0.25), never: V(-0.4, 0.35),

  // high arousal, negative
  hate: V(-0.9, 0.8), rage: V(-0.8, 0.95), scream: V(-0.6, 0.9), fight: V(-0.5, 0.85),
  war: V(-0.8, 0.8), blood: V(-0.7, 0.75), kill: V(-0.9, 0.85), gun: V(-0.7, 0.75),
  fear: V(-0.8, 0.7), afraid: V(-0.7, 0.6), panic: V(-0.7, 0.9), crash: V(-0.5, 0.8),
  break: V(-0.5, 0.7), storm: V(-0.3, 0.75), thunder: V(-0.1, 0.8), knife: V(-0.7, 0.7),
  liar: V(-0.7, 0.6), lie: V(-0.6, 0.5), enemy: V(-0.7, 0.6), poison: V(-0.8, 0.6),
  hell: V(-0.7, 0.7), devil: V(-0.6, 0.65), dark: V(-0.4, 0.4), black: V(-0.2, 0.4),

  // Spanish — Carlos's likeliest second language, and these are the words
  // that actually carry affect in pop lyrics.
  amor: V(0.9, 0.65), corazón: V(0.6, 0.55), corazon: V(0.6, 0.55), vida: V(0.7, 0.5),
  noche: V(0.2, 0.5), bailar: V(0.85, 0.85), fuego: V(0.3, 0.9), luz: V(0.75, 0.45),
  sol: V(0.8, 0.5), llorar: V(-0.7, 0.5), triste: V(-0.8, 0.3), solo: V(-0.6, 0.3),
  sola: V(-0.6, 0.3), adiós: V(-0.5, 0.4), adios: V(-0.5, 0.4), dolor: V(-0.8, 0.5),
  miedo: V(-0.7, 0.6), guerra: V(-0.8, 0.8), beso: V(0.85, 0.6), sueño: V(0.6, 0.35),
  cielo: V(0.7, 0.4), muerte: V(-0.9, 0.6), feliz: V(0.9, 0.6), loco: V(0.2, 0.8),
};

/** Words that hint at a whole genre or setting, mapped to mood tags. */
export const IMAGERY_TAGS = {
  night: ['night', 'dark'], neon: ['electronic', 'night'], city: ['modern', 'urban'],
  street: ['gritty', 'urban'], road: ['grounded', 'flowing'], highway: ['flowing'],
  church: ['classic', 'grand'], angel: ['ethereal'], god: ['grand'],
  guitar: ['acoustic'], drum: ['energetic'], radio: ['nostalgic', 'vintage'],
  summer: ['summer', 'bright'], winter: ['cold'], rain: ['melancholy'],
  ocean: ['expansive', 'flowing'], sea: ['expansive'], river: ['flowing'],
  star: ['ethereal', 'dreamy'], moon: ['night', 'dreamy'], sky: ['expansive'],
  dance: ['energetic', 'playful'], floor: ['energetic'], club: ['electronic', 'night'],
  wine: ['elegant'], gold: ['elegant', 'grand'], diamond: ['elegant'],
  ghost: ['melancholy', 'dark'], grave: ['dark'], memory: ['nostalgic'],
  photograph: ['nostalgic', 'vintage'], letter: ['nostalgic', 'intimate'],
  train: ['nostalgic', 'flowing'], plane: ['expansive'], home: ['grounded', 'tender'],
  mother: ['tender'], father: ['tender'], child: ['tender'], baby: ['romantic'],
};

const WORD_RE = /[^\W\d_]+(?:'[^\W\d_]+)?/gu;

/**
 * Read the lyrics as a whole.
 * Returns valence/arousal in -1..1 and 0..1, how much evidence there was,
 * and any imagery tags worth passing to the palette chooser.
 */
export function readLyrics(text) {
  const words = String(text || '').toLowerCase().match(WORD_RE) || [];
  let vSum = 0;
  let aSum = 0;
  let hits = 0;
  const tags = new Map();

  for (const word of words) {
    const affect = AFFECT[word];
    if (affect) { vSum += affect.v; aSum += affect.a; hits++; }
    const imagery = IMAGERY_TAGS[word];
    if (imagery) for (const tag of imagery) tags.set(tag, (tags.get(tag) || 0) + 1);
  }

  const confidence = Math.min(1, hits / Math.max(12, words.length * 0.06));

  return {
    valence: hits ? vSum / hits : 0,
    arousal: hits ? aSum / hits : 0.5,
    confidence,
    hits,
    wordCount: words.length,
    tags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t),
  };
}

/* --------------------------- chosen moods -------------------------------- */

/**
 * What each word in the mood vocabulary implies, as energy / warmth /
 * brightness on the same 0..1 scales the director already uses.
 *
 * This exists because picking a mood used to change only the *word list*,
 * which fed template and palette scoring and nothing else. Force a template
 * and a palette and the mood then had no effect whatsoever — "aggressive" and
 * "tender" produced identical frames. These numbers give a chosen mood a route
 * to the things you can actually see: highlight style, motion, grain, vignette
 * and cue intensity.
 */
export const MOOD_AFFECT = {
  acoustic:      { e: 0.35, w: 0.62, b: 0.55 },
  aggressive:    { e: 0.95, w: 0.55, b: 0.40 },
  ambient:       { e: 0.18, w: 0.45, b: 0.48 },
  bright:        { e: 0.62, w: 0.60, b: 0.92 },
  calm:          { e: 0.15, w: 0.55, b: 0.60 },
  cinematic:     { e: 0.55, w: 0.45, b: 0.40 },
  classic:       { e: 0.40, w: 0.55, b: 0.55 },
  cold:          { e: 0.35, w: 0.12, b: 0.45 },
  dark:          { e: 0.45, w: 0.30, b: 0.12 },
  defiant:       { e: 0.82, w: 0.45, b: 0.42 },
  dramatic:      { e: 0.72, w: 0.45, b: 0.35 },
  dreamy:        { e: 0.25, w: 0.55, b: 0.62 },
  electronic:    { e: 0.72, w: 0.35, b: 0.50 },
  elegant:       { e: 0.35, w: 0.50, b: 0.58 },
  energetic:     { e: 0.90, w: 0.60, b: 0.70 },
  ethereal:      { e: 0.22, w: 0.48, b: 0.78 },
  euphoric:      { e: 0.88, w: 0.68, b: 0.82 },
  expansive:     { e: 0.55, w: 0.50, b: 0.65 },
  flowing:       { e: 0.45, w: 0.55, b: 0.58 },
  folk:          { e: 0.38, w: 0.68, b: 0.58 },
  futuristic:    { e: 0.68, w: 0.30, b: 0.55 },
  grand:         { e: 0.70, w: 0.50, b: 0.55 },
  gritty:        { e: 0.75, w: 0.48, b: 0.30 },
  grounded:      { e: 0.38, w: 0.58, b: 0.45 },
  happy:         { e: 0.75, w: 0.78, b: 0.85 },
  hopeful:       { e: 0.55, w: 0.68, b: 0.78 },
  intense:       { e: 0.88, w: 0.45, b: 0.32 },
  introspective: { e: 0.25, w: 0.45, b: 0.38 },
  lonely:        { e: 0.22, w: 0.35, b: 0.28 },
  melancholy:    { e: 0.25, w: 0.38, b: 0.30 },
  minimal:       { e: 0.30, w: 0.45, b: 0.55 },
  modern:        { e: 0.58, w: 0.45, b: 0.58 },
  nostalgic:     { e: 0.35, w: 0.68, b: 0.45 },
  organic:       { e: 0.40, w: 0.68, b: 0.55 },
  passionate:    { e: 0.80, w: 0.75, b: 0.50 },
  playful:       { e: 0.78, w: 0.70, b: 0.78 },
  raw:           { e: 0.78, w: 0.50, b: 0.35 },
  rock:          { e: 0.85, w: 0.55, b: 0.42 },
  romantic:      { e: 0.42, w: 0.78, b: 0.55 },
  serious:       { e: 0.40, w: 0.38, b: 0.35 },
  soft:          { e: 0.22, w: 0.62, b: 0.68 },
  soulful:       { e: 0.50, w: 0.72, b: 0.48 },
  summer:        { e: 0.68, w: 0.85, b: 0.88 },
  tender:        { e: 0.28, w: 0.72, b: 0.62 },
  triumphant:    { e: 0.85, w: 0.65, b: 0.72 },
  uplifting:     { e: 0.75, w: 0.70, b: 0.82 },
  vintage:       { e: 0.40, w: 0.68, b: 0.42 },
  warm:          { e: 0.45, w: 0.88, b: 0.62 },
};

/**
 * How far a chosen mood pulls the reading away from what the audio says.
 * Not all the way: asking for "aggressive" over a slow ballad should make it
 * harsher, not pretend it is fast.
 */
export const MOOD_PULL = 0.5;
