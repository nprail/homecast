import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { bearer, createUser, fakeOrigin, registerAdmin, rssFeed, startApp, type Session } from './helpers.js';

let a: App;
let origin: Awaited<ReturnType<typeof fakeOrigin>>;
let admin: Session;
let maya: Session;

const post = (s: Session, url: string, payload: unknown = {}) => a.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: bearer(s), payload: payload as object });
const get = (s: Session, url: string) => a.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: bearer(s) });
const sync = async (s: Session, cursor: number, changes: object = {}) => (await post(s, '/sync', { cursor, deviceId: 'dev', changes })).json();

beforeEach(async () => {
  a = await startApp();
  origin = await fakeOrigin({
    '/feed.xml': { type: 'application/rss+xml', body: rssFeed('Signal & Noise', [1, 2, 3].map((i) => ({ guid: `g${i}`, title: `Episode ${i}`, url: `http://127.0.0.1/a${i}.mp3` }))) },
    '/other.xml': { type: 'application/rss+xml', body: rssFeed('Quiet Hours', [{ guid: 'q1', title: 'Night', url: 'http://127.0.0.1/q1.mp3' }]) },
  });
  admin = await registerAdmin(a);
  maya = await createUser(a, admin, 'maya');
});
afterEach(async () => {
  await origin.close();
  await a.close();
});

