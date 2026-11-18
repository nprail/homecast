import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { bearer, fakeOrigin, registerAdmin, rssFeed, startApp, type Session } from './helpers.js';

describe('public directory', () => {
  let a: App;
  let origin: Awaited<ReturnType<typeof fakeOrigin>>;
  let admin: Session;
  let podcastId: string;
  let episodeId: string;

  const get = (url: string) => a.app.inject({ method: 'GET', url: `/api/v1${url}` });
  const set = (publicDirectory: Record<string, boolean>) =>
    a.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: bearer(admin), payload: { publicDirectory } });

  beforeEach(async () => {
    origin = await fakeOrigin({});
    origin.routes['/f.xml'] = { type: 'application/rss+xml', body: rssFeed('Public Show', [{ guid: 'g1', title: 'One', url: `${origin.url}/1.mp3` }, { guid: 'g2', title: 'Two', url: `${origin.url}/2.mp3` }]) };
    origin.routes['/p.xml'] = { type: 'application/rss+xml', body: rssFeed('Secret Show', [{ guid: 'p1', title: 'Hidden', url: `${origin.url}/h.mp3` }]) };
    a = await startApp();
    admin = await registerAdmin(a);
    const r = await a.app.inject({ method: 'POST', url: '/api/v1/podcasts', headers: bearer(admin), payload: { feedUrl: `${origin.url}/f.xml` } });
    expect(r.statusCode).toBe(201);
    podcastId = r.json().podcast.id;
    episodeId = a.ctx.db.episodes.find({ podcastId }).find((e) => e.guid === 'g1')!.id;
  });
  afterEach(async () => {
    await origin.close();
    await a.close();
  });

  it('is off by default: config says so and every page is 404', async () => {
    expect((await get('/public/config')).json()).toEqual({ enabled: false, listening: false, transcripts: false, subscriberCounts: false });
    for (const url of ['/public/discover', `/public/podcasts/${podcastId}`, `/public/episodes/${episodeId}`, `/public/episodes/${episodeId}/transcript`]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
  });

  it('lists the Discover podcasts without a login, hiding counts and private or hidden feeds', async () => {
    expect((await set({ enabled: true })).statusCode).toBe(200);
    const priv = await a.app.inject({ method: 'POST', url: '/api/v1/podcasts', headers: bearer(admin), payload: { feedUrl: `${origin.url}/p.xml` } });
    const secret = a.ctx.db.podcasts.get(priv.json().podcast.id)!;
    secret.isPrivate = true;
    a.ctx.db.podcasts.save(secret);

    const d = (await get('/public/discover')).json();
    expect(d.items.map((i: { title: string }) => i.title)).toEqual(['Public Show']);
    expect(d.items[0].subscriberCount).toBe(0);
    expect((await get(`/public/podcasts/${secret.id}`)).statusCode).toBe(404);

    // The podcast page: episodes newest first, no count until the setting is on.
    const p = (await get(`/public/podcasts/${podcastId}`)).json();
    expect(p.title).toBe('Public Show');
    expect(p.episodes.map((e: { title: string }) => e.title)).toEqual(['Two', 'One']);
    expect(p.subscriberCount).toBeUndefined();
    await set({ subscriberCounts: true });
    expect((await get(`/public/podcasts/${podcastId}`)).json().subscriberCount).toBe(1);
    expect((await get('/public/discover?sort=subscribers')).json().items[0].subscriberCount).toBe(1);

    // Hidden from Discover: not listed, but a shared link still opens.
    const hidden = a.ctx.db.podcasts.get(podcastId)!;
    hidden.hiddenFromDiscover = true;
    a.ctx.db.podcasts.save(hidden);
    expect((await get('/public/discover')).json().total).toBe(0);
    expect((await get(`/public/episodes/${episodeId}`)).statusCode).toBe(200);
  });

  it('gives the publisher audio address only while public listening is on, and never a hosted copy', async () => {
    await set({ enabled: true });
    expect((await get(`/public/episodes/${episodeId}`)).json().audioUrl).toBeNull();
    await set({ listening: true });
    const e = (await get(`/public/episodes/${episodeId}`)).json();
    expect(e.audioUrl).toBe(`${origin.url}/1.mp3`);
    expect(e.description).not.toContain('<script');
    expect(e.podcast.title).toBe('Public Show');
  });

  it('serves transcripts only while public transcripts are on', async () => {
    a.ctx.db.transcripts.insert({ episodeId, source: 'whisper', status: 'ready', model: 'base', segments: [{ startMs: 0, endMs: 1000, text: 'Hello there' }], createdAt: 1 });
    await set({ enabled: true });
    expect((await get(`/public/episodes/${episodeId}`)).json().hasTranscript).toBe(false);
    expect((await get(`/public/episodes/${episodeId}/transcript`)).statusCode).toBe(404);
    await set({ transcripts: true });
    expect((await get(`/public/episodes/${episodeId}`)).json().hasTranscript).toBe(true);
    const t = await get(`/public/episodes/${episodeId}/transcript`);
    expect(t.json().segments[0].text).toBe('Hello there');
  });

  it('keeps the signed-in routes behind a login and the setting behind an admin', async () => {
    await set({ enabled: true });
    expect((await get(`/episodes/${episodeId}/share`)).statusCode).toBe(401);
    expect((await get(`/episodes/${episodeId}/transcript`)).statusCode).toBe(401);
    expect((await get(`/episodes/${episodeId}/stream`)).statusCode).toBe(401);
    expect((await a.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', payload: { publicDirectory: { enabled: false } } })).statusCode).toBe(401);
    expect((await a.app.inject({ method: 'GET', url: '/api/v1/admin/settings', headers: bearer(admin) })).json().publicDirectory.enabled).toBe(true);
  });
});
