import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { sniffImage } from '../src/services/art.js';
import { bearer, fakeOrigin, registerAdmin, rssFeed, startApp, type Session } from './helpers.js';

let a: App;
let origin: Awaited<ReturnType<typeof fakeOrigin>>;
let admin: Session;
let podcastId: string;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 9)]);
const art = (id = podcastId) => a.app.inject({ method: 'GET', url: `/api/v1/art/${id}` });
const setImage = (url: string | null) => {
  const p = a.ctx.db.podcasts.get(podcastId)!;
  p.imageUrl = url;
  a.ctx.db.podcasts.save(p);
};
const cached = () => (existsSync(a.ctx.art.dir) ? readdirSync(a.ctx.art.dir) : []);

beforeEach(async () => {
  origin = await fakeOrigin({
    '/cover.png': { type: 'application/octet-stream', body: PNG },
    '/cover2.jpg': { type: 'image/jpeg', body: JPEG },
    '/evil.svg': { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
    '/page.html': { type: 'image/png', body: '<html>not an image</html>' },
  });
  origin.routes['/f.xml'] = { type: 'application/rss+xml', body: rssFeed('Alpha', [{ guid: 'g1', title: 'One', url: `${origin.url}/a.mp3` }]) };
  a = await startApp();
  admin = await registerAdmin(a);
  const r = await a.app.inject({ method: 'POST', url: '/api/v1/podcasts', headers: bearer(admin), payload: { feedUrl: `${origin.url}/f.xml` } });
  podcastId = r.json().podcast.id;
  setImage(`${origin.url}/cover.png`);
});
afterEach(async () => {
  await origin.close();
  await a.close();
});

describe('podcast artwork proxy', () => {
  it('serves the cover from this origin with the real image type, and fetches it only once', async () => {
    const r = await art();
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png'); // by content, not the origin's wrong header
    expect(r.rawPayload.equals(PNG)).toBe(true);
    expect(r.headers['cache-control']).toContain('max-age');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    await art();
    await art();
    expect(origin.hits['/cover.png']).toBe(1);
    expect(origin.hits['/a.mp3'] ?? 0).toBe(0);
  });

  it('needs no login, answers conditional requests, and ignores the cache-busting query', async () => {
    const first = await art();
    const again = await a.app.inject({ method: 'GET', url: `/api/v1/art/${podcastId}?v=abc`, headers: { 'if-none-match': first.headers.etag as string } });
    expect(again.statusCode).toBe(304);
  });

  it('refuses anything that is not a raster image (SVG, HTML, wrong bytes)', async () => {
    for (const u of ['/evil.svg', '/page.html', '/missing.png']) {
      setImage(`${origin.url}${u}`);
      expect((await art()).statusCode).toBe(404);
    }
    expect(cached().filter((f) => !f.endsWith('.part'))).toHaveLength(0);
  });

  it('does not retry a failing image on every request', async () => {
    setImage(`${origin.url}/missing.png`);
    await art();
    await art();
    expect(origin.hits['/missing.png']).toBe(1);
  });

  it('fetches again when the feed changes its artwork, and sweeps the unused copy', async () => {
    await art();
    setImage(`${origin.url}/cover2.jpg`);
    const r = await art();
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(cached()).toHaveLength(2);
    expect(a.ctx.art.sweep()).toBe(1);
    expect(cached()).toHaveLength(1);
    expect(cached()[0]).toMatch(/\.jpg$/);
  });

  it('404s for unknown, deleted, or image-less podcasts', async () => {
    expect((await art('00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
    setImage(null);
    expect((await art()).statusCode).toBe(404);
    setImage(`${origin.url}/cover.png`);
    const p = a.ctx.db.podcasts.get(podcastId)!;
    p.deleted = true;
    a.ctx.db.podcasts.save(p);
    expect((await art()).statusCode).toBe(404);
  });

  it('does not fetch private-network images unless the guard is relaxed', async () => {
    const strict = await startApp({ allowPrivateNetworks: false });
    try {
      strict.ctx.db.podcasts.insert({ id: 'p-private-img-0001', feedUrl: 'https://x.example/f.xml', title: 'X', imageUrl: `${origin.url}/cover.png` } as never);
      expect((await strict.app.inject({ method: 'GET', url: '/api/v1/art/p-private-img-0001' })).statusCode).toBe(404);
      expect(origin.hits['/cover.png'] ?? 0).toBe(0);
    } finally {
      await strict.close();
    }
  });

  it('only allows own-origin images in the page CSP', async () => {
    const r = await a.app.inject({ method: 'GET', url: '/api/v1/health' });
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toMatch(/img-src 'self' data: blob:(;|$)/);
    expect(csp).not.toMatch(/img-src[^;]*https?:/);
  });
});

describe('sniffImage', () => {
  it('recognises raster formats by their first bytes', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(JPEG)).toBe('jpg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('gif');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('webp');
    expect(sniffImage(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif')]))).toBe('avif');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});
