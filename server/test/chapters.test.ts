import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { parseFeed } from '../src/services/feedParser.js';
import { parseChaptersJson, parseDescriptionChapters, parseNpt } from '../src/services/chapters.js';
import { bearer, fakeOrigin, registerAdmin, startApp, type Session } from './helpers.js';

const NS = 'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:psc="http://podlove.org/simple-chapters"';
const feed = (items: string) => `<?xml version="1.0"?><rss version="2.0" ${NS}><channel><title>Chap</title>${items}</channel></rss>`;
const item = (guid: string, extra: string, desc = 'plain') =>
  `<item><title>${guid}</title><guid>${guid}</guid><pubDate>Mon, 02 Nov 2026 00:00:00 GMT</pubDate><enclosure url="http://x.test/${guid}.mp3" type="audio/mpeg" length="1"/><description><![CDATA[${desc}]]></description>${extra}</item>`;

describe('chapter parsing', () => {
  it('parses Normal Play Time', () => {
    expect(parseNpt('90')).toBe(90_000);
    expect(parseNpt('1:30')).toBe(90_000);
    expect(parseNpt('01:02:03.5')).toBe(3_723_500);
    expect(parseNpt('soon')).toBeNull();
  });

  it('reads Podcasting 2.0 JSON, sorting, dropping toc:false and bad entries', () => {
    const list = parseChaptersJson(
      JSON.stringify({
        version: '1.2.0',
        chapters: [
          { startTime: 60, title: 'Second', img: 'https://i.test/a.jpg', url: 'javascript:alert(1)' },
          { startTime: 0, title: '<b>First</b>' },
          { startTime: 30, title: 'Hidden', toc: false },
          { startTime: -5, title: 'Negative' },
          { startTime: 90 },
        ],
      }),
    );
    expect(list).toEqual([
      { startMs: 0, title: 'First' },
      { startMs: 60_000, title: 'Second', img: 'https://i.test/a.jpg' },
    ]);
    expect(parseChaptersJson('nope')).toEqual([]);
  });

  it('finds chapter tags and inline chapters in a feed', () => {
    const parsed = parseFeed(
      feed(
        item('a', '<podcast:chapters url="https://c.test/a.json" type="application/json+chapters"/>') +
          item('b', '<psc:chapters version="1.2"><psc:chapter start="00:00:00" title="Intro"/><psc:chapter start="05:00" title="Main" href="https://x.test"/></psc:chapters>') +
          item('c', ''),
      ),
    );
    const by = Object.fromEntries(parsed.episodes.map((e) => [e.guid, e]));
    expect(by.a!.chaptersUrl).toBe('https://c.test/a.json');
    expect(by.b!.inlineChapters).toEqual([
      { startMs: 0, title: 'Intro' },
      { startMs: 300_000, title: 'Main', url: 'https://x.test/' },
    ]);
    expect(by.c!.chaptersUrl).toBeNull();
    expect(by.c!.inlineChapters).toBeNull();
  });

  it('reads show-note timestamps only when they look like a chapter list', () => {
    expect(parseDescriptionChapters('<p>Notes</p><p>00:00 Intro</p><p>05:10 - The news</p><p>1:02:00 Closing</p>')).toEqual([
      { startMs: 0, title: 'Intro' },
      { startMs: 310_000, title: 'The news' },
      { startMs: 3_720_000, title: 'Closing' },
    ]);
    expect(parseDescriptionChapters('<p>Intro (0:00)</p><p>Middle (4:00)</p><p>End (9:00)</p>')).toHaveLength(3);
    expect(parseDescriptionChapters('<p>00:00 Intro</p><p>05:10 Two</p>')).toEqual([]); // too few
    expect(parseDescriptionChapters('<p>10:00 One</p><p>20:00 Two</p><p>30:00 Three</p>')).toEqual([]); // does not start near 0
    expect(parseDescriptionChapters('<p>00:00 One</p><p>20:00 Two</p><p>10:00 Three</p>')).toEqual([]); // out of order
  });
});

