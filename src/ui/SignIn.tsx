/**
 * The sign-in sheet.
 *
 * It appears at the moment somebody tries to download, which is the moment
 * they have already seen their own song working — so it explains what an
 * account is *for* rather than asking them to want one in the abstract.
 */

import { useState } from 'react';

import type { ServerConfig } from '../types';
import { sendMagicLink, signInWithGoogle, stubSignIn } from '../lib/auth';
import { Notice, Spinner } from './bits';

interface Props {
  config: ServerConfig;
  /** What the person was trying to do when this appeared. */
  reason?: string;
  onClose: () => void;
  onStubSignedIn?: () => void;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'sending' }
  | { kind: 'sent'; email: string }
  | { kind: 'failed'; message: string };

export function SignIn({ config, reason, onClose, onStubSignedIn }: Props) {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });

  const devStub = config.auth?.devStub;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim()) return;

    if (devStub) {
      stubSignIn(email);
      onStubSignedIn?.();
      onClose();
      return;
    }

    setPhase({ kind: 'sending' });
    try {
      await sendMagicLink(email);
      setPhase({ kind: 'sent', email: email.trim() });
    } catch (error) {
      setPhase({ kind: 'failed', message: (error as Error).message });
    }
  };

  const google = async () => {
    try {
      await signInWithGoogle();
    } catch (error) {
      setPhase({ kind: 'failed', message: (error as Error).message });
    }
  };

  return (
    <div
      className="scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="dialog">
        {phase.kind === 'sent' ? (
          <>
            <h2>Check your email</h2>
            <Notice tone="good">
              A sign-in link is on its way to <strong>{phase.email}</strong>. Open it on this
              device and you will come straight back here.
            </Notice>
            <p className="hint">
              Nothing you have done is lost — your song stays in this tab while you fetch it.
            </p>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          </>
        ) : (
          <>
            <h2>{reason ?? 'Sign in to download'}</h2>
            <p className="hint">
              Free, and it takes one click. An account gets you{' '}
              <strong>{config.auth?.freeCredits ?? 5} videos a month</strong> — a video stays yours
              once unlocked, so you can re-export it at any size or restyle it as often as you like
              without spending another.
            </p>

            {devStub && (
              <Notice tone="warn">
                This server is running the development sign-in stub. Any email address will do and
                no message is sent.
              </Notice>
            )}

            {config.auth?.google && !devStub && (
              <>
                <button type="button" className="btn btn-lg" style={{ width: '100%' }} onClick={google}>
                  <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
                    <path fill="#4285F4" d="M17.6 9.2c0-.6-.05-1.2-.15-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z" />
                    <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z" />
                    <path fill="#FBBC05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8l3-2.3z" />
                    <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z" />
                  </svg>
                  Continue with Google
                </button>
                <div className="row" style={{ gap: 12 }}>
                  <span className="divider" style={{ flex: 1 }} />
                  <span className="eyebrow">or</span>
                  <span className="divider" style={{ flex: 1 }} />
                </div>
              </>
            )}

            <form onSubmit={submit} className="stack-sm">
              <div className="field">
                <label htmlFor="signin-email">Email</label>
                <input
                  id="signin-email"
                  className="input"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                />
              </div>

              {phase.kind === 'failed' && <Notice tone="bad">{phase.message}</Notice>}

              <div className="row">
                <button type="button" className="btn btn-ghost" onClick={onClose}>Not now</button>
                <button
                  type="submit"
                  className="btn btn-primary row-end"
                  disabled={phase.kind === 'sending' || !email.trim()}
                >
                  {phase.kind === 'sending'
                    ? <><Spinner /> Sending…</>
                    : devStub ? 'Sign in' : 'Send me a link'}
                </button>
              </div>
            </form>

            {!devStub && (
              <p className="hint">
                No password. We email you a link; opening it signs you in.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
