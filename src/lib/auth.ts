/**
 * Sign-in.
 *
 * Supabase's auth client is used rather than hand-rolled fetch calls, because
 * the fiddly parts — PKCE for the OAuth round trip, parsing the callback out
 * of the URL, refreshing an access token before it expires, persisting a
 * session across reloads — are exactly the parts that fail quietly and lock
 * people out. It is loaded on demand so the landing page does not pay for it.
 *
 * The database is never touched from here. The browser holds a session and
 * sends the access token to our own API, which is the only thing that may
 * read or spend credits.
 */

import type { AuthChangeEvent, GoTrueClient, Session } from '@supabase/auth-js';

import * as api from '../api';
import type { ServerConfig } from '../types';

export interface AuthUser {
  id: string;
  email: string | null;
}

type Listener = (user: AuthUser | null) => void;

let client: GoTrueClient | null = null;
let ready: Promise<GoTrueClient | null> | null = null;
const listeners = new Set<Listener>();

function publish(session: Session | null): void {
  api.setAccessToken(session?.access_token ?? null);
  const user = session?.user
    ? { id: session.user.id, email: session.user.email ?? null }
    : null;
  for (const listener of listeners) listener(user);
}

/**
 * Create the client once, from server-provided configuration.
 * Resolves to null when accounts are not configured on this deployment, which
 * is a supported state — everything except the download still works.
 */
export function initAuth(config: ServerConfig): Promise<GoTrueClient | null> {
  if (ready) return ready;

  if (!config.auth?.enabled) {
    ready = Promise.resolve(null);
    return ready;
  }

  if (config.auth.devStub) {
    ready = Promise.resolve(null);
    return ready;
  }

  ready = (async () => {
    const { GoTrueClient } = await import('@supabase/auth-js');
    client = new GoTrueClient({
      url: `${config.auth.url}/auth/v1`,
      headers: { apikey: config.auth.anonKey! },
      // PKCE keeps the OAuth code exchange safe in a public client, and is
      // what Supabase's own redirect flow expects.
      flowType: 'pkce',
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      storageKey: 'videolyrics.auth',
    });

    client.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      publish(session);
    });

    const { data } = await client.getSession();
    publish(data.session ?? null);
    return client;
  })();

  return ready;
}

export function onAuthChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Where Supabase should send people back to after a magic link or Google. */
function redirectTo(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

export async function sendMagicLink(email: string): Promise<void> {
  const auth = await ready;
  if (!auth) throw new Error('Sign-in is not configured on this server.');

  const { error } = await auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: redirectTo(), shouldCreateUser: true },
  });
  if (error) throw new Error(friendly(error.message));
}

export async function signInWithGoogle(): Promise<void> {
  const auth = await ready;
  if (!auth) throw new Error('Sign-in is not configured on this server.');

  const { data, error } = await auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: redirectTo() },
  });
  if (error) throw new Error(friendly(error.message));
  // auth-js hands back the URL rather than navigating, so the caller decides
  // when the page goes away.
  if (data?.url) window.location.assign(data.url);
}

export async function signOut(): Promise<void> {
  const auth = await ready;
  await auth?.signOut();
  publish(null);
}

/**
 * Strip the auth callback out of the address bar.
 *
 * detectSessionInUrl consumes the token, but leaves the fragment behind, and
 * a URL carrying `#access_token=…` is one someone will paste into a chat.
 */
export function tidyCallbackUrl(): void {
  const dirty = window.location.hash.includes('access_token')
    || window.location.hash.includes('error_description')
    || new URLSearchParams(window.location.search).has('code');
  if (!dirty) return;
  window.history.replaceState({}, '', window.location.pathname);
}

function friendly(message: string): string {
  const text = String(message);
  if (/rate limit|too many/i.test(text)) {
    return 'Too many sign-in emails just now. Give it a minute and try again.';
  }
  if (/invalid.*email|valid email/i.test(text)) return 'That email address does not look right.';
  if (/signups? not allowed|disabled/i.test(text)) return 'New sign-ups are turned off on this server.';
  return text;
}

/* ------------------------------ the dev stub ------------------------------ */
/*
 * When the server is running its development auth stub there is no Supabase to
 * talk to, and the "session" is just a string. This keeps the entire UI, the
 * gating and the credit counter exercisable — including in the automated
 * browser run — before anybody has created a cloud project.
 */

const STUB_KEY = 'videolyrics.devauth';

export function stubSignIn(email: string): void {
  localStorage.setItem(STUB_KEY, email.trim().toLowerCase());
  const token = `dev:${email.trim().toLowerCase()}`;
  api.setAccessToken(token);
  for (const listener of listeners) listener({ id: token, email: email.trim().toLowerCase() });
}

export function stubRestore(): AuthUser | null {
  const email = localStorage.getItem(STUB_KEY);
  if (!email) return null;
  api.setAccessToken(`dev:${email}`);
  return { id: `dev:${email}`, email };
}

export function stubSignOut(): void {
  localStorage.removeItem(STUB_KEY);
  api.setAccessToken(null);
  for (const listener of listeners) listener(null);
}