describe('chapters endpoint', () => {
  let a: App;
  let origin: Awaited<ReturnType<typeof fakeOrigin>>;
  let admin: Session;
  const eps = new Map<string, string>();

  beforeEach(async () => {
    origin = await fakeOrigin({
      '/c.json': { type: 'application/json+chapters', body: JSON.stringify({ chapters: [{ startTime: 0, title: 'Cold open' }, { startTime: 120, title: 'Interview' }] }) },
      '/bad.json': { type: 'application/json', body: '{"chapters": []}' },
    });
    origin.routes['/f.xml'] = {
      type: 'application/rss+xml',
      body: feed(
        item('json', `<podcast:chapters url="${origin.url}/c.json" type="application/json+chapters"/>`) +
          item('inline', '<psc:chapters><psc:chapter start="0" title="A"/><psc:chapter start="60" title="B"/></psc:chapters>') +
          item('notes', '', '<p>00:00 Start</p><p>10:00 Middle</p><p>20:00 End</p>') +
          item('fallback', `<podcast:chapters url="${origin.url}/bad.json"/>`, '<p>00:00 One</p><p>01:00 Two</p><p>02:00 Three</p>') +
          item('none', '') +
          item('missing', `<podcast:chapters url="${origin.url}/gone.json"/>`),
      ),
    };
    a = await startApp();
    admin = await registerAdmin(a);
    const r = await a.app.inject({ method: 'POST', url: '/api/v1/podcasts', headers: bearer(admin), payload: { feedUrl: `${origin.url}/f.xml` } });
    expect(r.statusCode).toBe(201);
    for (const e of a.ctx.db.episodes.find()) eps.set(e.guid, e.id);
  });
  afterEach(async () => {
    await origin.close();
    await a.close();
  });

  const chapters = (guid: string) => a.app.inject({ method: 'GET', url: `/api/v1/episodes/${eps.get(guid)}/chapters`, headers: bearer(admin) });

  it('serves publisher JSON chapters and fetches the file once', async () => {
    const r = await chapters('json');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ source: 'json', chapters: [{ startMs: 0, title: 'Cold open' }, { startMs: 120_000, title: 'Interview' }] });
    await chapters('json');
    expect(origin.hits['/c.json']).toBe(1);
  });

  it('serves inline feed chapters and show-note chapters', async () => {
    expect((await chapters('inline')).json()).toEqual({ source: 'feed', chapters: [{ startMs: 0, title: 'A' }, { startMs: 60_000, title: 'B' }] });
    const notes = (await chapters('notes')).json();
    expect(notes.source).toBe('description');
    expect(notes.chapters).toHaveLength(3);
  });

  it('falls back to show notes when the chapters file is empty or missing, and does not refetch a failure right away', async () => {
    expect((await chapters('fallback')).json().source).toBe('description');
    expect((await chapters('missing')).statusCode).toBe(404);
    await chapters('missing');
    expect(origin.hits['/gone.json']).toBe(1);
  });

  it('is 404 when there are no chapters, and needs a login', async () => {
    expect((await chapters('none')).statusCode).toBe(404);
    expect((await a.app.inject({ method: 'GET', url: `/api/v1/episodes/${eps.get('json')}/chapters` })).statusCode).toBe(401);
  });

  it('picks up a changed chapters URL on the next feed refresh', async () => {
    await chapters('json');
    origin.routes['/f.xml']!.body = feed(item('json', `<podcast:chapters url="${origin.url}/bad.json"/>`));
    const p = a.ctx.db.podcasts.find()[0]!;
    await a.ctx.feeds.refresh(p, { force: true });
    expect(a.ctx.db.episodes.get(eps.get('json')!)!.chaptersUrl).toBe(`${origin.url}/bad.json`);
    expect((await chapters('json')).statusCode).toBe(404); // new file is empty and the cached list was for the old URL
  });
});
