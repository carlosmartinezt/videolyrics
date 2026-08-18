/**
 * videolyrics.
 *
 * Three screens on one page: set it up, wait for the machine to listen, then
 * work on the result. The hero canvas from the first screen keeps running
 * during the wait, which is both a progress indicator that is actually worth
 * watching and a preview of what is being built.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import * as api from './api';
import type {
  Alignment, DirectorInfo, Job, Plan, Prefs, ServerConfig,
} from './types';
import { buildAudioTrack, type AudioTrack } from './audio/track';
import { decodeAudioFile } from './encode/output';
import { detectSupport, type Support } from './encode/support';
import { ensureFont, fontOpticalFor, fontStackFor } from './lib/fonts';
import {
  initAuth, onAuthChange, signOut, stubRestore, stubSignOut, tidyCallbackUrl,
  type AuthUser,
} from './lib/auth';
import { loadReference, mergeColours, releaseReference, type Reference } from './lib/images';
// `track` is taken by the AudioTrack state below.
import { track as trackEvent } from './lib/analytics';
import type { Scene } from './render/engine';

import { CardHead, formatBytes, formatTime, Notice, Spinner } from './ui/bits';
import { CueSheet } from './ui/CueSheet';
import { DesignControls } from './ui/DesignControls';
import { ExportDialog } from './ui/ExportDialog';
import { HeroCanvas } from './ui/HeroCanvas';
import { Preview, type PreviewHandle } from './ui/Preview';
import { SignIn } from './ui/SignIn';
import { StylePanel } from './ui/StylePanel';

/**
 * The reactivity table is built once at this rate regardless of the output
 * frame rate, so switching between 24, 30 and 60 fps costs nothing.
 */
const TRACK_FPS = 60;

const AUDIO_TYPES = ['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.webm'];

const STAGES = [
  { key: 'decode', label: 'Decode' },
  { key: 'analyse', label: 'Analyse' },
  { key: 'load', label: 'Load model' },
  { key: 'align', label: 'Align' },
  { key: 'finish', label: 'Direct' },
];

type Screen = 'setup' | 'working' | 'studio';

