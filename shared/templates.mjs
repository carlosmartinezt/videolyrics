/**
 * The template catalogue.
 *
 * A template is a *visual system*, not a preset. It decides how the frame is
 * built — what the background is made of, where type sits, what reacts to the
 * music — and then the director tunes it per song and per section. Two songs
 * on the same template should not look like the same video.
 *
 * The renderer in the browser implements each `id`. Everything here is the
 * contract the server-side director reasons over, so the two must stay in
 * step: adding a template means adding a background painter and a lyric
 * layout in web/src/render/.
 */

/** How the lyric text itself behaves. Templates declare which they support. */
export const LYRIC_MODES = {
  /** Whole line visible, the current word fills with the accent colour. */
  karaoke: 'karaoke',
  /** Words appear one at a time as they are sung, then the line clears. */
  wordPop: 'wordPop',
  /** Whole line fades in on its first word, out after its last. */
  lineFade: 'lineFade',
  /** A scrolling column, current line centred and bright, neighbours dimmed. */
  cascade: 'cascade',
  /** One giant word at a time, filling the frame. For sparse, punchy lyrics. */
  hero: 'hero',
  /** Words swell into place and dissolve one by one. The cinematic one. */
  bloom: 'bloom',
};

export const TEMPLATES = [
  {
    id: 'aurora',
    name: 'Aurora',
    blurb: 'Slow liquid colour fields. Type floats in the middle, breathing with the track.',
    moods: ['dreamy', 'calm', 'romantic', 'ambient', 'hopeful', 'soft', 'ethereal', 'flowing'],
    lyricModes: ['lineFade', 'bloom', 'karaoke', 'cascade'],
    defaultLyricMode: 'lineFade',
    usesPhotos: 'optional',
    photoTreatment: 'blend',
    motion: { pace: 'slow', cuts: false, pulse: 0.35 },
    typography: { font: 'cormorant', case: 'sentence', weight: 600, align: 'center', tracking: 0.01 },
    tempoRange: [0, 200],
  },
  {
    id: 'kinetic',
    name: 'Kinetic',
    blurb: 'Big set type, hard cuts on the downbeat, colour blocks that snap.',
    moods: ['energetic', 'aggressive', 'confident', 'playful', 'defiant', 'gritty', 'triumphant'],
    lyricModes: ['wordPop', 'hero', 'karaoke'],
    defaultLyricMode: 'wordPop',
    usesPhotos: 'optional',
    photoTreatment: 'flash',
    motion: { pace: 'fast', cuts: true, pulse: 0.9 },
    typography: { font: 'anton', case: 'upper', weight: 400, align: 'center', tracking: -0.02 },
    tempoRange: [90, 200],
  },
  {
    id: 'filmstrip',
    name: 'Filmstrip',
    blurb: 'Your photographs, drifting. Letterbox bars, grain, lyrics low in frame.',
    moods: ['cinematic', 'nostalgic', 'melancholy', 'tender', 'vintage', 'storytelling', 'grounded'],
    lyricModes: ['lineFade', 'bloom', 'karaoke'],
    defaultLyricMode: 'lineFade',
    usesPhotos: 'preferred',
    photoTreatment: 'kenburns',
    motion: { pace: 'slow', cuts: true, pulse: 0.2 },
    typography: { font: 'inter', case: 'sentence', weight: 500, align: 'center', tracking: 0.02 },
    tempoRange: [0, 200],
  },
  {
    id: 'neon',
    name: 'Neon',
    blurb: 'Black room, glowing letters, sparks thrown off every hit.',
    moods: ['electronic', 'futuristic', 'dark', 'euphoric', 'night', 'intense', 'energetic'],
    lyricModes: ['karaoke', 'wordPop', 'hero', 'bloom'],
    defaultLyricMode: 'karaoke',
    usesPhotos: 'optional',
    photoTreatment: 'ghost',
    motion: { pace: 'medium', cuts: true, pulse: 0.75 },
    typography: { font: 'space-grotesk', case: 'upper', weight: 700, align: 'center', tracking: 0.06 },
    tempoRange: [80, 200],
  },
  {
    id: 'editorial',
    name: 'Editorial',
    blurb: 'A quiet page. Fine serif, wide margins, almost nothing moves.',
    moods: ['elegant', 'intimate', 'acoustic', 'serious', 'classic', 'minimal', 'introspective'],
    lyricModes: ['lineFade', 'cascade', 'bloom', 'karaoke'],
    defaultLyricMode: 'cascade',
    usesPhotos: 'optional',
    photoTreatment: 'plate',
    motion: { pace: 'slow', cuts: false, pulse: 0.12 },
    typography: { font: 'playfair', case: 'sentence', weight: 500, align: 'left', tracking: 0 },
    tempoRange: [0, 140],
  },
  {
    id: 'spectrum',
    name: 'Spectrum',
    blurb: 'The song draws itself — bars, rings and waveforms behind the words.',
    moods: ['electronic', 'instrumental', 'modern', 'cold', 'expansive', 'euphoric'],
    lyricModes: ['karaoke', 'lineFade', 'wordPop'],
    defaultLyricMode: 'karaoke',
    usesPhotos: 'optional',
    photoTreatment: 'ghost',
    motion: { pace: 'medium', cuts: false, pulse: 0.85 },
    typography: { font: 'space-grotesk', case: 'upper', weight: 500, align: 'center', tracking: 0.08 },
    tempoRange: [0, 200],
  },
];

