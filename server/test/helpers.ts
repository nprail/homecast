import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { Database } from '../src/db/index.js';

export async function startApp(overrides: Partial<Config> = {}, env: NodeJS.ProcessEnv = {}): Promise<App> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'homecast-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, ALLOW_PRIVATE_NETWORKS: 'true', PUBLIC_URL: 'http://localhost:8080', ...env }, { webDir: null, startWorkers: false, ...overrides });
  const db = await Database.open({ dataDir, memory: true });
  return buildApp(config, { db, logger: false });
}

export interface Session {
  token: string;
  refreshToken?: string;
  id: string;
  username: string;
}

export async function registerAdmin(a: App, username = 'demo'): Promise<Session> {
  const res = await a.app.inject({
    method: 'POST', url: '/api/v1/auth/register',
    payload: { username, password: 'correct horse battery', bootstrapToken: a.ctx.bootstrap.token },
  });
  if (res.statusCode !== 201) throw new Error(`bootstrap failed: ${res.body}`);
  const j = res.json();
  return { token: j.accessToken, refreshToken: j.refreshToken, id: j.user.id, username };
}

export async function createUser(a: App, admin: Session, username: string): Promise<Session> {
  const inv = await a.app.inject({ method: 'POST', url: '/api/v1/admin/invites', headers: bearer(admin), payload: { expiresInDays: 7 } });
  const code = inv.json().code as string;
  const res = await a.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username, password: 'another long password', inviteCode: code } });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const j = res.json();
  return { token: j.accessToken, refreshToken: j.refreshToken, id: j.user.id, username };
}

export const bearer = (s: Session) => ({ authorization: `Bearer ${s.token}` });

export function rssFeed(title: string, episodes: { guid: string; title: string; url: string; transcript?: string }[]): string {
  const items = episodes
    .map(
      (e, i) => `<item><title>${e.title}</title><guid>${e.guid}</guid><pubDate>${new Date(Date.UTC(2026, 10, 1 + i)).toUTCString()}</pubDate>
<enclosure url="${e.url}" type="audio/mpeg" length="123"/><itunes:duration>${10 + i}:00</itunes:duration>
<description><![CDATA[<p>Hello <script>alert(1)</script><b>world</b></p>]]></description>
${e.transcript ? `<podcast:transcript url="${e.transcript}" type="text/vtt"/>` : ''}</item>`,
    )
    .join('\n');
  return `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel><title>${title}</title><itunes:author>Test Author</itunes:author><description>About ${title}</description>
<itunes:image href="https://img.example/cover.jpg"/>${items}</channel></rss>`;
}

/** Local HTTP server for feeds, audio and transcripts. */
export async function fakeOrigin(routes: Record<string, { type: string; body: string | Buffer; status?: number; location?: string }>): Promise<{ url: string; close: () => Promise<void>; hits: Record<string, number>; routes: typeof routes }> {
  const hits: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0]!;
    hits[p] = (hits[p] ?? 0) + 1;
    const r = routes[p];
    if (!r) {
      res.writeHead(404).end('nope');
      return;
    }
    if (r.location) {
      res.writeHead(r.status ?? 302, { location: r.location, 'content-length': 100 });
      res.write('x'.repeat(50));
      res.end('x'.repeat(50));
      return;
    }
    const body = typeof r.body === 'string' ? Buffer.from(r.body) : r.body;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : body.length - 1;
      res.writeHead(206, { 'content-type': r.type, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(r.status ?? 200, { 'content-type': r.type, 'content-length': body.length, etag: '"v1"' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, hits, routes, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

/** Tiny stand-ins for ffmpeg and whisper-cli so the worker pipeline runs without the real binaries. */
export function fakeBinaries(): { ffmpeg: string; whisper: string; model: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'homecast-bins-'));
  const ffmpeg = path.join(dir, 'ffmpeg');
  writeFileSync(ffmpeg, `#!/usr/bin/env node
const fs = require('fs');
const out = process.argv[process.argv.length - 1];
console.error('  Duration: 00:02:00.00, start: 0.000000, bitrate: 64 kb/s');
fs.writeFileSync(out, 'RIFFfake');
`);
  const whisper = path.join(dir, 'whisper-cli');
  writeFileSync(whisper, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv;
const base = a[a.indexOf('-of') + 1];
for (const p of [10, 62, 100]) console.error('whisper_print_progress_callback: progress = ' + String(p).padStart(3) + '%');
fs.writeFileSync(base + '.json', JSON.stringify({ transcription: [
  { offsets: { from: 0, to: 4200 }, text: ' Welcome to the show.' },
  { offsets: { from: 4200, to: 9000 }, text: ' [BLANK_AUDIO]' },
  { offsets: { from: 9000, to: 12000 }, text: ' Today: congestion.' } ] }));
`);
  const model = path.join(dir, 'ggml-test.bin');
  writeFileSync(model, 'model');
  for (const f of [ffmpeg, whisper]) chmodSync(f, 0o755);
  return { ffmpeg, whisper, model };
}