export function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [support, setSupport] = useState<Support | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const [screen, setScreen] = useState<Screen>('setup');
  const [file, setFile] = useState<File | null>(null);
  const [lyrics, setLyrics] = useState('');
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [prefs, setPrefs] = useState<Prefs>({});
  const [references, setReferences] = useState<Reference[]>([]);
  const [dragging, setDragging] = useState(false);

  const [job, setJob] = useState<Job | null>(null);
  const [uploadFraction, setUploadFraction] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [alignment, setAlignment] = useState<Alignment | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [director, setDirector] = useState<DirectorInfo | null>(null);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [track, setTrack] = useState<AudioTrack | null>(null);

  const [redesigning, setRedesigning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const [account, setAccount] = useState<api.Account | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [signInFor, setSignInFor] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);

  const tokenRef = useRef<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const watcherRef = useRef<{ close: () => void } | null>(null);
  const previewRef = useRef<PreviewHandle>(null);

  const audioUrl = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  /* ------------------------------- boot -------------------------------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [serverConfig, capability] = await Promise.all([
          api.getConfig(),
          detectSupport(),
        ]);
        if (cancelled) return;
        setConfig(serverConfig);
        setSupport(capability);

        if (serverConfig.auth?.devStub) {
          setAuthUser(stubRestore());
        } else {
          await initAuth(serverConfig);
          tidyCallbackUrl();
        }
      } catch (e) {
        if (!cancelled) setBootError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* Sessions can start, refresh and end at any moment, including on the
     round trip back from a magic link. One subscription, one source of truth. */
  useEffect(() => onAuthChange(setAuthUser), []);

  /* Whoever is signed in, ask the server what they have. The browser never
     works this out for itself — the credit balance lives behind the API. */
  useEffect(() => {
    if (!authUser) { setAccount(null); return; }
    let cancelled = false;
    api.getMe()
      .then((me) => { if (!cancelled) setAccount(me.account); })
      .catch(() => { if (!cancelled) setAccount(null); });
    return () => { cancelled = true; };
  }, [authUser]);

  /* A song already paid for stays paid for, even in a brand new job. */
  useEffect(() => {
    if (!authUser || !jobIdRef.current || !tokenRef.current || screen !== 'studio') return;
    let cancelled = false;
    api.getJob(jobIdRef.current, tokenRef.current)
      .then((view) => { if (!cancelled) setUnlocked(Boolean(view.unlocked)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authUser, screen]);

  /* The interface wears the song's accent colour once one exists. */
  useEffect(() => {
    const root = document.documentElement;
    if (plan) {
      root.style.setProperty('--accent', plan.palette.accent);
      // Pick readable text for buttons filled with the accent.
      const { r, g, b } = hexToRgb(plan.palette.accent);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      root.style.setProperty('--accent-ink', luminance > 0.6 ? '#0a0b0d' : '#ffffff');
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-ink');
    }
  }, [plan]);

  useEffect(() => {
    if (config && plan) {
      void ensureFont(fontStackFor(config.fonts, plan.typography.font), [plan.typography.weight]);
    }
  }, [config, plan?.typography.font, plan?.typography.weight]);

  useEffect(() => () => { watcherRef.current?.close(); }, []);

  /* ------------------------------ dropping ------------------------------ */

  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const dropped = [...(event.dataTransfer?.files ?? [])];
      const audio = dropped.find(isAudioFile);
      const pictures = dropped.filter((f) => f.type.startsWith('image/'));
      if (audio) acceptAudio(audio);
      if (pictures.length) void addReferences(pictures);
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  });

  const acceptAudio = (next: File) => {
    if (config && next.size > config.limits.maxAudioBytes) {
      setError(`That file is ${formatBytes(next.size)}. The limit is ${formatBytes(config.limits.maxAudioBytes)}.`);
      return;
    }
    setError(null);
    setFile(next);
    setAudioBuffer(null);
    if (!title) setTitle(guessTitle(next.name));

    // Decode straight away: it takes a second or two and the result is needed
    // for both the reactivity table and the export.
    void decodeAudioFile(next)
      .then((buffer) => {
        setAudioBuffer(buffer);
        // Duration rounded to the nearest 30s. Enough to see whether people
        // bring three-minute songs or twelve-minute ones; not enough to
        // identify a track.
        trackEvent('song_selected', { duration_bucket: Math.round(buffer.duration / 30) * 30 });
      })
      .catch(() => {
        setError('That file could not be decoded as audio. MP3, M4A, WAV and FLAC all work.');
        trackEvent('generate_failed', { stage: 'decode' });
      });
  };

  const addReferences = async (files: File[]) => {
    const loaded: Reference[] = [];
    for (const picture of files.slice(0, 8)) {
      try { loaded.push(await loadReference(picture)); } catch { /* skip unreadable */ }
    }
    setReferences((existing) => [...existing, ...loaded].slice(0, 8));
  };

  const removeReference = (id: string) => {
    setReferences((existing) => {
      const target = existing.find((r) => r.id === id);
      if (target) releaseReference(target);
      return existing.filter((r) => r.id !== id);
    });
  };

  /* ------------------------------ the run ------------------------------- */

  const currentPrefs = useCallback((): Prefs => ({
    ...prefs,
    title: title.trim(),
    artist: artist.trim(),
    imageColors: mergeColours(references),
    photoCount: references.length,
  }), [prefs, title, artist, references]);

  const generate = async () => {
    if (!file || !lyrics.trim()) return;
    setError(null);
    setScreen('working');
    setUploadFraction(0);
    const startedAt = performance.now();
    trackEvent('generate_started', { signed_in: Boolean(authUser), pictures: references.length });

    try {
      const created = await api.createJob(lyrics, currentPrefs());
      tokenRef.current = created.token;
      jobIdRef.current = created.id;
      setJob(created.job);

      await api.uploadAudio(created.id, created.token, file, setUploadFraction);
      const started = await api.startJob(created.id, created.token);
      setJob(started.job);

      const watcher = api.watchJob(created.id, created.token, setJob);
      watcherRef.current = watcher;
      const finished = await watcher.done;

      if (!finished.alignment || !finished.plan) {
        throw new Error('The server finished but sent no result.');
      }

      setAlignment(finished.alignment);
      setPlan(finished.plan);
      setDirector(finished.director ?? null);
      setScreen('studio');

      trackEvent('video_ready', {
        seconds: Math.round((performance.now() - startedAt) / 1000),
        template: finished.plan.template,
        // How well the words matched the vocal is the single best predictor
        // of whether somebody will bother exporting.
        alignment: finished.alignment.quality.verdict,
        sections: finished.alignment.segments.length,
      });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        setScreen('setup');
        return;
      }
      setError((e as Error).message);
      setScreen('setup');
      trackEvent('generate_failed', { stage: 'align' });
    }
  };

  /* Build the reactivity table once both halves have arrived. */
  useEffect(() => {
    if (!audioBuffer || !alignment) return;
    let cancelled = false;
    // Deferred a tick so the studio can paint before the FFT sweep starts.
    const timer = setTimeout(() => {
      if (cancelled) return;
      setTrack(buildAudioTrack(audioBuffer, alignment.audio, TRACK_FPS));
    }, 30);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [audioBuffer, alignment]);

  const redesign = async () => {
    if (!jobIdRef.current || !tokenRef.current) return;
    setRedesigning(true);
    setError(null);
    try {
      const result = await api.redirectJob(jobIdRef.current, tokenRef.current, currentPrefs());
      // Keep whatever output settings the user changed locally; the director
      // has no opinion about resolution and should not reset it.
      setPlan((existing) => (existing
        ? { ...result.plan, aspect: existing.aspect, resolution: existing.resolution, fps: existing.fps }
        : result.plan));
      setDirector(result.director);
      trackEvent('redesigned', { template: result.plan.template });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRedesigning(false);
    }
  };

  const unlock = async () => {
    if (!jobIdRef.current || !tokenRef.current) throw new Error('No song to unlock.');
    const result = await api.unlockJob(jobIdRef.current, tokenRef.current);
    setUnlocked(true);
    setAccount((existing) => (existing
      ? { ...existing, remaining: result.remaining, unlocked: existing.unlocked + (result.already ? 0 : 1) }
      : existing));
  };

  const requestExport = () => {
    previewRef.current?.pause();
    if (config?.auth?.enabled && !authUser) {
      setSignInFor('Sign in to download your video');
      trackEvent('signin_prompted', { from: 'export' });
      return;
    }
    setExporting(true);
  };

  const patchPlan = (patch: Partial<Plan>) => {
    setPlan((existing) => (existing ? { ...existing, ...patch } : existing));
  };

  const startOver = () => {
    watcherRef.current?.close();
    previewRef.current?.pause();
    setScreen('setup');
    setJob(null);
    setAlignment(null);
    setPlan(null);
    setDirector(null);
    setTrack(null);
    setCurrentTime(0);
    setUnlocked(false);
  };

  /* -------------------------------- views ------------------------------- */

  if (bootError) {
    return (
      <main className="shell" style={{ paddingTop: 80 }}>
        <Notice tone="bad">Could not reach the server: {bootError}</Notice>
      </main>
    );
  }

  if (!config || !support) {
    return (
      <main className="shell" style={{ paddingTop: 120, display: 'grid', placeItems: 'center' }}>
        <Spinner />
      </main>
    );
  }

  const scene: Scene | null = plan && alignment && track
    ? {
      plan,
      alignment,
      audio: track,
      photos: references.map((r) => r.bitmap),
      fontStack: fontStackFor(config.fonts, plan.typography.font),
      fontOptical: fontOpticalFor(config.fonts, plan.typography.font),
    }
    : null;

  return (
    <>
      <header className="topbar">
        <div className="wordmark">video<span>lyrics</span></div>
        {alignment && (
          <div className="topbar-meta">
            <span>{formatTime(alignment.duration)}</span>
            <span className="dot">·</span>
            <span>{Math.round(alignment.audio.tempo)} BPM</span>
            <span className="dot">·</span>
            <span>{alignment.audio.key} {alignment.audio.mode}</span>
          </div>
        )}
        {screen === 'studio' && (
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 16 }} onClick={startOver}>
            New song
          </button>
        )}

        {config.auth?.enabled && (
          <div className="account">
            {authUser ? (
              <>
                <span className="credits" data-empty={account?.remaining === 0 ? 'true' : 'false'} title={
                  account?.resets_at
                    ? `Resets ${new Date(account.resets_at).toLocaleDateString()}`
                    : undefined
                }>
                  <b className="mono">{account ? account.remaining : '—'}</b>
                  <span>left</span>
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    if (config.auth?.devStub) stubSignOut();
                    else void signOut();
                    setUnlocked(false);
                  }}
                  title={authUser.email ?? undefined}
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setSignInFor('Sign in to videolyrics')}
              >
                Sign in
              </button>
            )}
          </div>
        )}
      </header>

      {dragging && screen === 'setup' && (
        <div className="drag-veil" aria-hidden="true">
          <strong>Drop the song</strong>
        </div>
      )}

      <main className="shell">
        {screen === 'setup' && (
          <Setup
            config={config}
            support={support}
            file={file}
            audioBuffer={audioBuffer}
            lyrics={lyrics}
            title={title}
            artist={artist}
            references={references}
            prefs={prefs}
            error={error}
            onFile={acceptAudio}
            onLyrics={setLyrics}
            onTitle={setTitle}
            onArtist={setArtist}
            onPrefs={(patch) => setPrefs((existing) => ({ ...existing, ...patch }))}
            onAddReferences={addReferences}
            onRemoveReference={removeReference}
            onGenerate={generate}
          />
        )}

        {screen === 'working' && (
          <Working config={config} job={job} uploadFraction={uploadFraction} onCancel={startOver} />
        )}

        {screen === 'studio' && plan && alignment && (
          <div className="studio fade-in">
            <div className="stack">
              {scene ? (
                <Preview
                  ref={previewRef}
                  scene={scene}
                  audioUrl={audioUrl}
                  onTime={setCurrentTime}
                />
              ) : (
                <div className="stage" style={{ aspectRatio: '16 / 9', display: 'grid', placeItems: 'center' }}>
                  <div className="row" style={{ gap: 10 }}>
                    <Spinner />
                    <span className="hint">Measuring the audio for the visuals…</span>
                  </div>
                </div>
              )}

              {error && <Notice tone="bad">{error}</Notice>}

              {alignment.quality.verdict === 'poor' && (
                <Notice tone="warn">
                  The words did not match the vocal confidently. That usually means the lyrics belong
                  to a different recording, or the vocal is buried in the mix. The timings will drift.
                </Notice>
              )}

              <section className="card">
                <CardHead
                  title="Cue sheet"
                  aside={`${alignment.segments.length} sections`}
                />
                {plan.notes && <p className="hint" style={{ marginBottom: 12 }}>{plan.notes}</p>}
                <CueSheet
                  alignment={alignment}
                  plan={plan}
                  currentTime={currentTime}
                  onSeek={(t) => previewRef.current?.seek(t)}
                />
                {director && (
                  <p className="hint" style={{ marginTop: 12 }}>
                    {director.llm.used
                      ? `Designed by ${director.llm.provider} (${director.llm.model}).`
                      : `Designed from the audio analysis. ${director.llm.reason ?? ''}`}
                  </p>
                )}
              </section>
            </div>

            <div className="stack">
              {support.ok ? (
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  style={{ width: '100%' }}
                  disabled={!scene || !audioBuffer}
                  onClick={requestExport}
                >
                  Export MP4
                </button>
              ) : (
                <Notice tone="warn">
                  <strong>{support.reason}</strong>
                  <br />{support.advice}
                </Notice>
              )}

              <StylePanel
                config={config}
                plan={plan}
                prefs={prefs}
                busy={redesigning}
                onPrefs={(patch) => setPrefs((existing) => ({ ...existing, ...patch }))}
                onPlan={patchPlan}
                onRedesign={redesign}
              />
            </div>
          </div>
        )}
      </main>

      <footer className="site shell">
        <p>
          Songs and lyrics stay yours. Uploads are deleted after {config.limits.retentionHours} hours,
          reference pictures never leave your browser, and the video is encoded on your own machine.
        </p>
        {/* Plain anchors, not router links: these are static pages served by
            Caddy, and Google's OAuth consent screen requires both to be
            reachable at a stable URL on this domain. */}
        <p className="legal-links">
          <a href="/privacy.html">Privacy Policy</a>
          <a href="/terms.html">Terms of Service</a>
        </p>
      </footer>

      {exporting && scene && audioBuffer && plan && file && (
        <ExportDialog
          scene={scene}
          plan={plan}
          audioFile={file}
          audioBuffer={audioBuffer}
          unlocked={unlocked || !config.auth?.enabled}
          creditsRemaining={account ? account.remaining : null}
          resetsAt={account?.resets_at ?? null}
          onUnlock={unlock}
          onClose={() => setExporting(false)}
        />
      )}

      {signInFor && (
        <SignIn
          config={config}
          reason={signInFor}
          onClose={() => setSignInFor(null)}
          onStubSignedIn={() => setAuthUser(stubRestore())}
        />
      )}
    </>
  );
}

