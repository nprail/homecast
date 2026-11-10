import dns from 'node:dns';
import { createWriteStream } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Agent, request } from 'undici';
import type { Dispatcher } from 'undici';

/**
 * SSRF guard (spec §7): http/https only, resolve DNS and refuse private/loopback/link-local/
 * metadata ranges, connect to the *validated* address (no rebinding window), revalidate on
 * every redirect (max 5), time out, and cap response sizes.
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['100::', 64], ['2001:db8::', 32],
  ['2001::', 32] /* Teredo */, ['fec0::', 10] /* site-local, deprecated */,
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** Expand an IPv6 literal to 8 16-bit groups, or null if unparsable. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.split('%')[0] ?? ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4?.[1]) {
    const p = v4[1].split('.').map(Number);
    if (p.some((n) => n > 255)) return null;
    s = s.slice(0, -v4[1].length) + ((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const nums = all.map((g) => parseInt(g, 16));
  return nums.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True when a (resolved) IP must never be contacted. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return blocked.check(ip, 'ipv4');
  if (kind === 6) {
    const g = ipv6Groups(ip);
    if (!g) return true;
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96), 6to4 (2002::/16)
    const first5Zero = g.slice(0, 5).every((n) => n === 0);
    if (first5Zero && (g[5] === 0xffff || g[5] === 0)) return blocked.check(v4From(g[6]!, g[7]!), 'ipv4');
    // NAT64 and 6to4 can tunnel to internal v4 hosts: refuse outright.
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return true;
    if (g[0] === 0x2002) return true;
    return blocked.check(ip, 'ipv6');
  }
  return true;
}

export interface FetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  /** Abort when no response headers arrive in this time. */
  timeoutMs?: number;
  maxRedirects?: number;
  allowPrivate?: boolean;
  signal?: AbortSignal;
}

function makeAgent(allowPrivate: boolean, timeoutMs: number): Agent {
  return new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connect: {
      timeout: timeoutMs,
      // Validate the exact address we connect to. Hostnames are resolved here, once,
      // and the connection uses the returned address, so DNS rebinding can't swap it.
      lookup: ((hostname: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void) => {
        dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
          if (err) return cb(err);
          const list = addrs as dns.LookupAddress[];
          if (!allowPrivate) {
            const bad = list.find((a) => isBlockedAddress(a.address));
            if (bad) return cb(new SsrfError(`Blocked address ${bad.address}`));
          }
          if (options.all) return cb(null, list);
          const first = list[0];
          return first ? cb(null, first.address, first.family) : cb(new Error('No address'));
        });
      }) as never,
    },
  });
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
  finalUrl: string;
  /** Release the connection pool; call when finished with `body`. */
  close: () => Promise<void>;
}

/** Destroy a response body without letting undici's abort error surface as an unhandled 'error' event. */
export function discardBody(body: Readable): void {
  body.on('error', () => undefined);
  body.destroy();
}

export function parseSafeUrl(raw: string, allowPrivate = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError('Only http and https URLs are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new SsrfError('Missing host');
  if (isIP(host) && !allowPrivate && isBlockedAddress(host)) throw new SsrfError('Blocked address');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')))
    throw new SsrfError('Blocked host');
  return u;
}

/** Make a request following redirects manually (each hop re-validated). */
export async function safeRequest(rawUrl: string, opts: FetchOptions = {}): Promise<SafeResponse> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const allowPrivate = opts.allowPrivate ?? false;
  const agent = makeAgent(allowPrivate, timeoutMs);
  const close = () => agent.close().catch(() => undefined);
  let url = parseSafeUrl(rawUrl, allowPrivate);
  // Credentials (URL userinfo or explicit header) are sent only to the original origin.
  let auth: string | undefined = opts.headers?.authorization;
  if (url.username || url.password) {
    auth = 'Basic ' + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
    url = new URL(url.toString());
    url.username = '';
    url.password = '';
  }
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const headers: Record<string, string> = { 'user-agent': 'Homecast/1.0', accept: '*/*', ...(opts.headers ?? {}) };
      delete headers.authorization;
      if (auth) headers.authorization = auth;
      const res: Dispatcher.ResponseData = await request(url, {
        method: opts.method ?? 'GET',
        headers,
        dispatcher: agent,
        signal: opts.signal,
      });
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        discardBody(res.body);
        if (!loc || typeof loc !== 'string') throw new SsrfError('Redirect without location');
        if (hop === maxRedirects) throw new SsrfError('Too many redirects');
        const next = parseSafeUrl(new URL(loc, url).toString(), allowPrivate);
        if (next.origin !== url.origin) auth = undefined;
        url = next;
        continue;
      }
      return { status: res.statusCode, headers: res.headers, body: res.body, finalUrl: url.toString(), close };
    }
    throw new SsrfError('Too many redirects');
  } catch (e) {
    await close();
    throw e;
  }
}

class SizeLimit extends Transform {
  seen = 0;
  constructor(private max: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void) {
    this.seen += chunk.length;
    if (this.seen > this.max) return cb(new SsrfError(`Response larger than ${this.max} bytes`));
    cb(null, chunk);
  }
}

/** Fetch a whole body into memory with a hard size cap (feeds: 10 MB). */
export async function safeFetchBuffer(
  url: string,
  opts: FetchOptions & { maxBytes: number },
): Promise<{ status: number; headers: SafeResponse['headers']; body: Buffer; bytes: number; finalUrl: string }> {
  const res = await safeRequest(url, opts);
  try {
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > opts.maxBytes) throw new SsrfError(`Response larger than ${opts.maxBytes} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > opts.maxBytes) throw new SsrfError(`Response larger than ${opts.maxBytes} bytes`);
      chunks.push(chunk);
    }
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks), bytes: total, finalUrl: res.finalUrl };
  } finally {
    await res.close();
  }
}

/** Stream a response to a file with a size cap; returns bytes written. */
export async function safeDownloadToFile(url: string, dest: string, opts: FetchOptions & { maxBytes: number }): Promise<number> {
  const res = await safeRequest(url, opts);
  try {
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    const limit = new SizeLimit(opts.maxBytes);
    await pipeline(res.body, limit, createWriteStream(dest, { mode: 0o600 }), opts.signal ? { signal: opts.signal } : {});
    return limit.seen;
  } finally {
    await res.close();
  }
}
