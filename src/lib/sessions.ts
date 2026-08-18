/**
 * Work in progress, kept across a page load.
 *
 * Signing in with Google is a full page navigation: the browser leaves for
 * accounts.google.com and comes back to a brand new document. Everything the
 * app had in memory — the decoded audio, the alignment, the plan — is gone by
 * the time it returns, which meant clicking "Download MP4" and signing in
 * threw away the very video you were trying to download.
 *
 * The audio is the hard part. It is tens of megabytes and a File cannot be
 * serialised, which rules out localStorage; IndexedDB stores Blobs natively
 * and has room. Everything else is small enough to sit beside it, except the
 * alignment and the plan, which are deliberately *not* stored: the server
 * still has them, and refetching keeps one copy authoritative rather than two
 * copies drifting.
 *
 * Sessions expire with the server's own retention window. A session whose job
 * the server has already deleted cannot be restored, so keeping it locally
 * would only offer people a door that opens onto nothing.
 */

import type { Prefs } from '../types';

const DB_NAME = 'videolyrics';
const DB_VERSION = 1;
const META = 'meta';
const AUDIO = 'audio';
const ACTIVE_KEY = 'videolyrics.active';

export interface SessionMeta {
  id: string;
  token: string;
  createdAt: number;
  title: string;
  artist: string;
  lyrics: string;
  prefs: Prefs;
  audioName: string;
  audioType: string;
  durationSeconds: number;
  template: string | null;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null); // blocked storage, or a browser refusing in private mode
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function done<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** Remember a finished job, audio and all, so it survives a page load. */
export async function saveSession(meta: SessionMeta, audio: Blob): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction([META, AUDIO], 'readwrite');
    tx.objectStore(META).put(meta);
    tx.objectStore(AUDIO).put(audio, meta.id);
    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve; });
  } finally {
    db.close();
  }
}

/** Newest first, and never anything the server will already have dropped. */
export async function listSessions(retentionHours: number): Promise<SessionMeta[]> {
  const db = await open();
  if (!db) return [];
  try {
    const tx = db.transaction([META], 'readonly');
    const all = (await done(tx.objectStore(META).getAll() as IDBRequest<SessionMeta[]>)) ?? [];
    const cutoff = Date.now() - retentionHours * 3600_000;
    const live = all.filter((s) => s.createdAt > cutoff);
    // Anything the server has expired is swept on the way past, so the list
    // does not quietly grow forever in someone's browser.
    if (live.length !== all.length) {
      const stale = all.filter((s) => s.createdAt <= cutoff).map((s) => s.id);
      void Promise.all(stale.map(deleteSession));
    }
    return live.sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    db.close();
  }
}

export async function getSession(id: string): Promise<{ meta: SessionMeta; audio: Blob } | null> {
  const db = await open();
  if (!db) return null;
  try {
    const tx = db.transaction([META, AUDIO], 'readonly');
    const meta = await done(tx.objectStore(META).get(id) as IDBRequest<SessionMeta>);
    const audio = await done(tx.objectStore(AUDIO).get(id) as IDBRequest<Blob>);
    if (!meta || !audio) return null;
    return { meta, audio };
  } finally {
    db.close();
  }
}

export async function deleteSession(id: string): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction([META, AUDIO], 'readwrite');
    tx.objectStore(META).delete(id);
    tx.objectStore(AUDIO).delete(id);
    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve; });
  } finally {
    db.close();
  }
  if (activeSession() === id) clearActive();
}

/* The one the browser should reopen on its own. Kept in localStorage rather
   than IndexedDB so it can be read synchronously during the first render. */
export function markActive(id: string): void {
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* nothing to do */ }
}

export function activeSession(): string | null {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}

export function clearActive(): void {
  try { localStorage.removeItem(ACTIVE_KEY); } catch { /* nothing to do */ }
}
