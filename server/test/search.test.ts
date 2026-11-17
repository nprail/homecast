import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { bearer, createUser, fakeOrigin, registerAdmin, rssFeed, startApp, type Session } from './helpers.js';

let a: App;
let origin: Awaited<ReturnType<typeof fakeOrigin>>;
let admin: Session;
let maya: Session;
const ids: Record<string, string> = {};

const seg = (startMs: number, text: string) => ({ startMs, endMs: startMs + 3000, text });
const search = (s: Session, qs: string) => a.app.inject({ method: 'GET', url: `/api/v1/search/transcripts?${qs}`, headers: bearer(s) });

beforeEach(async () => {
  origin = await fakeOrigin({});
  origin.routes['/f1.xml'] = { type: 'application/rss+xml', body: rssFeed('Gardening Hour', [{ guid: 'g1', title: 'Tomatoes', url: `${origin.url}/1.mp3` }, { guid: 'g2', title: 'Compost', url: `${origin.url}/2.mp3` }]) };
  origin.routes['/f2.xml'] = { type: 'application/rss+xml', body: rssFeed('Kitchen Talk', [{ guid: 'k1', title: 'Bread', url: `${origin.url}/3.mp3` }]) };
  a = await startApp();
  admin = await registerAdmin(a);
  maya = await createUser(a, admin, 'maya');
  const add = async (s: Session, path: string) =>
    (await a.app.inject({ method: 'POST', url: '/api/v1/podcasts', headers: bearer(s), payload: { feedUrl: `${origin.url}${path}` } })).json().podcast.id as string;
  ids.garden = await add(admin, '/f1.xml');
  ids.kitchen = await add(maya, '/f2.xml');
  for (const e of a.ctx.db.episodes.find()) ids[e.guid] = e.id;
  const put = (guid: string, segments: ReturnType<typeof seg>[]) => a.ctx.db.transcripts.insert({ episodeId: ids[guid]!, source: 'whisper', status: 'ready', model: 'base', segments, createdAt: 1 });
  put('g1', [seg(0, 'Today we plant tomatoes in the spring.'), seg(4000, 'Tomatoes need lots of sun and water.'), seg(9000, 'Basil is a good neighbour.')]);
  put('g2', [seg(0, 'Compost feeds the soil.'), seg(5000, 'Never put tomatoes with blight in the pile.')]);
  put('k1', [seg(0, 'Flour, water, salt and yeast.'), seg(6000, 'Slow fermentation tastes better than tomatoes on bread.')]);
});
afterEach(async () => {
  await origin.close();
  await a.close();
});

describe('transcript search', () => {
  it('finds matching lines with timestamps, ranked by number of matches', async () => {
    const r = await search(admin, 'q=tomatoes');
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.total).toBe(2);
    expect(j.items.map((i: { episodeTitle: string }) => i.episodeTitle)).toEqual(['Tomatoes', 'Compost']); // 2 matches, then 1
    expect(j.items[0]).toMatchObject({ matches: 2, podcastTitle: 'Gardening Hour' });
    expect(j.items[0].hits).toEqual([
      { startMs: 0, text: 'Today we plant tomatoes in the spring.', marks: [[15, 23]] },
      { startMs: 4000, text: 'Tomatoes need lots of sun and water.', marks: [[0, 8]] },
    ]);
  });

  it('only searches podcasts the user subscribes to', async () => {
    expect((await search(maya, 'q=tomatoes')).json().items.map((i: { episodeTitle: string }) => i.episodeTitle)).toEqual(['Bread']);
    expect((await search(maya, 'q=compost')).json().total).toBe(0);
    expect((await search(admin, 'q=yeast')).json().total).toBe(0);
  });

  it('requires every word somewhere in the episode, supports phrases, and matches across two adjacent lines', async () => {
    expect((await search(admin, 'q=plant+yeast')).json().total).toBe(0);
    const spread = (await search(admin, 'q=plant+basil')).json(); // different lines of one episode still match
    expect(spread.total).toBe(1);
    expect(spread.items[0].hits.map((h: { startMs: number }) => h.startMs)).toEqual([0, 9000]);
    expect((await search(admin, 'q=lots+sun')).json().total).toBe(1);
    expect((await search(admin, `q=${encodeURIComponent('"sun and water"')}`)).json().total).toBe(1);
    expect((await search(admin, `q=${encodeURIComponent('"water and sun"')}`)).json().total).toBe(0);
    // "spring. Tomatoes" straddles lines one and two of the first episode
    expect((await search(admin, `q=${encodeURIComponent('"spring. tomatoes"')}`)).json().total).toBe(1);
  });

  it('can be limited to one podcast and ignores podcasts you do not follow', async () => {
    expect((await search(admin, `q=tomatoes&podcastId=${ids.garden}`)).json().total).toBe(2);
    expect((await search(admin, `q=tomatoes&podcastId=${ids.kitchen}`)).json().total).toBe(0);
  });

  it('pages, ignores removed episodes, and validates the query', async () => {
    expect((await search(admin, 'q=tomatoes&limit=1&offset=1')).json().items).toHaveLength(1);
    const ep = a.ctx.db.episodes.get(ids.g1!)!;
    ep.deleted = true;
    a.ctx.db.episodes.save(ep);
    expect((await search(admin, 'q=tomatoes')).json().total).toBe(1);
    expect((await search(admin, 'q=a')).statusCode).toBe(400);
    expect((await a.app.inject({ method: 'GET', url: '/api/v1/search/transcripts?q=tomatoes' })).statusCode).toBe(401);
  });
});

