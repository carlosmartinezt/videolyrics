/**
 * The cue sheet.
 *
 * This is the director's reasoning made visible: every section of the song,
 * when it starts, what it was read as, and how it gets treated. It doubles as
 * navigation — clicking a row jumps the preview there — which is why the
 * numbering earns its place: these really are ordered cues with timecodes.
 */

import type { Alignment, Plan } from '../types';
import { formatTime } from './bits';

interface Props {
  alignment: Alignment;
  plan: Plan;
  currentTime: number;
  onSeek: (time: number) => void;
}

export function CueSheet({ alignment, plan, currentTime, onSeek }: Props) {
  const current = alignment.segments.findIndex(
    (segment) => currentTime >= segment.start && currentTime < segment.end,
  );

  return (
    <div className="cues">
      {alignment.segments.map((segment, index) => {
        const cue = plan.cues[index];
        const isCurrent = index === current;
        return (
          <div key={segment.index}>
            <button
              type="button"
              className="cue"
              data-current={isCurrent ? 'true' : 'false'}
              onClick={() => onSeek(segment.start + 0.01)}
            >
              <span className="n">{String(index + 1).padStart(2, '0')}</span>
              <span className="t">{formatTime(segment.start)}</span>
              <span className="label">
                {segment.label}
                {segment.repeat_of != null && (
                  <span className="hint" style={{ marginLeft: 6 }}>
                    ↺ {String(segment.repeat_of + 1).padStart(2, '0')}
                  </span>
                )}
              </span>
              <span className="treatment">{cue?.treatment ?? 'drift'}</span>
            </button>
            {isCurrent && cue?.note && <p className="cue-note">{cue.note}</p>}
          </div>
        );
      })}
    </div>
  );
}
