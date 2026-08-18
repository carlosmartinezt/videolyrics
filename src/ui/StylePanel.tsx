/**
 * The style panel, shown beside the preview once there is something to look at.
 *
 * Two kinds of control, kept visibly apart: the ones that change the design
 * (and so need the director to run again) and the ones that only change the
 * output file (aspect, resolution, frame rate), which apply immediately
 * because they never touch the plan's design decisions.
 *
 * The design controls themselves live in DesignControls, because the setup
 * screen offers the same ones before the first generate.
 */

import type { Plan, Prefs, ServerConfig } from '../types';
import { CardHead, Notice } from './bits';
import { DesignControls } from './DesignControls';

interface Props {
  config: ServerConfig;
  plan: Plan;
  prefs: Prefs;
  busy: boolean;
  onPrefs: (patch: Prefs) => void;
  onPlan: (patch: Partial<Plan>) => void;
  onRedesign: () => void;
}

export function StylePanel({ config, plan, prefs, busy, onPrefs, onPlan, onRedesign }: Props) {
  return (
    <div className="stack">
      <DesignControls config={config} prefs={prefs} onPrefs={onPrefs} plan={plan} />

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
