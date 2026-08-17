/**
 * The style panel.
 *
 * Two kinds of control, kept visibly apart: the ones that change the design
 * (and so need the director to run again) and the ones that only change the
 * output file (aspect, resolution, frame rate), which apply immediately
 * because they never touch the plan's design decisions.
 */

import { useState } from 'react';

import type { Plan, Prefs, ServerConfig, LyricMode } from '../types';
import { CardHead, Notice } from './bits';

interface Props {
  config: ServerConfig;
  plan: Plan;
  prefs: Prefs;
  busy: boolean;
  onPrefs: (patch: Prefs) => void;
  onPlan: (patch: Partial<Plan>) => void;
  onRedesign: () => void;
}

const LYRIC_MODE_LABELS: Record<LyricMode, string> = {
  karaoke: 'Karaoke — the word fills as it is sung',
  wordPop: 'Word by word — each word arrives on cue',
  lineFade: 'Line fade — whole lines, calm',
  cascade: 'Cascade — a scrolling column',
  hero: 'Hero — one big word at a time',
};

export function StylePanel({ config, plan, prefs, busy, onPrefs, onPlan, onRedesign }: Props) {
  const [showAll, setShowAll] = useState(false);

  const template = config.templates.find((t) => t.id === plan.template);
  const moodSet = new Set(prefs.moods ?? []);

  const toggleMood = (mood: string) => {
    const next = new Set(moodSet);
    if (next.has(mood)) next.delete(mood);
    else if (next.size < 5) next.add(mood);
    onPrefs({ moods: [...next] });
  };

  const visibleMoods = showAll ? config.moods : config.moods.slice(0, 14);

  return (
    <div className="stack">
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
          {!showAll && config.moods.length > 14 && (
            <button type="button" className="chip" onClick={() => setShowAll(true)}>
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
            className="option"
            aria-pressed={!prefs.template}
            onClick={() => onPrefs({ template: undefined })}
          >
            <span className="name">Let it choose</span>
            <span className="desc">Picks the template that fits the song.</span>
          </button>
          {config.templates.map((item) => (
            <button
              key={item.id}
              type="button"
              className="option"
              aria-pressed={prefs.template === item.id}
              onClick={() => onPrefs({ template: item.id })}
            >
              <span className="name">{item.name}</span>
              <span className="desc">{item.blurb}</span>
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
              style={{ background: `linear-gradient(90deg, ${plan.palette.bg[1]}, ${plan.palette.accent})` }}
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
              <option value="">Auto — {config.fonts.find((f) => f.id === plan.typography.font)?.name}</option>
              {config.fonts.map((font) => (
                <option key={font.id} value={font.id}>{font.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="mode">How the words appear</label>
            <select
              id="mode"
              className="select"
              value={prefs.lyricMode ?? ''}
              onChange={(event) => onPrefs({ lyricMode: (event.target.value || undefined) as LyricMode })}
            >
              <option value="">Auto — {LYRIC_MODE_LABELS[plan.lyrics.mode]}</option>
              {(template?.lyricModes ?? []).map((mode) => (
                <option key={mode} value={mode}>{LYRIC_MODE_LABELS[mode]}</option>
              ))}
            </select>
            {template && (
              <span className="hint">Modes available depend on the look. {template.name} supports {template.lyricModes.length}.</span>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <CardHead title="Output" />
        <div className="stack-sm">
          <div className="field">
            <label htmlFor="aspect">Shape</label>
            <select
              id="aspect"
              className="select"
              value={plan.aspect}
              onChange={(event) => onPlan({ aspect: event.target.value })}
            >
              {Object.entries(config.aspects).map(([key, value]) => (
                <option key={key} value={key}>{key} · {value.name} — {value.note}</option>
              ))}
            </select>
          </div>

          <div className="two-up">
            <div className="field">
              <label htmlFor="res">Resolution</label>
              <select
                id="res"
                className="select"
                value={plan.resolution}
                onChange={(event) => onPlan({ resolution: Number(event.target.value) })}
              >
                <option value={720}>720p</option>
                <option value={1080}>1080p</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="fps">Frame rate</label>
              <select
                id="fps"
                className="select"
                value={plan.fps}
                onChange={(event) => onPlan({ fps: Number(event.target.value) })}
              >
                <option value={24}>24 fps</option>
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </div>
          </div>
        </div>
      </section>

      <div className="stack-sm">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          onClick={onRedesign}
          disabled={busy}
          style={{ width: '100%' }}
        >
          {busy ? 'Redesigning…' : 'Redesign with these'}
        </button>
        {config.director.enabled ? (
          <p className="hint">
            {config.director.provider} rereads the lyrics each time, so the same settings can give a different take.
          </p>
        ) : (
          <Notice tone="info">
            The art director is running on rules only — no model key is configured, so the design comes
            from the audio analysis and your choices.
          </Notice>
        )}
      </div>
    </div>
  );
}
