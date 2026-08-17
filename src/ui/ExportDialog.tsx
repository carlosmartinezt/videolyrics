/**
 * Export.
 *
 * Encoding happens here, in the browser, on the visitor's own machine. That
 * is worth saying plainly in the interface — people expect a queue and a
 * server, and the fact that there isn't one is why this is fast.
 */

import { useEffect, useRef, useState } from 'react';

import type { Plan } from '../types';
import type { Scene } from '../render/engine';
import {
  frameSizeFor, suggestFilename,
  type EncodeProgress, type EncodeResult,
} from '../encode/output';
import { formatBytes, formatDuration, Notice, Spinner } from './bits';

interface Props {
  scene: Scene;
  plan: Plan;
  /** The original upload — its audio stream is copied into the MP4. */
  audioFile: Blob;
  audioBuffer: AudioBuffer;
  onClose: () => void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'encoding'; progress: EncodeProgress }
  | { kind: 'done'; result: EncodeResult; url: string; seconds: number }
  | { kind: 'failed'; message: string };

export function ExportDialog({ scene, plan, audioFile, audioBuffer, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);

  const size = frameSizeFor(plan);
  const totalFrames = Math.round(scene.alignment.duration * plan.fps);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  const run = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    const started = performance.now();

    setPhase({
      kind: 'encoding',
      progress: {
        phase: 'preparing', frame: 0, totalFrames, fraction: 0, fps: 0, eta: null,
      },
    });

    try {
      // The media toolkit is a few hundred kilobytes and is only ever needed
      // here, so it is fetched at the moment somebody actually exports.
      const { encodeToMp4 } = await import('../encode/mp4');
      const result = await encodeToMp4({
        scene: { ...scene, plan },
        audioFile,
        audioBuffer,
        signal: controller.signal,
        onProgress: (progress) => setPhase({ kind: 'encoding', progress }),
      });
      const url = URL.createObjectURL(result.blob);
      urlRef.current = url;
      setPhase({ kind: 'done', result, url, seconds: (performance.now() - started) / 1000 });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        setPhase({ kind: 'idle' });
        return;
      }
      setPhase({
        kind: 'failed',
        message: (error as Error)?.message || 'The encoder stopped unexpectedly.',
      });
    }
  };

  const filename = suggestFilename(plan);

  return (
    <div
      className="scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Export"
      onClick={(event) => { if (event.target === event.currentTarget && phase.kind !== 'encoding') onClose(); }}
    >
      <div className="dialog">
        <h2>Export MP4</h2>

        <div className="stat-row">
          <div className="stat">
            <span className="v">{size.width}×{size.height}</span>
            <span className="k">Frame</span>
          </div>
          <div className="stat">
            <span className="v">{plan.fps}</span>
            <span className="k">fps</span>
          </div>
          <div className="stat">
            <span className="v">{totalFrames.toLocaleString()}</span>
            <span className="k">Frames</span>
          </div>
          <div className="stat">
            <span className="v">H.264</span>
            <span className="k">MP4</span>
          </div>
        </div>

        {phase.kind === 'idle' && (
          <>
            <p className="hint">
              Your computer does the encoding — nothing is uploaded and nothing is queued.
              Expect roughly a minute per minute of song, faster on a recent machine. The audio is
              copied from your file rather than re-encoded, so it comes through exactly as it went in.
            </p>
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary row-end" onClick={run}>
                Start encoding
              </button>
            </div>
          </>
        )}

        {phase.kind === 'encoding' && (
          <>
            <div className="meter">
              <i style={{ width: `${Math.round(phase.progress.fraction * 100)}%` }} />
            </div>
            <div className="row">
              <span className="row" style={{ gap: 8 }}>
                <Spinner />
                <span className="hint">
                  {phase.progress.phase === 'audio' ? 'Copying the audio across'
                    : phase.progress.phase === 'finishing' ? 'Writing the file'
                      : phase.progress.phase === 'preparing' ? 'Preparing'
                        : `Frame ${phase.progress.frame.toLocaleString()} of ${totalFrames.toLocaleString()}`}
                </span>
              </span>
              <span className="row-end mono hint">
                {phase.progress.fps > 0 && `${phase.progress.fps} fps`}
                {phase.progress.eta !== null && ` · ${formatDuration(phase.progress.eta)} left`}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => abortRef.current?.abort()}
            >
              Stop
            </button>
          </>
        )}

        {phase.kind === 'done' && (
          <>
            <Notice tone="good">
              Encoded {formatBytes(phase.result.blob.size)} in {formatDuration(phase.seconds)}.
              {phase.result.audio.method === 'copied'
                ? ` The ${phase.result.audio.codec?.toUpperCase()} audio was copied across untouched.`
                : phase.result.audio.method === 'encoded'
                  ? ` Audio re-encoded as ${phase.result.audio.codec?.toUpperCase()}.`
                  : ' There is no audio track — the source format could not be carried or re-encoded.'}
            </Notice>
            <video
              src={phase.url}
              controls
              style={{ width: '100%', borderRadius: 10, background: '#000' }}
            />
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
              <a className="btn btn-primary row-end" href={phase.url} download={filename}>
                Download {filename}
              </a>
            </div>
          </>
        )}

        {phase.kind === 'failed' && (
          <>
            <Notice tone="bad">{phase.message}</Notice>
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
              <button type="button" className="btn btn-primary row-end" onClick={run}>Try again</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