describe('library', () => {
  it('adds a feed by URL, sanitizes descriptions, and subscribes', async () => {
    const res = await post(admin, '/podcasts', { feedUrl: `${origin.url}/feed.xml` });
    expect(res.statusCode).toBe(201);
    expect(res.json().podcast.title).toBe('Signal & Noise');
    const eps = a.ctx.db.episodes.find();
    expect(eps).toHaveLength(3);
    expect(eps[0]!.description).not.toContain('<script');
    expect(eps[0]!.description).toContain('<b>world</b>');
    expect(eps.find((e) => e.guid === 'g2')!.durationSec).toBe(11 * 60);
  });

  it('rejects non-feeds and SSRF targets', async () => {
    expect((await post(admin, '/podcasts', { feedUrl: `${origin.url}/missing.xml` })).statusCode).toBe(400);
    const strict = await startApp({ allowPrivateNetworks: false }, { ALLOW_PRIVATE_NETWORKS: 'false' });
    const adm = await registerAdmin(strict);
    const r = await strict.app.inject({ method: 'POST', url: '/api/v1/podcasts', headers: bearer(adm), payload: { feedUrl: 'http://169.254.169.254/latest/meta-data/' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/Blocked/);
    await strict.close();
  });

  it('exports and imports OPML', async () => {
    await post(admin, '/podcasts', { feedUrl: `${origin.url}/feed.xml` });
    const exp = await get(admin, '/opml/export');
    expect(exp.statusCode).toBe(200);
    expect(exp.body).toContain(`xmlUrl="${origin.url}/feed.xml"`);
    const imp = await a.app.inject({ method: 'POST', url: '/api/v1/opml/import', headers: { ...bearer(maya), 'content-type': 'text/x-opml' }, payload: exp.body });
    expect(imp.json().imported).toBe(1);
    expect(await sync(maya, 0).then((r) => r.changes.podcasts.length)).toBe(1);
  });
});

describe('discover', () => {
  it('lists only public, subscribed, unhidden podcasts, with counts only', async () => {
    const pub = (await post(admin, '/podcasts', { feedUrl: `${origin.url}/feed.xml` })).json().podcast;
    await post(admin, '/podcasts', { feedUrl: `${origin.url}/other.xml?token=abc123`, private: false });
    const list = (await get(maya, '/discover')).json();
    expect(list.items.map((i: { title: string }) => i.title)).toEqual(['Signal & Noise']); // tokenized feed is private
    expect(list.items[0].subscriberCount).toBe(1);
    expect(JSON.stringify(list)).not.toContain('feedUrl');
    expect(JSON.stringify(list)).not.toContain('admin');
    // own subscriptions are excluded
    expect((await get(admin, '/discover')).json().items).toHaveLength(0);
    // subscribing by id works, but not for private feeds
    expect((await post(maya, '/subscriptions', { podcastId: pub.id })).statusCode).toBe(201);
    const priv = a.ctx.db.podcasts.find().find((p) => p.isPrivate)!;
    expect((await post(maya, '/subscriptions', { podcastId: priv.id })).statusCode).toBe(404);
    expect((await get(admin, '/discover')).json().items).toHaveLength(0);
    // admin can hide a podcast
    const eli = await createUser(a, admin, 'eli');
    await a.app.inject({ method: 'PATCH', url: `/api/v1/admin/feeds/${pub.id}`, headers: bearer(admin), payload: { hiddenFromDiscover: true } });
    expect((await get(eli, '/discover')).json().items).toHaveLength(0);
    // and a podcast with no subscribers drops out
    await a.app.inject({ method: 'PATCH', url: `/api/v1/admin/feeds/${pub.id}`, headers: bearer(admin), payload: { hiddenFromDiscover: false } });
    expect((await get(eli, '/discover?q=signal')).json().items).toHaveLength(1);
    for (const s of a.ctx.db.subscriptions.find()) if (s.podcastId === pub.id) { s.deleted = true; a.ctx.db.subscriptions.save(s); }
    expect((await get(eli, '/discover')).json().items).toHaveLength(0);
  });
});

describe('sync protocol', () => {
  it('delivers subscribed feeds, then only deltas', async () => {
    await post(admin, '/podcasts', { feedUrl: `${origin.url}/feed.xml` });
    const first = await sync(admin, 0);
    expect(first.hasMore).toBe(false);
    expect(first.changes.podcasts).toHaveLength(1);
    expect(first.changes.episodes).toHaveLength(3);
    expect(first.changes.subscriptions).toHaveLength(1);
    const again = await sync(admin, first.cursor);
    expect(again.changes.episodes).toHaveLength(0);
    expect(again.changes.subscriptions).toHaveLength(0);
    expect(again.cursor).toBeGreaterThanOrEqual(first.cursor);
    // a new episode appears on the next feed refresh
    const p = a.ctx.db.podcasts.find()[0]!;
    origin.hits['/feed.xml'] = 0;
    const withNew = rssFeed('Signal & Noise', [1, 2, 3, 4].map((i) => ({ guid: `g${i}`, title: `Episode ${i}`, url: `http://127.0.0.1/a${i}.mp3` })));
    await origin.close();
    origin = await fakeOrigin({ '/feed.xml': { type: 'application/rss+xml', body: withNew } });
    p.feedUrl = `${origin.url}/feed.xml`;
    p.etag = null;
    const r = await a.ctx.feeds.refresh(p, { force: true });
    expect(r.newEpisodes).toBe(1);
    const delta = await sync(admin, again.cursor);
    expect(delta.changes.episodes.map((e: { guid: string }) => e.guid)).toEqual(['g4']);
  });

  it('backfills a podcast that predates the subscription', async () => {
    await post(admin, '/podcasts', { feedUrl: `${origin.url}/feed.xml` });
    const pod = a.ctx.db.podcasts.find()[0]!;
    const base = a.ctx.db.currentRev;
    await post(maya, '/subscriptions', { podcastId: pod.id });
    const res = await sync(maya, base);
    expect(res.changes.podcasts).toHaveLength(1);
    expect(res.changes.episodes).toHaveLength(3);
  });

  it('applies client changes, assigns rev, and keeps users isolated', async () => {
    await post(admin, '/podcasts', { feedUrl: `${origin.url}/feed.xml` });
    const ep = a.ctx.db.episodes.find()[0]!;
    const t = Date.now() - 1000;
    const r1 = await sync(admin, 0, {
      episodeStates: [{ id: 'es_1abcdef', episodeId: ep.id, status: 'inProgress', positionMs: 91000, clientUpdatedAt: t, starred: false }],
      bookmarks: [{ id: 'bm_1abcdef', episodeId: ep.id, positionMs: 5000, title: 'Nice', note: 'remember', createdAt: t, clientUpdatedAt: t }],
      playlists: [{ id: 'pl_1abcdef', name: 'Road trip', episodeIds: [ep.id], clientUpdatedAt: t }],
      smartPlaylists: [{ id: 'sp_1abcdef', name: 'Fresh', definition: { name: 'Fresh', match: 'all', rules: [{ field: 'status', op: 'is', value: 'unplayed' }], sort: { field: 'releasedAt', dir: 'desc' } }, clientUpdatedAt: t }],
      settings: [{ id: 'st_1abcdef', defaultSpeed: 1.2, podcastSpeeds: { [ep.podcastId]: 1.8 }, prefs: {}, clientUpdatedAt: t }],
    });
    expect(r1.rejected).toEqual([]);
    expect(r1.changes.episodeStates[0].positionMs).toBe(91000);
    expect(r1.changes.episodeStates[0].rev).toBeGreaterThan(0);
    expect(r1.changes.bookmarks[0].title).toBe('Nice');
    expect(r1.changes.settings[0].podcastSpeeds[ep.podcastId]).toBe(1.8);
    // maya can't read or overwrite them
    expect((await sync(maya, 0)).changes.bookmarks).toHaveLength(0);
    const steal = await sync(maya, 0, { bookmarks: [{ id: 'bm_1abcdef', episodeId: ep.id, positionMs: 1, title: 'mine', createdAt: t, clientUpdatedAt: Date.now() }] });
    expect(steal.rejected).toEqual([{ collection: 'bookmarks', id: 'bm_1abcdef', reason: 'forbidden' }]);
    expect(a.ctx.db.bookmarks.get('bm_1abcdef')!.title).toBe('Nice');
  });

  it('last-write-wins, with position from the latest play event and played beating unplayed unless newer', async () => {
    await post(admin, '/podcasts', { feedUrl: `${origin.url}/feed.xml` });
    const ep = a.ctx.db.episodes.find()[0]!;
    const base = Date.now() - 100_000;
    const state = (o: object) => ({ id: 'es_1abcdef', episodeId: ep.id, starred: false, ...o });
    await sync(admin, 0, { episodeStates: [state({ status: 'inProgress', positionMs: 1000, clientUpdatedAt: base + 10 })] });
    // older write loses
    await sync(admin, 0, { episodeStates: [state({ status: 'unplayed', positionMs: 0, clientUpdatedAt: base })] });
    let cur = a.ctx.db.episodeStates.get('es_1abcdef')!;
    expect([cur.status, cur.positionMs]).toEqual(['inProgress', 1000]);
    // newer play event wins position even if the status write is older
    await sync(admin, 0, { episodeStates: [state({ status: 'inProgress', positionMs: 5000, clientUpdatedAt: base + 5, positionUpdatedAt: base + 50 })] });
    cur = a.ctx.db.episodeStates.get('es_1abcdef')!;
    expect(cur.positionMs).toBe(5000);
    // played wins over an older progress update
    await sync(admin, 0, { episodeStates: [state({ status: 'played', positionMs: 5000, clientUpdatedAt: base + 100 })] });
    await sync(admin, 0, { episodeStates: [state({ status: 'inProgress', positionMs: 6000, clientUpdatedAt: base + 90 })] });
    expect(a.ctx.db.episodeStates.get('es_1abcdef')!.status).toBe('played');
    // an explicitly newer unplayed wins
    await sync(admin, 0, { episodeStates: [state({ status: 'unplayed', positionMs: 0, clientUpdatedAt: base + 200 })] });
    expect(a.ctx.db.episodeStates.get('es_1abcdef')!.status).toBe('unplayed');
    // an older "played" can't resurrect it
    await sync(admin, 0, { episodeStates: [state({ status: 'played', positionMs: 0, clientUpdatedAt: base + 150 })] });
    expect(a.ctx.db.episodeStates.get('es_1abcdef')!.status).toBe('unplayed');
  });

  it('clamps future client timestamps and propagates tombstones', async () => {
    await post(admin, '/podcasts', { feedUrl: `${origin.url}/feed.xml` });
    const future = Date.now() + 10 * 86_400_000;
    await sync(admin, 0, { playlists: [{ id: 'pl_1abcdef', name: 'A', episodeIds: [], clientUpdatedAt: future }] });
    expect(a.ctx.db.playlists.get('pl_1abcdef')!.clientUpdatedAt).toBeLessThanOrEqual(Date.now());
    const before = (await sync(admin, 0)).cursor;
    await sync(admin, before, { playlists: [{ id: 'pl_1abcdef', name: 'A', episodeIds: [], clientUpdatedAt: Date.now(), deleted: true }] });
    const delta = await sync(admin, before);
    expect(delta.changes.playlists[0]).toMatchObject({ id: 'pl_1abcdef', deleted: true });
  });

  it('paginates on whole rev groups and requests a full resync past the tombstone horizon', async () => {
    const many = rssFeed('Big', Array.from({ length: 700 }, (_, i) => ({ guid: `g${i}`, title: `E${i}`, url: `http://127.0.0.1/${i}.mp3` })));
    const big = await fakeOrigin({ '/big.xml': { type: 'application/rss+xml', body: many } });
    await post(admin, '/podcasts', { feedUrl: `${big.url}/big.xml` });
    // one subscription group holds everything, so it arrives whole...
    const p1 = await sync(admin, 0);
    expect(p1.changes.episodes).toHaveLength(700);
    // ...and later single-episode revs paginate normally
    expect(p1.hasMore).toBe(false);
    a.ctx.db.raiseHorizon(a.ctx.db.currentRev + 5);
    const stale = await sync(admin, 1);
    expect(stale.fullResync).toBe(true);
    await big.close();
  });

  it('purges tombstones older than 90 days', async () => {
    await post(admin, '/podcasts', { feedUrl: `${origin.url}/feed.xml` });
    await sync(admin, 0, { playlists: [{ id: 'pl_1abcdef', name: 'A', episodeIds: [], clientUpdatedAt: Date.now(), deleted: true }] });
    expect(a.ctx.sync.purgeTombstones()).toBe(0);
    a.ctx.db.playlists.get('pl_1abcdef')!.deletedAt = Date.now() - 91 * 86_400_000;
    expect(a.ctx.sync.purgeTombstones()).toBe(1);
    expect(a.ctx.db.playlists.get('pl_1abcdef')).toBeNull();
    expect(a.ctx.db.horizon).toBeGreaterThan(0);
  });

  it('rejects malformed payloads', async () => {
    expect((await post(admin, '/sync', { cursor: 'x' })).statusCode).toBe(400);
    expect((await post(admin, '/sync', { cursor: 0, deviceId: 'd', changes: { episodeStates: [{ id: 'bad id!', episodeId: 'x' }] } })).statusCode).toBe(400);
  });
});
