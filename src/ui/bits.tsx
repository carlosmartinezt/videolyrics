import type { ReactNode } from 'react';

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

export function Notice(
  { tone = 'info', mark, children }:
  { tone?: 'info' | 'good' | 'warn' | 'bad'; mark?: string; children: ReactNode },
) {
  const glyph = mark ?? { info: 'i', good: '✓', warn: '!', bad: '×' }[tone];
  return (
    <div className="notice" data-tone={tone} role={tone === 'bad' ? 'alert' : undefined}>
      <span className="mark" aria-hidden="true">{glyph}</span>
      <div>{children}</div>
    </div>
  );
}

export function CardHead(
  { step, done, title, aside }:
  { step?: number; done?: boolean; title: string; aside?: ReactNode },
) {
  return (
    <div className="card-head">
      {step !== undefined && (
        <span className="step-mark" data-done={done ? 'true' : 'false'} aria-hidden="true">
          {done ? '✓' : step}
        </span>
      )}
      <h2>{title}</h2>
      {aside && <div className="count mono hint">{aside}</div>}
    </div>
  );
}

export function Spinner() {
  return <span className="spin" aria-hidden="true" />;
}
