/**
 * The wire types. These mirror what the aligner emits and what
 * shared/plan.mjs validates — if you change one, change the other.
 */

export interface AlignedWord {
  i: number;
  t: string;
  line: number;
  start: number;
  end: number;
  score: number;
  aligned: boolean;
}

export interface AlignedLine {
  i: number;
  text: string;
  section: string;
  words: number[];
  start: number;
  end: number;
}

export interface Segment {
  index: number;
  kind: 'intro' | 'verse' | 'chorus' | 'bridge' | 'break' | 'outro' | string;
  label: string;
  start: number;
  end: number;
  lines: number[];
  energy: number;
  brightness: number;
  repeat_of: number | null;
}

export interface AudioFeatures {
  duration: number;
  tempo: number;
  beats: number[];
  downbeats: number[];
  onsets: number[];
  envelope_hz: number;
  loudness: number[];
  brightness: number[];
  bass: number[];
  key: string;
  mode: string;
  key_confidence: number;
  peak_loudness_at: number;
}

export interface Alignment {
  version: number;
  duration: number;
  model: string;
  elapsed: number;
  quality: { mean_score: number; aligned_ratio: number; weak_fraction?: number; verdict: string };
  audio: AudioFeatures;
  words: AlignedWord[];
  lines: AlignedLine[];
  segments: Segment[];
}

export type LyricMode = 'karaoke' | 'wordPop' | 'lineFade' | 'cascade' | 'hero';
export type CueTreatment = 'still' | 'drift' | 'build' | 'surge' | 'strip' | 'bloom' | 'flicker';

export interface Cue {
  segment: number;
  treatment: CueTreatment;
  intensity: number;
  lyricMode: LyricMode | null;
  accentShift: number;
  note: string;
}

export interface Plan {
  version: number;
  template: string;
  aspect: string;
  resolution: number;
  fps: number;
  mood: { words: string[]; energy: number; warmth: number; brightness: number };
  palette: {
    id: string; bg: string[]; fg: string; dim: string;
    accent: string; accent2: string; glow: string;
  };
  typography: {
    font: string; case: 'upper' | 'sentence' | 'as-is'; weight: number;
    align: 'left' | 'center' | 'right'; tracking: number; scale: number;
  };
  lyrics: {
    mode: LyricMode; linesVisible: number;
    highlight: 'fill' | 'glow' | 'scale' | 'underline' | 'none';
    maxWordsPerCard: number;
  };
  background: { intensity: number; grain: number; vignette: number; motion: number; scrim: number };
  photos: {
    enabled: boolean;
    treatment: 'kenburns' | 'flash' | 'ghost' | 'blend' | 'plate';
    opacity: number; tint: number;
    changeOn: 'section' | 'line' | 'downbeat' | 'slow';
  };
  reactivity: { pulse: number; flash: number; shake: number; cutOnDownbeat: boolean };
  title: { show: boolean; title: string; artist: string; style: string; holdUntil: number };
  cues: Cue[];
  notes: string;
  source: string;
}

export interface DirectorInfo {
  source: string;
  llm: {
    used: boolean;
    provider?: string;
    model?: string;
    reason: string | null;
    warnings?: string[];
    usage?: unknown;
  };
  elapsedMs: number;
}

export type JobState = 'created' | 'queued' | 'aligning' | 'directing' | 'ready' | 'error' | 'cancelled';

export interface Job {
  id: string;
  state: JobState;
  progress: number;
  stage: string | null;
  message: string;
  error: string | null;
  queuePosition: number;
  audioBytes: number;
  audioName: string | null;
  createdAt: number;
  expiresAt: number;
  alignment?: Alignment;
  plan?: Plan;
  director?: DirectorInfo;
  final?: boolean;
}

export interface TemplateInfo {
  id: string; name: string; blurb: string; moods: string[];
  lyricModes: LyricMode[]; defaultLyricMode: LyricMode;
  usesPhotos: string; photoTreatment: string;
  motion: { pace: string; cuts: boolean; pulse: number };
  typography: Plan['typography'];
  tempoRange: [number, number];
}

export interface PaletteInfo {
  id: string; name: string; moods: string[];
  bg: string[]; fg: string; dim: string; accent: string; accent2: string; glow: string;
}

export interface FontInfo {
  id: string; name: string; stack: string; weights: number[];
  flavour: string; shout?: boolean; optical?: number;
}

export interface ServerConfig {
  limits: {
    maxAudioBytes: number; maxLyricChars: number;
    maxDurationSeconds: number; retentionHours: number;
  };
  director: { enabled: boolean; provider: string | null; model: string | null };
  templates: TemplateInfo[];
  palettes: PaletteInfo[];
  fonts: FontInfo[];
  aspects: Record<string, { w: number; h: number; name: string; note: string }>;
  moods: string[];
  treatments: Record<string, string>;
}

/** User-chosen inputs that steer the director. */
export interface Prefs {
  moods?: string[];
  template?: string;
  palette?: string;
  font?: string;
  lyricMode?: LyricMode;
  aspect?: string;
  resolution?: number;
  fps?: number;
  imageColors?: string[];
  photoCount?: number;
  title?: string;
  artist?: string;
  notes?: string;
}
