/* Homecast service worker. Generated into dist/sw.js by the build (precache list injected). */
const VERSION = '__VERSION__';
const SHELL = `homecast-shell-${VERSION}`;
const IMAGES = 'homecast-images';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('homecast-shell-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never touch the API (auth, sync, proxy) or the offline audio store: they have their own handling.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;
  if (req.headers.has('range')) return; // media range requests go straight to the network

  // App shell: SPA navigations fall back to the cached index when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match('/index.html')) || Response.error()),
    );
    return;
  }

  // Same-origin static assets: cache-first (hashed filenames never change).
  if (url.origin === self.location.origin) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && !url.pathname.endsWith('sw.js')) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // Podcast artwork from other origins: stale-while-revalidate with a size cap.
  if (req.destination === 'image') {
    event.respondWith(
      caches.open(IMAGES).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req).then(async (res) => {
          if (res.ok || res.type === 'opaque') {
            await cache.put(req, res.clone());
            const keys = await cache.keys();
            if (keys.length > 300) await cache.delete(keys[0]);
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      }),
    );
  }
});