describe('transcript search, full text', () => {
  it('matches other forms of a word, the start of the last word, and small typos', async () => {
    expect((await search(admin, 'q=plants')).json().items[0].hits[0].marks).toEqual([[9, 14]]); // plant ~ plants
    expect((await search(admin, 'q=ferment')).json().total).toBe(0); // admin does not follow the kitchen podcast
    expect((await search(maya, 'q=ferment')).json().total).toBe(1); // fermentation
    expect((await search(admin, 'q=tomat')).json().total).toBe(2); // prefix of the last word
    expect((await search(admin, 'q=tomatos')).json().total).toBe(2); // one letter off
    expect((await search(admin, 'q=tomaato')).json().total).toBe(2);
    expect((await search(admin, 'q=qqqqqqqq')).json().total).toBe(0);
  });

  it('excludes words, ranks episodes that have the words together first, and marks the match', async () => {
    expect((await search(admin, 'q=tomatoes+-compost')).json().items.map((i: { episodeTitle: string }) => i.episodeTitle)).toEqual(['Tomatoes']);
    expect((await search(admin, 'q=tomatoes+-basil')).json().items.map((i: { episodeTitle: string }) => i.episodeTitle)).toEqual(['Compost']);
    const j = (await search(admin, 'q=sun+water')).json();
    expect(j.items[0].hits[0]).toEqual({ startMs: 4000, text: 'Tomatoes need lots of sun and water.', marks: [[22, 25], [30, 35]] });
    const phrase = (await search(admin, `q=${encodeURIComponent('"sun and water"')}`)).json();
    expect(phrase.items[0].hits[0].marks).toEqual([[22, 35]]); // one stretch for the whole phrase
  });

  it('keeps up as transcripts are added and removed', async () => {
    expect((await search(admin, 'q=sourdough')).json().total).toBe(0);
    expect((await search(admin, 'q=compost')).json().total).toBe(1);
    a.ctx.db.transcripts.remove(a.ctx.db.transcripts.findOne({ episodeId: ids.g2! })!);
    expect((await search(admin, 'q=compost')).json().total).toBe(0);
    a.ctx.db.transcripts.insert({ episodeId: ids.g2!, source: 'whisper', status: 'ready', model: 'base', segments: [seg(0, 'A sourdough starter needs feeding.')], createdAt: 2 });
    expect((await search(admin, 'q=sourdough')).json().total).toBe(1);
  });
});

describe('shared moment preview', () => {
  const share = (s: Session, id: string) => a.app.inject({ method: 'GET', url: `/api/v1/episodes/${id}/share`, headers: bearer(s) });

  it('shows a public episode to someone who does not follow the podcast yet', async () => {
    const r = await share(maya, ids.g1!);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ episode: { id: ids.g1, title: 'Tomatoes' }, podcast: { id: ids.garden, title: 'Gardening Hour', isPrivate: false }, subscribed: false });
    expect((await share(admin, ids.g1!)).json().subscribed).toBe(true);
  });

  it('hides private feeds from people who do not follow them, and needs a login', async () => {
    const p = a.ctx.db.podcasts.get(ids.garden!)!;
    p.isPrivate = true;
    a.ctx.db.podcasts.save(p);
    expect((await share(maya, ids.g1!)).statusCode).toBe(404);
    expect((await share(admin, ids.g1!)).statusCode).toBe(200);
    expect((await a.app.inject({ method: 'GET', url: `/api/v1/episodes/${ids.g1}/share` })).statusCode).toBe(401);
    expect((await share(maya, 'no-such-episode')).statusCode).toBe(404);
  });
});
