import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { bearer, createUser, fakeBinaries, fakeOrigin, registerAdmin, rssFeed, startApp, type Session } from './helpers.js';

let a: App;
let origin: Awaited<ReturnType<typeof fakeOrigin>>;
let admin: Session;
let maya: Session;
const bins = fakeBinaries();
const vtt = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\nHello <b>there</b>\n\n2\n00:00:04.000 --> 00:00:06.000\nGeneral Kenobi\n`;

const post = (s: Session, url: string, payload: unknown = {}) => a.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: bearer(s), payload: payload as object });
const get = (s: Session, url: string) => a.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: bearer(s) });
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

beforeEach(async () => {
  origin = await fakeOrigin({
    '/pub.vtt': { type: 'text/vtt', body: vtt },
    '/audio.mp3': { type: 'audio/mpeg', body: Buffer.alloc(5000, 7) },
  });
  origin.routes['/feed.xml'] = {
    type: 'application/rss+xml',
    body: rssFeed('Signal', [
      { guid: 'pub', title: 'With publisher transcript', url: `${origin.url}/audio.mp3`, transcript: `${origin.url}/pub.vtt` },
      { guid: 'plain', title: 'Needs whisper', url: `${origin.url}/audio.mp3` },
    ]),
  };
  a = await startApp({ whisperBin: bins.whisper, ffmpegBin: bins.ffmpeg, whisperModel: 'test', whisperModelDir: bins.model.replace(/\/ggml-test\.bin$/, '') });
  admin = await registerAdmin(a);
  maya = await createUser(a, admin, 'maya');
  await post(admin, '/podcasts', { feedUrl: `${origin.url}/feed.xml` });
});
afterEach(async () => {
  await origin.close();
  await a.close();
});

const episode = (guid: string) => a.ctx.db.episodes.find().find((e) => e.guid === guid)!;

describe('transcripts', () => {
  it('uses the publisher transcript when the feed has one', async () => {
    const ep = episode('pub');
    const r = await post(admin, `/episodes/${ep.id}/transcript`);
    expect(r.statusCode).toBe(202);
    await until(() => !!a.ctx.transcripts.get(ep.id));
    const t = (await get(maya, `/episodes/${ep.id}/transcript`)).json();
    expect(t.source).toBe('feed');
    expect(t.segments).toEqual([
      { startMs: 1000, endMs: 3500, text: 'Hello there' },
      { startMs: 4000, endMs: 6000, text: 'General Kenobi' },
    ]);
    expect((await post(maya, `/episodes/${ep.id}/transcript`)).json().status).toBe('ready');
  });

  it('runs the whisper pipeline, dedupes requests, shares results, and tracks usage', async () => {
    const ep = episode('plain');
    const first = await post(admin, `/episodes/${ep.id}/transcript`);
    const second = await post(maya, `/episodes/${ep.id}/transcript`);
    expect(first.json().job.id).toBe(second.json().job.id);
    expect(a.ctx.db.jobs.count()).toBe(1);
    await until(() => !!a.ctx.transcripts.get(ep.id));
    const t = a.ctx.transcripts.get(ep.id)!;
    expect(t.source).toBe('whisper');
    expect(t.segments.map((s) => s.text)).toEqual(['Welcome to the show.', 'Today: congestion.']);
    const job = a.ctx.db.jobs.find()[0]!;
    expect(job).toMatchObject({ status: 'done', source: 'whisper', requestedBy: admin.id, audioSeconds: 120 });
    expect(job.attachedUsers).toEqual([admin.id, maya.id]);
    a.ctx.usage.flush();
    const row = a.ctx.db.usageStats.find().find((r) => r.userId === admin.id)!;
    expect(row.transcribeBytes).toBe(5000);
    expect(row.transcriptMinutes).toBe(2);
    // job visible to attached users and admin, not outsiders
    const eli = await createUser(a, admin, 'eli');
    expect((await get(maya, `/jobs/${job.id}`)).statusCode).toBe(200);
    expect((await get(eli, `/jobs/${job.id}`)).statusCode).toBe(404);
    // admin job list reflects it
    const jobs = (await get(admin, '/admin/jobs')).json();
    expect(jobs.counts.doneLast24h).toBe(1);
    expect(jobs.jobs[0]).toMatchObject({ episodeTitle: 'Needs whisper', requestedBy: 'demo', status: 'done' });
  });

  it('fails cleanly when the model is missing, and retry re-queues', async () => {
    a.ctx.settings.update({ whisperModel: 'does-not-exist' });
    const ep = episode('plain');
    const job = (await post(maya, `/episodes/${ep.id}/transcript`)).json().job;
    await until(() => a.ctx.db.jobs.get(job.id)!.status === 'failed');
    expect(a.ctx.db.jobs.get(job.id)!.error).toMatch(/model not found/i);
    a.ctx.settings.update({ whisperModel: 'test' });
    const retried = await post(admin, `/admin/jobs/${job.id}/retry`);
    expect(retried.statusCode).toBe(200);
    await until(() => !!a.ctx.transcripts.get(ep.id));
  });

  it('cancels queued jobs', async () => {
    const slowGuard = a.ctx.db.jobs.insert({ type: 'transcript', episodeId: episode('pub').id, podcastId: 'x', status: 'queued', stage: null, progress: null, error: null, requestedBy: maya.id, attachedUsers: [maya.id], source: null, audioSeconds: 60, createdAt: Date.now(), startedAt: null, finishedAt: null, durationMs: null });
    const r = await post(admin, `/admin/jobs/${slowGuard.id}/cancel`);
    expect(r.json().job.status).toBe('cancelled');
  });

  it('transcribes only episodes the caller can see (private feeds)', async () => {
    const eli = await createUser(a, admin, 'eli');
    const p = a.ctx.db.podcasts.find()[0]!;
    p.isPrivate = true;
    expect((await post(eli, `/episodes/${episode('plain').id}/transcript`)).statusCode).toBe(404);
    expect((await post(admin, `/episodes/${episode('plain').id}/transcript`)).statusCode).toBe(202);
  });
});

describe('audio proxy', () => {
  it('streams only episode audio, supports ranges, and records bytes per user', async () => {
    const ep = episode('plain');
    const url = encodeURIComponent(ep.audioUrl);
    const full = await a.app.inject({ method: 'GET', url: `/api/v1/proxy/audio?url=${url}`, headers: bearer(maya) });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.length).toBe(5000);
    const part = await a.app.inject({ method: 'GET', url: `/api/v1/proxy/audio?url=${url}`, headers: { ...bearer(maya), range: 'bytes=0-99' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(100);
    await new Promise((r) => setTimeout(r, 50));
    a.ctx.usage.flush();
    expect(a.ctx.db.usageStats.find().find((r) => r.userId === maya.id)!.proxyBytes).toBe(5100);
    const other = await a.app.inject({ method: 'GET', url: `/api/v1/proxy/audio?url=${encodeURIComponent(`${origin.url}/feed.xml`)}`, headers: bearer(maya) });
    expect(other.statusCode).toBe(404);
    expect((await a.app.inject({ method: 'GET', url: `/api/v1/proxy/audio?url=${url}` })).statusCode).toBe(401);
  });
});

describe('admin usage, overview, backup', () => {
  it('reports usage over a range with a CSV export', async () => {
    a.ctx.usage.add(maya.id, 'proxyBytes', 2_000_000_000);
    a.ctx.usage.add(admin.id, 'transcribeBytes', 500_000_000);
    a.ctx.usage.add(admin.id, 'transcriptMinutes', 42);
    const u = (await get(admin, '/admin/usage?days=30')).json();
    expect(u.daily).toHaveLength(30);
    expect(u.totals.proxyBytes).toBe(2_000_000_000);
    expect(u.byUser[0]).toMatchObject({ username: 'maya', proxyBytes: 2_000_000_000 });
    expect(u.byUser.find((x: { username: string }) => x.username === 'demo').transcriptMinutes).toBe(42);
    const csv = await get(admin, '/admin/usage?days=90&format=csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.split('\n')[0]).toBe('day,user,proxy_bytes,feed_bytes,transcribe_bytes,transcript_minutes');
    expect(csv.body).toContain(',maya,2000000000,');
  });

  it('overview, backup now, audit and settings', async () => {
    const ov = (await get(admin, '/admin/overview')).json();
    expect(ov).toMatchObject({ users: { total: 2 }, podcasts: { total: 1, withErrors: 0 }, episodes: { total: 2 } });
    expect(ov.feedHealth[0]).toMatchObject({ title: 'Signal', subscribers: 1, status: 'ok' });
    const b = await post(admin, '/admin/backup');
    expect(b.statusCode).toBe(200);
    expect(b.json().kept).toBe(1);
    const audit = (await get(admin, '/admin/audit?filter=admin')).json();
    expect(audit.entries.some((e: { action: string }) => e.action === 'backup.completed')).toBe(true);
    const s = await a.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: bearer(admin), payload: { pollIntervalMinutes: 15, whisperModel: 'small.en-q5_1' } });
    expect(s.json()).toMatchObject({ pollIntervalMinutes: 15, whisperModel: 'small.en-q5_1' });
    expect((await a.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: bearer(admin), payload: { whisperModel: '../../etc/passwd; rm -rf' } })).statusCode).toBe(400);
  });

  it('flags failing feeds and refreshes them', async () => {
    const p = a.ctx.db.podcasts.find()[0]!;
    p.feedUrl = `${origin.url}/gone.xml`;
    await post(admin, `/admin/feeds/${p.id}/refresh`);
    const feeds = (await get(admin, '/admin/feeds?status=errors')).json();
    expect(feeds.feeds[0]).toMatchObject({ status: 'error', statusLabel: 'HTTP 404' });
    expect((await get(admin, '/admin/overview')).json().podcasts.withErrors).toBe(1);
  });
});
