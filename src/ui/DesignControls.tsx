/**
 * The design choices: mood, look, colour, type.
 *
 * Rendered in two places that must never disagree — the setup screen, where
 * they are made *before* the first generate, and the studio panel, where they
 * are changed afterwards. Duplicating them was the obvious thing to do and
 * would have guaranteed the two drifting apart, so this takes an optional
 * `plan` instead: with one it can say what the director actually chose, and
 * without one it says "auto" and means it.
 */

import { useState } from 'react';

import type { Plan, Prefs, ServerConfig, LyricMode } from '../types';
import { CardHead } from './bits';

export const LYRIC_MODE_LABELS: Record<LyricMode, string> = {
  karaoke: 'Karaoke — the word fills as it is sung',
  wordPop: 'Word by word — each word arrives on cue',
  lineFade: 'Line fade — whole lines, calm',
  cascade: 'Cascade — a scrolling column',
  hero: 'Hero — one big word at a time',
  bloom: 'Bloom — words swell in and dissolve, cinematic',
};

interface Props {
  config: ServerConfig;
  prefs: Prefs;
  onPrefs: (patch: Prefs) => void;
  /** Present in the studio, absent on the setup screen. */
  plan?: Plan;
}

export function DesignControls({ config, prefs, onPrefs, plan }: Props) {
  const [showAllMoods, setShowAllMoods] = useState(false);

  // What the person picked wins; otherwise what the director chose; otherwise
  // nothing is settled yet and every control says auto.
  const templateId = prefs.template ?? plan?.template;
  const template = config.templates.find((t) => t.id === templateId);

  const moodSet = new Set(prefs.moods ?? []);
  const toggleMood = (mood: string) => {
    const next = new Set(moodSet);
    if (next.has(mood)) next.delete(mood);
    else if (next.size < 5) next.add(mood);
    onPrefs({ moods: [...next] });
  };

  const visibleMoods = showAllMoods ? config.moods : config.moods.slice(0, 14);

  // With no template settled, every mode is still reachable — which one you
  // end up with depends on the look the director picks.
  const lyricModes: LyricMode[] = template
    ? template.lyricModes
    : [...new Set(config.templates.flatMap((t) => t.lyricModes))];

  const autoFontName = plan && config.fonts.find((f) => f.id === plan.typography.font)?.name;

  return (
    <>
      <section className="card">
        <CardHead title="Mood" aside={`${moodSet.size}/5`} />
        <p className="hint" style={{ marginBottom: 12 }}>
          Pick up to five. Leave it empty and the mood is read from the music and the words.
        </p>
        <div className="chips">
          {visibleMoods.map((mood) => (
            <button
              key={mood}
              type="button"
              className="chip"
              aria-pressed={moodSet.has(mood)}
              onClick={() => toggleMood(mood)}
            >
              {mood}
            </button>
          ))}
          {!showAllMoods && config.moods.length > 14 && (
            <button type="button" className="chip" onClick={() => setShowAllMoods(true)}>
              more…
            </button>
          )}
        </div>
      </section>

      <section className="card">
        <CardHead title="Look" />
        <div className="options">
          <button
            type="button"
            className="option option-thumbed"
            aria-pressed={!prefs.template}
            onClick={() => onPrefs({ template: undefined })}
          >
            <span className="thumb thumb-auto" aria-hidden="true" />
            <span className="option-text">
              <span className="name">Let it choose</span>
              <span className="desc">Picks the template that fits the song.</span>
            </span>
          </button>
          {config.templates.map((item) => (
            <button
              key={item.id}
              type="button"
              className="option option-thumbed"
              aria-pressed={prefs.template === item.id}
              onClick={() => onPrefs({ template: item.id })}
            >
              {/* A still rendered by the real renderer, not a mockup, so it
                  cannot drift from what the template actually produces.
                  Regenerate with: node scripts/thumbnails.mjs */}
              <img
                className="thumb"
                src={`/templates/${item.id}.webp`}
                alt=""
                width={640}
                height={360}
                loading="lazy"
                decoding="async"
              />
              <span className="option-text">
                <span className="name">{item.name}</span>
                <span className="desc">{item.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <CardHead title="Colour" />
        <div className="swatches">
          <button
            type="button"
            className="swatch"
            aria-pressed={!prefs.palette}
            onClick={() => onPrefs({ palette: undefined })}
          >
            <span
              className="strip"
              style={{
                background: plan
                  ? `linear-gradient(90deg, ${plan.palette.bg[1]}, ${plan.palette.accent})`
                  : 'linear-gradient(90deg, var(--ink-raise), var(--accent))',
              }}
            />
            <span className="label">Auto</span>
          </button>
          {config.palettes.map((palette) => (
            <button
              key={palette.id}
              type="button"
              className="swatch"
              aria-pressed={prefs.palette === palette.id}
              onClick={() => onPrefs({ palette: palette.id })}
              title={palette.moods.join(', ')}
            >
              <span
                className="strip"
                style={{
                  background:
                    `linear-gradient(90deg, ${palette.bg[0]} 0%, ${palette.bg[1]} 45%, ${palette.accent} 78%, ${palette.accent2} 100%)`,
                }}
              />
              <span className="label">{palette.name}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <CardHead title="Type" />
        <div className="stack-sm">
          <div className="field">
            <label htmlFor="font">Typeface</label>
            <select
              id="font"
              className="select"
              value={prefs.font ?? ''}
              onChange={(event) => onPrefs({ font: event.target.value || undefined })}
            >
              <option value="">{autoFontName ? `Auto — ${autoFontName}` : 'Auto — chosen from the song'}</option>
              {config.fonts.map((font) => (
                <option key={font.id} value={font.id}>{font.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="mode">How the lyrics appear</label>
            <select
              id="mode"
              className="select"
              value={prefs.lyricMode ?? ''}
              onChange={(event) => onPrefs({ lyricMode: (event.target.value || undefined) as LyricMode })}
            >
              <option value="">
                {plan ? `Auto — ${LYRIC_MODE_LABELS[plan.lyrics.mode]}` : 'Auto — chosen to suit the look'}
              </option>
              {lyricModes.map((mode) => (
                <option key={mode} value={mode}>{LYRIC_MODE_LABELS[mode]}</option>
              ))}
            </select>
            <span className="hint">
              {template
                ? `Modes available depend on the look. ${template.name} supports ${template.lyricModes.length}.`
                : 'Pick a look above to narrow these down.'}
            </span>
          </div>
        </div>
      </section>
    </>
  );
}