/* --------------------------------- setup ---------------------------------- */

function Setup(props: {
  config: ServerConfig;
  support: Support;
  file: File | null;
  audioBuffer: AudioBuffer | null;
  lyrics: string;
  title: string;
  artist: string;
  references: Reference[];
  prefs: Prefs;
  error: string | null;
  onFile: (file: File) => void;
  onLyrics: (value: string) => void;
  onTitle: (value: string) => void;
  onArtist: (value: string) => void;
  onPrefs: (patch: Prefs) => void;
  onAddReferences: (files: File[]) => void;
  onRemoveReference: (id: string) => void;
  onGenerate: () => void;
}) {
  const {
    config, support, file, audioBuffer, lyrics, title, artist, references, prefs,
    error, onFile, onLyrics, onTitle, onArtist, onPrefs,
    onAddReferences, onRemoveReference, onGenerate,
  } = props;

  const audioInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  const lines = lyrics.trim() ? lyrics.trim().split('\n').filter((l) => l.trim()).length : 0;
  const ready = Boolean(file && lyrics.trim());

  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow" style={{ marginBottom: 14 }}>Lyric videos, made by listening</p>
          <h1>Give it a song.<br />Get back a <em>video</em>.</h1>
          <p className="hero-lede">
            Upload the track and paste the lyrics. It listens to the vocal, works out when every
            single word is sung, reads the lyrics for mood, and designs the whole thing — then your
            browser encodes the MP4.
          </p>

          {/* The only way in. There was a second drop target below this button,
              which asked people to make the same decision twice; dropping a
              file anywhere on the page still works and always did. */}
          <input
            ref={audioInput}
            type="file"
            accept={`audio/*,${AUDIO_TYPES.join(',')}`}
            className="sr-only"
            onChange={(event) => {
              const picked = event.target.files?.[0];
              if (picked) onFile(picked);
              event.target.value = '';
            }}
          />
          {file ? (
            <div className="stack-sm" style={{ maxWidth: 460 }}>
              <div className="file-row">
                <span className="name">{file.name}</span>
                <span className="meta mono hint">
                  {formatBytes(file.size)}
                  {audioBuffer ? ` · ${formatTime(audioBuffer.duration)}` : ' · reading…'}
                </span>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => audioInput.current?.click()}>
                Choose a different song
              </button>
            </div>
          ) : (
            <div className="hero-actions">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => audioInput.current?.click()}
              >
                Choose a song
              </button>
              <span className="hint">or drop a file anywhere on this page</span>
            </div>
          )}

          <div className="hero-facts">
            <span><b>Word-level</b> timing, not line-level</span>
            <span><b>{config.templates.length}</b> looks</span>
            <span><b>{config.palettes.length}</b> palettes</span>
            <span><b>Up to {Math.round(config.limits.maxDurationSeconds / 60)} min</b> per song</span>
          </div>
        </div>
        <HeroCanvas fonts={config.fonts} label="Live — not a recording" />
      </section>

      {/* Left is what the video is made of, right is how it looks. The design
          controls are the same component the studio uses, offered here so the
          first render is already the one you wanted — regenerating to change a
          font costs a minute and a credit's worth of patience. */}
      <div className="composer">
        <div className="composer-main">
          <section className="card card-grow">
            <CardHead
              step={1}
              done={lines > 0}
              title="The lyrics"
              aside={lines ? `${lines} lines` : undefined}
            />
            <textarea
              className="textarea"
              value={lyrics}
              onChange={(event) => onLyrics(event.target.value)}
              placeholder={
                'Paste the lyrics here, one line per line as they are sung.\n\n' +
                'Leave a blank line between verses.\n' +
                'Section markers like [Chorus] are understood and never appear on screen.'
              }
              spellCheck={false}
              maxLength={config.limits.maxLyricChars}
            />
            <p className="hint" style={{ marginTop: 8 }}>
              Punctuation and capitals are kept exactly as you type them — that is what ends up on screen.
            </p>
          </section>

          <section className="card">
            <CardHead title="Details" aside="optional" />
            <div className="stack-sm">
              <div className="two-up">
                <div className="field">
                  <label htmlFor="title">Title card</label>
                  <input
                    id="title"
                    className="input"
                    value={title}
                    onChange={(event) => onTitle(event.target.value)}
                    placeholder="Song title"
                  />
                </div>
                <div className="field">
                  <label htmlFor="artist">Artist</label>
                  <input
                    id="artist"
                    className="input"
                    value={artist}
                    onChange={(event) => onArtist(event.target.value)}
                    placeholder="Who made it"
                  />
                </div>
              </div>

              <div className="field">
                <label>Reference pictures</label>
                <span className="hint">
                  Used in the video and to steer the colours. They stay in your browser — only the
                  colours pulled out of them are sent.
                </span>
                <input
                  ref={imageInput}
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  onChange={(event) => {
                    const picked = [...(event.target.files ?? [])];
                    if (picked.length) onAddReferences(picked);
                    event.target.value = '';
                  }}
                />
                <div className="refs">
                  {references.map((reference) => (
                    <div className="ref" key={reference.id}>
                      <img src={reference.thumbnail} alt="" />
                      <button type="button" onClick={() => onRemoveReference(reference.id)} aria-label="Remove picture">×</button>
                      <span className="colours">
                        {reference.colours.map((colour) => <i key={colour} style={{ background: colour }} />)}
                      </span>
                    </div>
                  ))}
                  {references.length < 8 && (
                    <button
                      type="button"
                      className="ref"
                      style={{ background: 'var(--ink-raise)', cursor: 'pointer', color: 'var(--muted)', fontSize: 22 }}
                      onClick={() => imageInput.current?.click()}
                      aria-label="Add pictures"
                    >
                      +
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card" style={{ paddingBottom: 14 }}>
            <CardHead title="How it looks" aside="all optional" />
            <p className="hint">
              Every one of these can be left alone — anything you do not set is chosen by reading the
              music and the lyrics. Set them now and the first video is already yours.
            </p>
          </section>

          <DesignControls config={config} prefs={prefs} onPrefs={onPrefs} />

          <section className="card">
            <CardHead title="Output" />
            <div className="stack-sm">
              <div className="field">
                <label htmlFor="aspect">Shape</label>
                <select
                  id="aspect"
                  className="select"
                  value={prefs.aspect ?? ''}
                  onChange={(event) => onPrefs({ aspect: event.target.value || undefined })}
                >
                  <option value="">Auto — 16:9 unless the pictures suggest otherwise</option>
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
                    value={prefs.resolution ?? ''}
                    onChange={(event) => onPrefs({ resolution: event.target.value ? Number(event.target.value) : undefined })}
                  >
                    <option value="">Auto</option>
                    <option value={720}>720p</option>
                    <option value={1080}>1080p</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="fps">Frame rate</label>
                  <select
                    id="fps"
                    className="select"
                    value={prefs.fps ?? ''}
                    onChange={(event) => onPrefs({ fps: event.target.value ? Number(event.target.value) : undefined })}
                  >
                    <option value="">Auto</option>
                    <option value={24}>24 fps</option>
                    <option value={30}>30 fps</option>
                    <option value={60}>60 fps</option>
                  </select>
                </div>
              </div>
            </div>
          </section>

          {error && <Notice tone="bad">{error}</Notice>}

          {!support.ok && (
            <Notice tone="warn">
              <strong>{support.reason}</strong><br />{support.advice}
            </Notice>
          )}

          <button
            type="button"
            className="btn btn-primary btn-lg"
            style={{ width: '100%' }}
            disabled={!ready}
            onClick={onGenerate}
          >
            Make the video
          </button>
          <p className="hint">
            {ready
              ? 'Takes about a minute per minute of song. You can watch it work.'
              : file
                ? 'Paste the lyrics to start.'
                : 'Choose a song and paste the lyrics to start.'}
          </p>
        </div>
      </div>
    </>
  );
}

