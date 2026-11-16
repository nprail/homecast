import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { parseRange } from '../src/util/range.js';
import { bearer, createUser, fakeBinaries, fakeOrigin, registerAdmin, rssFeed, startApp, type Session } from './helpers.js';

let a: App;
let origin: Awaited<ReturnType<typeof fakeOrigin>>;
let admin: Session;
let maya: Session;
const bins = fakeBinaries();
const SIZE = 2000;
const EPISODES = 8;

const patch = (episodeMirror: object) => a.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: bearer(admin), payload: { episodeMirror } });
const mediaDir = () => path.join(a.ctx.config.dataDir, 'media');
const copies = () => (existsSync(mediaDir()) ? readdirSync(mediaDir()).filter((f) => f.endsWith('.audio')) : []);
const episodes = () => a.ctx.db.episodes.find().filter((e) => !e.deleted);
const audioHits = () => Object.entries(origin.hits).filter(([p]) => p.endsWith('.mp3')).reduce((n, [, v]) => n + v, 0);

beforeEach(async () => {
  origin = await fakeOrigin({});
  for (let i = 0; i < EPISODES; i++) origin.routes[`/a${i}.mp3`] = { type: 'audio/mpeg', body: Buffer.alloc(SIZE, i + 1) };
  origin.routes['/alpha.xml'] = {
    type: 'application/rss+xml',
    body: rssFeed('Alpha', Array.from({ length: EPISODES }, (_, i) => ({ guid: `a${i}`, title: `Alpha ${i}`, url: `${origin.url}/a${i}.mp3` }))),
  };
  origin.routes['/beta.xml'] = { type: 'application/rss+xml', body: rssFeed('Beta', [{ guid: 'b0', title: 'Beta 0', url: `${origin.url}/a0.mp3` }]) };
  a = await startApp({ whisperBin: bins.whisper, ffmpegBin: bins.ffmpeg, whisperModel: 'test', whisperModelDir: bins.model.replace(/\/ggml-test\.bin$/, '') });
  admin = await registerAdmin(a);
  maya = await createUser(a, admin, 'maya');
  await a.app.inject({ method: 'POST', url: '/api/v1/podcasts', headers: bearer(admin), payload: { feedUrl: `${origin.url}/alpha.xml` } });
});
afterEach(async () => {
  await origin.close();
  await a.close();
});