export const TEMPLATES_BY_ID = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));

/**
 * Self-hosted fonts. No CDN — the renderer must be certain a face is loaded
 * before it draws a frame, and a font that arrives on frame 40 would produce
 * a video whose first two seconds are in the fallback face.
 */
/**
 * `optical` corrects for x-height. Point size is a measure of the em box, not
 * of how big a typeface looks: Cormorant set at 80px reads far smaller than
 * Anton at 80px because its lowercase is much shorter. Without this factor
 * the serif templates come out visibly timid next to the display ones, which
 * is a typesetting error, not a style.
 */
export const FONTS = [
  { id: 'anton', name: 'Anton', stack: '"Anton", Impact, sans-serif', weights: [400], flavour: 'display', shout: true, optical: 0.94 },
  { id: 'bebas', name: 'Bebas Neue', stack: '"Bebas Neue", Impact, sans-serif', weights: [400], flavour: 'display', shout: true, optical: 1.02 },
  { id: 'archivo-black', name: 'Archivo Black', stack: '"Archivo Black", sans-serif', weights: [400], flavour: 'display', shout: true, optical: 0.92 },
  { id: 'inter', name: 'Inter', stack: '"Inter", system-ui, sans-serif', weights: [400, 600, 800], flavour: 'sans', optical: 1 },
  { id: 'space-grotesk', name: 'Space Grotesk', stack: '"Space Grotesk", sans-serif', weights: [400, 500, 700], flavour: 'sans', optical: 1 },
  { id: 'oswald', name: 'Oswald', stack: '"Oswald", sans-serif', weights: [400, 600], flavour: 'condensed', optical: 1.05 },
  { id: 'playfair', name: 'Playfair Display', stack: '"Playfair Display", Georgia, serif', weights: [400, 500, 700], flavour: 'serif', optical: 1.06 },
  { id: 'cormorant', name: 'Cormorant Garamond', stack: '"Cormorant Garamond", Georgia, serif', weights: [400, 500, 600], flavour: 'serif', optical: 1.3 },
  { id: 'dm-serif', name: 'DM Serif Display', stack: '"DM Serif Display", Georgia, serif', weights: [400], flavour: 'serif', optical: 1.02 },
  { id: 'caveat', name: 'Caveat', stack: '"Caveat", cursive', weights: [400, 700], flavour: 'hand', optical: 1.35 },
  { id: 'jetbrains', name: 'JetBrains Mono', stack: '"JetBrains Mono", ui-monospace, monospace', weights: [400, 700], flavour: 'mono', optical: 1.02 },
];

export const FONTS_BY_ID = Object.fromEntries(FONTS.map((f) => [f.id, f]));

export const ASPECTS = {
  '16:9': { w: 16, h: 9, name: 'Widescreen', note: 'YouTube' },
  '9:16': { w: 9, h: 16, name: 'Vertical', note: 'Reels, TikTok, Shorts' },
  '1:1': { w: 1, h: 1, name: 'Square', note: 'Feed posts' },
  '4:5': { w: 4, h: 5, name: 'Portrait', note: 'Instagram feed' },
};

/** Frame size for an aspect at a given short-edge resolution. */
export function frameSize(aspect, resolution) {
  const { w, h } = ASPECTS[aspect] || ASPECTS['16:9'];
  // Resolution names the *smaller* dimension for portrait, the larger for
  // landscape — i.e. "1080" means 1920x1080 and 1080x1920, as people expect.
  const long = Math.round((resolution * Math.max(w, h)) / Math.min(w, h));
  const size = w >= h ? { width: long, height: resolution } : { width: resolution, height: long };
  // H.264 requires even dimensions; odd values fail encoder configuration.
  return { width: size.width - (size.width % 2), height: size.height - (size.height % 2) };
}