/* -------------------------------- working --------------------------------- */

function Working(
  { config, job, uploadFraction, onCancel }:
  { config: ServerConfig; job: Job | null; uploadFraction: number; onCancel: () => void },
) {
  const uploading = !job || job.state === 'created';
  const fraction = uploading ? uploadFraction * 0.15 : 0.15 + (job.progress ?? 0) * 0.85;
  const stageIndex = STAGES.findIndex((s) => s.key === job?.stage);

  return (
    <div className="working fade-in">
      <div className="working-stage">
        <HeroCanvas fonts={config.fonts} />
      </div>

      <div className="stack" style={{ justifyItems: 'center', gap: 14 }}>
        <h2>
          {uploading
            ? `Uploading — ${Math.round(uploadFraction * 100)}%`
            : job?.queuePosition
              ? job.message
              : job?.message ?? 'Working…'}
        </h2>

        <div className="meter"><i style={{ width: `${Math.round(fraction * 100)}%` }} /></div>

        <ul className="stage-list">
          {STAGES.map((stage, index) => (
            <li
              key={stage.key}
              data-state={
                stageIndex === index ? 'active' : stageIndex > index ? 'done' : 'waiting'
              }
            >
              {stage.label}
            </li>
          ))}
        </ul>

        <p className="hint" style={{ maxWidth: '46ch' }}>
          It is matching every word in your lyrics to the vocal in the recording. This is the slow
          part — the video itself is drawn in your browser afterwards and is much faster.
        </p>

        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* -------------------------------- helpers --------------------------------- */

function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true;
  return AUDIO_TYPES.some((extension) => file.name.toLowerCase().endsWith(extension));
}

function guessTitle(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  // Strip the leading track number people's files usually carry.
  return base.replace(/^\d+[\s._-]+/, '').replace(/[_]+/g, ' ').trim().slice(0, 60);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = Number.parseInt(full.slice(0, 6), 16);
  return Number.isNaN(n) ? { r: 0, g: 0, b: 0 } : { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