describe('episode hosting', () => {
  it('is off by default and downloads nothing', async () => {
    const s = (await a.app.inject({ method: 'GET', url: '/api/v1/admin/settings', headers: bearer(admin) })).json();
    expect(s.episodeMirror).toEqual({ enabled: false, maxGB: null });
    await a.ctx.mirror.kick();
    expect(audioHits()).toBe(0);
    expect(copies()).toHaveLength(0);
    expect(s.episodeMirrorStatus).toMatchObject({ hosted: 0, pending: EPISODES });
  });

  it('copies every episode of subscribed podcasts only, once', async () => {
    await a.app.inject({ method: 'POST', url: '/api/v1/podcasts', headers: bearer(admin), payload: { feedUrl: `${origin.url}/beta.xml` } });
    for (const s of a.ctx.db.subscriptions.find()) if (a.ctx.db.podcasts.get(s.podcastId)?.title === 'Beta') { s.deleted = true; a.ctx.db.subscriptions.save(s); }
    const r = await patch({ enabled: true, maxGB: null });
    expect(r.json().episodeMirrorStatus).toMatchObject({ pending: EPISODES });
    await a.ctx.mirror.kick();
    expect(copies()).toHaveLength(EPISODES);
    expect(a.ctx.mirror.status()).toMatchObject({ hosted: EPISODES, pending: 0, failed: 0, bytes: EPISODES * SIZE });
    const hits = audioHits();
    await a.ctx.mirror.kick();
    expect(audioHits()).toBe(hits); // nothing is downloaded twice
  });

  it('serves hosted copies through the audio proxy, with ranges, without touching the origin', async () => {
    await patch({ enabled: true, maxGB: null });
    await a.ctx.mirror.kick();
    const ep = episodes()[0]!;
    const url = encodeURIComponent(ep.audioUrl);
    const hits = audioHits();
    const full = await a.app.inject({ method: 'GET', url: `/api/v1/proxy/audio?url=${url}`, headers: bearer(maya) });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.length).toBe(SIZE);
    const part = await a.app.inject({ method: 'GET', url: `/api/v1/proxy/audio?url=${url}`, headers: { ...bearer(maya), range: 'bytes=10-19' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-19/${SIZE}`);
    expect(part.rawPayload.length).toBe(10);
    const tail = await a.app.inject({ method: 'GET', url: `/api/v1/proxy/audio?url=${url}`, headers: { ...bearer(maya), range: 'bytes=-5' } });
    expect(tail.rawPayload.length).toBe(5);
    expect((await a.app.inject({ method: 'GET', url: `/api/v1/proxy/audio?url=${url}`, headers: { ...bearer(maya), range: `bytes=${SIZE + 5}-` } })).statusCode).toBe(416);
    expect(audioHits()).toBe(hits);
    await new Promise((r) => setTimeout(r, 50));
    a.ctx.usage.flush();
    expect(a.ctx.db.usageStats.find().find((r) => r.userId === maya.id)!.proxyBytes).toBe(SIZE + 10 + 5);
  });

  it('respects the storage cap and reports why it stopped', async () => {
    await patch({ enabled: true, maxGB: 0.00001 }); // 10,000 bytes: five 2,000-byte episodes
    await a.ctx.mirror.kick();
    expect(copies()).toHaveLength(5);
    const s = a.ctx.mirror.status();
    expect(s).toMatchObject({ hosted: 5, bytes: 10_000, stoppedReason: 'cap' });
    expect(s.failed).toBe(0); // hitting the cap isn't an episode failure
  });

  it('records failures, backs off, and retries later', async () => {
    origin.routes['/a3.mp3'] = { type: 'audio/mpeg', body: 'gone', status: 404 };
    await patch({ enabled: true, maxGB: null });
    await a.ctx.mirror.kick();
    const failed = a.ctx.db.episodeMirrors.find().find((m) => m.status === 'failed')!;
    expect(failed.error).toMatch(/HTTP 404/);
    expect(failed.nextAttemptAt).toBeGreaterThan(Date.now());
    const hits = audioHits();
    await a.ctx.mirror.kick();
    expect(audioHits()).toBe(hits); // still in backoff
    origin.routes['/a3.mp3'] = { type: 'audio/mpeg', body: Buffer.alloc(SIZE, 4) };
    failed.nextAttemptAt = 0;
    a.ctx.db.episodeMirrors.saveQuiet(failed);
    await a.ctx.mirror.kick();
    expect(a.ctx.mirror.status()).toMatchObject({ hosted: EPISODES, failed: 0 });
  });

  it('replaces a copy when the feed changes the audio URL', async () => {
    await patch({ enabled: true, maxGB: null });
    await a.ctx.mirror.kick();
    const ep = episodes()[0]!;
    const before = a.ctx.mirror.localAudio(ep)!;
    expect(before).not.toBeNull();
    origin.routes['/a0-v2.mp3'] = { type: 'audio/mpeg', body: Buffer.alloc(SIZE, 99) };
    ep.audioUrl = `${origin.url}/a0-v2.mp3`;
    a.ctx.db.episodes.saveQuiet(ep);
    expect(a.ctx.mirror.localAudio(ep)).toBeNull(); // the old copy no longer matches the feed
    await a.ctx.mirror.kick();
    const after = a.ctx.mirror.localAudio(ep)!;
    expect(after.path).toBe(before.path); // copies are stored per episode, so the file is replaced in place
    expect(readFileSync(after.path)[0]).toBe(99); // and holds the new audio
    expect(a.ctx.db.episodeMirrors.get(ep.id)!.sourceUrl).toBe(ep.audioUrl);
  });

  it('removes copies when the podcast loses its last subscriber', async () => {
    await patch({ enabled: true, maxGB: null });
    await a.ctx.mirror.kick();
    expect(copies()).toHaveLength(EPISODES);
    for (const s of a.ctx.db.subscriptions.find()) { s.deleted = true; a.ctx.db.subscriptions.save(s); }
    a.ctx.mirror.sweep();
    expect(copies()).toHaveLength(0);
    expect(a.ctx.db.episodeMirrors.count()).toBe(0);
  });

  it('keeps copies when turned off; deleting them requires hosting to be off', async () => {
    await patch({ enabled: true, maxGB: null });
    await a.ctx.mirror.kick();
    const busy = await a.app.inject({ method: 'DELETE', url: '/api/v1/admin/mirror', headers: bearer(admin) });
    expect(busy.statusCode).toBe(409);
    await patch({ enabled: false, maxGB: null });
    expect(copies()).toHaveLength(EPISODES);
    await a.ctx.mirror.kick();
    expect(copies()).toHaveLength(EPISODES);
    const del = await a.app.inject({ method: 'DELETE', url: '/api/v1/admin/mirror', headers: bearer(admin) });
    expect(del.json()).toEqual({ removed: EPISODES });
    expect(copies()).toHaveLength(0);
  });

  it('is admin-only', async () => {
    expect((await a.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: bearer(maya), payload: { episodeMirror: { enabled: true, maxGB: null } } })).statusCode).toBe(403);
    expect((await a.app.inject({ method: 'DELETE', url: '/api/v1/admin/mirror', headers: bearer(maya) })).statusCode).toBe(403);
  });

  it('transcription uses the hosted copy instead of downloading the audio again', async () => {
    await patch({ enabled: true, maxGB: null });
    await a.ctx.mirror.kick();
    const ep = episodes()[0]!;
    const hits = audioHits();
    const r = await a.app.inject({ method: 'POST', url: `/api/v1/episodes/${ep.id}/transcript`, headers: bearer(maya) });
    expect(r.statusCode).toBe(202);
    const jobId = r.json().job.id;
    const end = Date.now() + 10_000;
    while (a.ctx.db.jobs.get(jobId)!.status !== 'done') {
      if (Date.now() > end || a.ctx.db.jobs.get(jobId)!.status === 'failed') throw new Error(a.ctx.db.jobs.get(jobId)!.error ?? 'timed out');
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(audioHits()).toBe(hits);
  });

  const transcribe = async (episodeId: string) => {
    const r = await a.app.inject({ method: 'POST', url: `/api/v1/episodes/${episodeId}/transcript`, headers: bearer(maya) });
    expect(r.statusCode).toBe(202);
    const jobId = r.json().job.id;
    const end = Date.now() + 10_000;
    while (a.ctx.db.jobs.get(jobId)!.status !== 'done') {
      if (Date.now() > end || a.ctx.db.jobs.get(jobId)!.status === 'failed') throw new Error(a.ctx.db.jobs.get(jobId)!.error ?? 'timed out');
      await new Promise((res) => setTimeout(res, 25));
    }
  };
  const episodePath = (id: string) => new URL(a.ctx.db.episodes.get(id)!.audioUrl).pathname;

  it('transcribing an episode that is not hosted yet shares one download with hosting', async () => {
    await patch({ enabled: true, maxGB: null }); // hosting starts copying in the background
    const ep = episodes()[3]!;
    await transcribe(ep.id); // asks for the audio while hosting may be mid-run
    await a.ctx.mirror.kick();
    expect(copies()).toHaveLength(EPISODES);
    for (const e of episodes()) expect(origin.hits[episodePath(e.id)]).toBe(1); // nothing fetched twice
  });

  it('downloads a temporary copy only when hosting is off', async () => {
    const ep = episodes()[0]!;
    await transcribe(ep.id);
    expect(origin.hits[episodePath(ep.id)]).toBe(1);
    expect(copies()).toHaveLength(0);
  });

  it('falls back to one temporary download when the episode does not fit under the cap', async () => {
    await patch({ enabled: true, maxGB: 0.000001 }); // 1 KB, smaller than any episode
    await a.ctx.mirror.kick();
    const ep = episodes()[0]!;
    const before = origin.hits[episodePath(ep.id)] ?? 0;
    await transcribe(ep.id);
    expect((origin.hits[episodePath(ep.id)] ?? 0) - before).toBeLessThanOrEqual(2); // hosting's refused attempt + the temp copy
    expect(copies()).toHaveLength(0);
  });
});

describe('parseRange', () => {
  it.each([
    [undefined, 100, undefined],
    ['bytes=0-9', 100, { start: 0, end: 9 }],
    ['bytes=90-', 100, { start: 90, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=50-500', 100, { start: 50, end: 99 }],
    ['bytes=100-', 100, 'invalid'],
    ['bytes=9-3', 100, 'invalid'],
    ['bytes=0-1,5-6', 100, 'invalid'],
    ['items=0-1', 100, 'invalid'],
    ['bytes=-0', 100, 'invalid'],
  ])('%s of %i', (header, size, want) => expect(parseRange(header, size)).toEqual(want));
});

describe('signed streaming of hosted copies', () => {
  const streamUrl = async (s: Session, episodeId: string) => (await a.app.inject({ method: 'GET', url: `/api/v1/episodes/${episodeId}/stream`, headers: bearer(s) })).json();
  const get = (url: string, headers: Record<string, string> = {}) => a.app.inject({ method: 'GET', url, headers });
  const parts = (url: string) => Object.fromEntries(new URL(url, 'http://x').searchParams.entries());
  const rebuild = (url: string, change: Record<string, string>) => {
    const u = new URL(url, 'http://x');
    for (const [k, v] of Object.entries(change)) u.searchParams.set(k, v);
    return u.pathname + u.search;
  };

  it('returns null until the episode is hosted, then a signed URL that needs no login', async () => {
    const ep = episodes()[0]!;
    expect((await streamUrl(maya, ep.id)).url).toBeNull();
    await patch({ enabled: true, maxGB: null });
    await a.ctx.mirror.kick();
    const { url, expiresAt } = await streamUrl(maya, ep.id);
    expect(url).toMatch(new RegExp(`^/api/v1/media/${ep.id}\\?u=${maya.id}&exp=\\d+&sig=`));
    expect(expiresAt).toBeGreaterThan(Date.now());
    const full = await get(url);
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.length).toBe(SIZE);
    expect(full.headers['content-type']).toBe('audio/mpeg');
    const part = await get(url, { range: 'bytes=0-99' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-99/${SIZE}`);
    expect(part.rawPayload.length).toBe(100);
    expect((await get(url, { range: `bytes=${SIZE}-` })).statusCode).toBe(416);
  });

  it('refuses tampered, expired or re-targeted URLs', async () => {
    await patch({ enabled: true, maxGB: null });
    await a.ctx.mirror.kick();
    const ep = episodes()[0]!;
    const other = episodes()[1]!;
    const { url } = await streamUrl(maya, ep.id);
    const p = parts(url);
    expect((await get(rebuild(url, { sig: 'A'.repeat(p.sig!.length) }))).statusCode).toBe(403);
    expect((await get(rebuild(url, { exp: String(Number(p.exp) + 1000) }))).statusCode).toBe(403);
    expect((await get(rebuild(url, { u: admin.id }))).statusCode).toBe(403);
    expect((await get(url.replace(`/media/${ep.id}`, `/media/${other.id}`))).statusCode).toBe(403);
    expect((await get('/api/v1/media/' + ep.id)).statusCode).toBe(403); // no signature at all
    const { signMedia } = await import('../src/security/mediaUrl.js');
    const past = Date.now() - 1000;
    const expired = signMedia(a.ctx.config.jwtSecret, ep.id, maya.id, past);
    expect((await get(`/api/v1/media/${ep.id}?u=${maya.id}&exp=${past}&sig=${expired}`)).statusCode).toBe(403);
    const far = Date.now() + 365 * 86_400_000;
    const longLived = signMedia(a.ctx.config.jwtSecret, ep.id, maya.id, far);
    expect((await get(`/api/v1/media/${ep.id}?u=${maya.id}&exp=${far}&sig=${longLived}`)).statusCode).toBe(403);
  });

  it('respects private feeds and disabled accounts at request time', async () => {
    await patch({ enabled: true, maxGB: null });
    await a.ctx.mirror.kick();
    const ep = episodes()[0]!;
    const { signMedia } = await import('../src/security/mediaUrl.js');
    const exp = Date.now() + 60_000;
    const sig = signMedia(a.ctx.config.jwtSecret, ep.id, maya.id, exp);
    const url = `/api/v1/media/${ep.id}?u=${maya.id}&exp=${exp}&sig=${sig}`;
    expect((await get(url)).statusCode).toBe(200);
    // the feed becomes private: maya isn't subscribed to it on this server's terms
    const podcast = a.ctx.db.podcasts.get(ep.podcastId)!;
    podcast.isPrivate = true;
    a.ctx.db.podcasts.saveQuiet(podcast);
    expect((await get(url)).statusCode).toBe(404);
    expect((await a.app.inject({ method: 'GET', url: `/api/v1/episodes/${ep.id}/stream`, headers: bearer(maya) })).statusCode).toBe(404);
    podcast.isPrivate = false;
    a.ctx.db.podcasts.saveQuiet(podcast);
    // disabled accounts lose access even with an unexpired link
    await a.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${maya.id}`, headers: bearer(admin), payload: { disabled: true } });
    expect((await get(url)).statusCode).toBe(403);
  });

  it('stops serving once the copy is deleted, and counts bytes against the user', async () => {
    await patch({ enabled: true, maxGB: null });
    await a.ctx.mirror.kick();
    const ep = episodes()[0]!;
    const { url } = await streamUrl(maya, ep.id);
    expect((await get(url)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    a.ctx.usage.flush();
    expect(a.ctx.db.usageStats.find().find((r) => r.userId === maya.id)!.proxyBytes).toBe(SIZE);
    await patch({ enabled: false, maxGB: null });
    await a.app.inject({ method: 'DELETE', url: '/api/v1/admin/mirror', headers: bearer(admin) });
    expect((await streamUrl(maya, ep.id)).url).toBeNull();
    expect((await get(url)).statusCode).toBe(404);
  });
});
