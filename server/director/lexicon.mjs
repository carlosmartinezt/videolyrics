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
