import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { bearer, createUser, fakeBinaries, fakeOrigin, registerAdmin, rssFeed, startApp, type Session } from './helpers.js';

let a: App;
let origin: Awaited<ReturnType<typeof fakeOrigin>>;
let admin: Session;
const bins = fakeBinaries();
const eps = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ guid: `g${from + i}`, title: `Episode ${from + i}`, url: `${origin.url}/audio.mp3` }));
const feed = (title: string, items: ReturnType<typeof eps>) => rssFeed(title, items);
const patch = (autoTranscribe: object) => a.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: bearer(admin), payload: { autoTranscribe } });
const until = async (fn: () => boolean, ms = 10000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const systemJobs = () => a.ctx.db.jobs.find().filter((j) => j.requestedBy === 'system');

beforeEach(async () => {
  origin = await fakeOrigin({ '/audio.mp3': { type: 'audio/mpeg', body: Buffer.alloc(2000, 1) } });
  origin.routes['/a.xml'] = { type: 'application/rss+xml', body: feed('Alpha', eps(6)) };
  origin.routes['/b.xml'] = { type: 'application/rss+xml', body: feed('Beta', eps(2)) };
  a = await startApp({ whisperBin: bins.whisper, ffmpegBin: bins.ffmpeg, whisperModel: 'test', whisperModelDir: bins.model.replace(/\/ggml-test\.bin$/, '') });
  admin = await registerAdmin(a);
  for (const f of ['a', 'b']) await a.app.inject({ method: 'POST', url: '/api/v1/podcasts', headers: bearer(admin), payload: { feedUrl: `${origin.url}/${f}.xml` } });
});
afterEach(async () => {
  await origin.close();
  await a.close();
});

const podcast = (title: string) => a.ctx.db.podcasts.find().find((p) => p.title === title)!;

describe('auto-transcribe', () => {
  it('is off by default and does nothing', async () => {
    expect(a.ctx.autoTranscribe.tick()).toBe(0);
    const s = (await a.app.inject({ method: 'GET', url: '/api/v1/admin/settings', headers: bearer(admin) })).json();
    expect(s.autoTranscribe).toEqual({ enabled: false, scope: 'new', podcastIds: null });
    expect(s.autoTranscribePending).toBe(0);
  });

  it('"new episodes" skips the existing catalogue and picks up episodes found after it was enabled', async () => {
    const r = (await patch({ enabled: true, scope: 'new', podcastIds: null })).json();
    expect(r.autoTranscribePending).toBe(0);
    expect(systemJobs()).toHaveLength(0);
    // the feed gains an episode on the next poll
    origin.routes['/a.xml'] = { type: 'application/rss+xml', body: feed('Alpha', eps(7)) };
    const p = podcast('Alpha');
    p.etag = null;
    await a.ctx.feeds.refresh(p, { force: true });
    await until(() => systemJobs().some((j) => j.status === 'done'));
    const jobs = systemJobs();
    expect(jobs).toHaveLength(1);
    expect(a.ctx.db.episodes.get(jobs[0]!.episodeId)!.guid).toBe('g6');
    expect(a.ctx.transcripts.get(jobs[0]!.episodeId)?.source).toBe('whisper');
    // shown as the auto requester in the admin jobs list
    const list = (await a.app.inject({ method: 'GET', url: '/api/v1/admin/jobs', headers: bearer(admin) })).json();
    expect(list.jobs[0].requestedBy).toBe('Auto-transcribe');
  });

  it('"all episodes" works through the back catalogue in small batches until done, once per episode', async () => {
    const r = (await patch({ enabled: true, scope: 'all', podcastIds: null })).json();
    expect(r.autoTranscribePending).toBeGreaterThan(0);
    // never more than 3 auto jobs waiting at a time
    expect(systemJobs().filter((j) => j.status === 'queued' || j.status === 'running').length).toBeLessThanOrEqual(3);
    await until(() => a.ctx.autoTranscribe.eligible().length === 0 && systemJobs().every((j) => j.status === 'done'), 20000);
    expect(systemJobs()).toHaveLength(8);
    expect(a.ctx.autoTranscribe.tick()).toBe(0); // nothing is queued twice
  });

  it('can be limited to selected podcasts', async () => {
    const beta = podcast('Beta');
    await patch({ enabled: true, scope: 'all', podcastIds: [beta.id] });
    await until(() => systemJobs().length === 2 && systemJobs().every((j) => j.status === 'done'));
    expect(systemJobs().every((j) => a.ctx.db.episodes.get(j.episodeId)!.podcastId === beta.id)).toBe(true);
    expect(a.ctx.autoTranscribe.eligible()).toHaveLength(0);
  });

  it('ignores podcasts nobody subscribes to, and validates input', async () => {
    const sub = a.ctx.db.subscriptions.find().filter((s) => s.podcastId === podcast('Alpha').id);
    for (const s of sub) { s.deleted = true; a.ctx.db.subscriptions.save(s); }
    await patch({ enabled: true, scope: 'all', podcastIds: [podcast('Alpha').id] });
    expect(a.ctx.autoTranscribe.eligible()).toHaveLength(0);
    expect((await patch({ enabled: 'yes', scope: 'all', podcastIds: null })).statusCode).toBe(400);
    expect((await patch({ enabled: true, scope: 'everything', podcastIds: null })).statusCode).toBe(400);
    const u = await createUser(a, admin, 'maya');
    expect((await a.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: bearer(u), payload: { autoTranscribe: { enabled: true, scope: 'all', podcastIds: null } } })).statusCode).toBe(403);
  });
});
