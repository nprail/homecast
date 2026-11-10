import type { AuthResponse } from '@homecast/shared';

const BASE = '/api/v1';

/** The server could not be reached (as opposed to it answering with an error, or a bug in our code). */
export class NetworkError extends TypeError {
  constructor() {
    super('Network unreachable');
    this.name = 'NetworkError';
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** The access token lives in memory only; the refresh token is an HttpOnly cookie (spec §7). */
let accessToken: string | null = null;
let refreshing: Promise<AuthResponse | null | 'offline'> | null = null;
let onSessionLost: (() => void) | null = null;

export const setAccessToken = (t: string | null) => (accessToken = t);
export const setSessionLostHandler = (fn: (() => void) | null) => (onSessionLost = fn);

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toError(res: Response, data: unknown): ApiError {
  const e = (data as { error?: { message?: string; code?: string } } | null)?.error;
  return new ApiError(res.status, e?.message ?? `Request failed (${res.status})`, e?.code);
}

/** Exchange the refresh cookie for a new access token. Concurrent callers share one request. */
/** Resolves to the session, `null` when the server says there is none, or `'offline'` when unreachable. */
export function refreshSession(): Promise<AuthResponse | null | 'offline'> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' });
      if (!res.ok) return null;
      const data = (await res.json()) as AuthResponse;
      accessToken = data.accessToken;
      return data;
    } catch {
      return 'offline';
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function raw(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new NetworkError();
  }
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    const next = await refreshSession();
    if (next === 'offline') throw new NetworkError();
    if (next) return raw(method, path, body, false);
    accessToken = null;
    onSessionLost?.();
  }
  return res;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await raw(method, path, body);
  const data = await parse(res);
  if (!res.ok) throw toError(res, data);
  return data as T;
}

export const get = <T,>(path: string) => api<T>('GET', path);
export const post = <T,>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const patch = <T,>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const del = <T = null,>(path: string) => api<T>('DELETE', path);

export async function login(username: string, password: string): Promise<AuthResponse> {
  const data = await api<AuthResponse>('POST', '/auth/login', { username, password, client: 'web', deviceName: deviceName() });
  accessToken = data.accessToken;
  return data;
}

export async function register(input: { username: string; password: string; inviteCode?: string; bootstrapToken?: string }): Promise<AuthResponse> {
  const data = await api<AuthResponse>('POST', '/auth/register', { ...input, client: 'web', deviceName: deviceName() });
  accessToken = data.accessToken;
  return data;
}

export async function logout(): Promise<void> {
  try {
    await raw('POST', '/auth/logout', {}, false);
  } finally {
    accessToken = null;
  }
}

/** Download an authenticated response as a file (CSV export). */
export async function download(path: string, filename: string): Promise<void> {
  const res = await raw('GET', path);
  if (!res.ok) throw toError(res, await parse(res));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

export const hasAccessToken = (): boolean => accessToken !== null;

/** POST a non-JSON body (OPML import). */
export async function postText<T>(path: string, text: string, contentType: string): Promise<T> {
  const send = () => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': contentType, ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }, body: text, credentials: 'same-origin' });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  const data = await parse(res);
  if (!res.ok) throw toError(res, data);
  return data as T;
}
