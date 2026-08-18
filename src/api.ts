/** Thin client over the job API. */

import type { Job, Plan, DirectorInfo, Prefs, ServerConfig } from './types';

const BASE = '/api';

/**
 * Two credentials travel to the API and they mean different things.
 * `Authorization: Bearer` is the Supabase session — who you are. `X-Job-Token`
 * is a capability for one job — what you may touch. Sharing a header between
 * them would make /unlock impossible to express.
 */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

function headers(jobToken?: string, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { ...extra };
  if (accessToken) out.authorization = `Bearer ${accessToken}`;
  if (jobToken) out['x-job-token'] = jobToken;
  return out;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(BASE + path, init);
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (!response.ok) {
    throw new ApiError(payload?.error || `Request failed (${response.status})`, response.status);
  }
  return payload as T;
}

export function getConfig(): Promise<ServerConfig> {
  return request<ServerConfig>('/config');
}

export interface CreatedJob {
  id: string;
  token: string;
  job: Job;
}

export function createJob(lyrics: string, prefs: Prefs): Promise<CreatedJob> {
  return request<CreatedJob>('/jobs', {
    method: 'POST',
    headers: headers(undefined, { 'content-type': 'application/json' }),
    body: JSON.stringify({ lyrics, prefs }),
  });
}

export interface Account {
  ok: boolean;
  email: string | null;
  remaining: number;
  per_period: number;
  resets_at: string | null;
  unlocked: number;
}

export function getMe(): Promise<{ user: { id: string; email: string | null }; account: Account }> {
  return request('/me', { headers: headers() });
}

export function unlockJob(id: string, jobToken: string): Promise<{
  ok: boolean; already: boolean; remaining: number; resetsAt: string | null;
}> {
  return request(`/jobs/${id}/unlock`, { method: 'POST', headers: headers(jobToken) });
}

export function getJob(id: string, jobToken: string, full = false): Promise<Job> {
  return request<Job>(`/jobs/${id}${full ? '?full=1' : ''}`, { headers: headers(jobToken) });
}

/**
 * Upload with progress. fetch() still cannot report upload progress, and on a
 * home connection a 30 MB mp3 is the longest single wait in the whole flow —
 * so this one call uses XHR.
 */
export function uploadAudio(
  id: string,
  token: string,
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ bytes: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${BASE}/jobs/${id}/audio`);
    xhr.setRequestHeader('x-job-token', token);
    if (accessToken) xhr.setRequestHeader('authorization', `Bearer ${accessToken}`);
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name).slice(0, 120));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      let payload: any = null;
      try { payload = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new ApiError(payload?.error || `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Upload failed. Check your connection.', 0));
    xhr.onabort = () => reject(new DOMException('Upload cancelled.', 'AbortError'));

    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export function startJob(id: string, token: string): Promise<{ job: Job }> {
  return request<{ job: Job }>(`/jobs/${id}/start`, {
    method: 'POST',
    headers: headers(token),
  });
}

export function redirectJob(
  id: string, token: string, prefs: Prefs, useLlm = true,
): Promise<{ plan: Plan; director: DirectorInfo }> {
  return request<{ plan: Plan; director: DirectorInfo }>(`/jobs/${id}/redirect`, {
    method: 'POST',
    headers: headers(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ prefs, useLlm }),
  });
}

export function cancelJob(id: string, token: string): Promise<void> {
  return request(`/jobs/${id}`, {
    method: 'DELETE',
    headers: headers(token),
  });
}

/**
 * Follow a job to completion over server-sent events.
 *
 * The stream carries the finished alignment and plan in its last message, so
 * a successful run needs no follow-up fetch.
 */
export function watchJob(
  id: string,
  token: string,
  onUpdate: (job: Job) => void,
): { done: Promise<Job>; close: () => void } {
  let source: EventSource | null = null;
  let settled = false;

  const done = new Promise<Job>((resolve, reject) => {
    source = new EventSource(`${BASE}/jobs/${id}/events?token=${encodeURIComponent(token)}`);

    source.onmessage = (event) => {
      let job: Job;
      try { job = JSON.parse(event.data); } catch { return; }
      onUpdate(job);

      if (job.state === 'ready' && job.final) {
        settled = true;
        source?.close();
        resolve(job);
      } else if (job.state === 'error') {
        settled = true;
        source?.close();
        reject(new ApiError(job.error || 'The job failed.', 500));
      } else if (job.state === 'cancelled') {
        settled = true;
        source?.close();
        reject(new DOMException('Cancelled.', 'AbortError'));
      }
    };

    source.onerror = () => {
      // EventSource retries on its own; only give up once the stream has been
      // closed for good, which happens after the browser exhausts retries.
      if (settled) return;
      if (source?.readyState === EventSource.CLOSED) {
        reject(new ApiError('Lost the connection to the server.', 0));
      }
    };
  });

  return { done, close: () => { settled = true; source?.close(); } };
}
