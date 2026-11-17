/**
 * Compares the storage engines on a large library.
 *
 *   npx tsx scripts/bench-db.ts compare --scale medium          # seeds and measures both engines, prints a table
 *   npx tsx scripts/bench-db.ts compare --scale large --engines sqlite,docstore
 *   npx tsx scripts/bench-db.ts seed --engine sqlite --dir /tmp/db --scale medium    (one step on its own)
 *   npx tsx scripts/bench-db.ts run  --engine sqlite --dir /tmp/db
 *
 * Each engine is seeded, then measured in a fresh process, so startup time and memory are real.
 * Everything goes through the same code the server runs: the repositories, the sync service and the HTTP routes.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Database, type EngineName } from '../src/db/index.js';

const SCALES = {
  // users, podcasts, episodes per podcast, episode states per user, transcripts, segments per transcript, subs per user, heavy user's subs
  small: { users: 10, podcasts: 100, perPodcast: 200, states: 500, transcripts: 100, segments: 400, subs: 15, heavySubs: 30 },
  medium: { users: 25, podcasts: 250, perPodcast: 400, states: 2000, transcripts: 300, segments: 600, subs: 30, heavySubs: 40 },
  large: { users: 100, podcasts: 1000, perPodcast: 500, states: 3000, transcripts: 600, segments: 700, subs: 40, heavySubs: 60 },
} as const;
type Scale = keyof typeof SCALES;

const args = process.argv.slice(2);
const mode = args[0] ?? 'compare';
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const scaleName = (opt('scale', 'medium') as Scale) in SCALES ? (opt('scale', 'medium') as Scale) : 'medium';
const S = SCALES[scaleName];
const dbEnv = (engine: EngineName, dir: string) => ({ DATA_DIR: dir, ALLOW_PRIVATE_NETWORKS: 'true', PUBLIC_URL: 'http://localhost:8080', DB_ENGINE: engine });
const openDb = (engine: EngineName, dir: string) => Database.open({ dataDir: dir, engine, autosaveMs: 0 });
const ADMIN = { username: 'bench', password: 'bench-password-123' };

// ---- deterministic data ------------------------------------------------------------------------------------------
let seed = 1234567;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
const WORDS = 'garden tomato compost bread flour yeast router packet queue network storage kitchen school church music budget budgeting planning prayer sermon family travel health sleep running coffee podcast server database index cache memory'.split(' ');
const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
const SHOW_NOTES = `<p>${sentence(40)}</p><p>${sentence(60)}</p><ul>${Array.from({ length: 6 }, () => `<li>${sentence(8)}</li>`).join('')}</ul><p>${sentence(50)}</p>`;

// ---- seeding -----------------------------------------------------------------------------------------------------
async function seedDb(engine: EngineName, dir: string): Promise<Record<string, number>> {
  const config = loadConfig(dbEnv(engine, dir), { webDir: null, startWorkers: false });
  const t0 = performance.now();
  const db = await openDb(engine, dir);
  const app = await buildApp(config, { db, logger: false });
  const reg = await app.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { ...ADMIN, bootstrapToken: app.ctx.bootstrap.token } });
  const adminId = reg.json().user.id as string;

  const t = Date.now();
  const loadStart = performance.now();
  const users: string[] = [adminId];
  const podcastIds: string[] = [];
  const episodeIds: string[] = [];
  const byPodcast = new Map<string, string[]>();
  db.batch(() => {
    for (let u = 1; u < S.users; u++) users.push(db.users.insert({ username: `user${u}`, usernameKey: `user${u}`, passwordHash: 'x', role: 'user', createdAt: t, disabled: false, lastActiveAt: t }).id);
    for (let p = 0; p < S.podcasts; p++) {
      const pod = db.podcasts.insert({
        feedUrl: `https://feeds.example.com/show-${p}.xml`, isPrivate: false, hiddenFromDiscover: false, title: `${sentence(3)} Show ${p}`, author: `Author ${p % 40}`,
        imageUrl: `https://img.example.com/${p}.jpg`, description: sentence(40), createdAt: t, lastFetchedAt: t, lastFetchMs: 200, etag: null, lastModified: null,
        fetchError: null, failureCount: 0, nextFetchAt: t + 3_600_000, createdBy: adminId,
      });
      podcastIds.push(pod.id);
      const ids: string[] = [];
      for (let e = 0; e < S.perPodcast; e++) {
        const ep = db.episodes.insert({
          podcastId: pod.id, guid: uuid(), title: `${sentence(7)} (${e})`, description: SHOW_NOTES, audioUrl: `https://cdn.example.com/${p}/${e}-${hex(16)}.mp3`,
          mimeType: 'audio/mpeg', durationSec: 600 + Math.floor(rnd() * 3000), releasedAt: t - (S.perPodcast - e) * 86_400_000, createdAt: t, transcriptUrl: null, transcriptType: null,
        });
        ids.push(ep.id);
        episodeIds.push(ep.id);
      }
      byPodcast.set(pod.id, ids);
    }
  });
  const subsOf = new Map<string, string[]>();
  db.batch(() => {
    users.forEach((uid, i) => {
      const n = i === 0 ? S.heavySubs : S.subs;
      const chosen = new Set<string>();
      while (chosen.size < Math.min(n, podcastIds.length)) chosen.add(pick(podcastIds));
      subsOf.set(uid, [...chosen]);
      for (const pid of chosen) db.subscriptions.insert({ userId: uid, podcastId: pid, autoDownload: { mode: 'off' }, newEpisodeNotify: true, clientUpdatedAt: t });
    });
    for (const uid of users) {
      const pool = (subsOf.get(uid) ?? []).flatMap((pid) => byPodcast.get(pid) ?? []);
      for (let s = 0; s < S.states; s++) {
        db.episodeStates.insert({
          userId: uid, episodeId: pick(pool), status: s % 3 === 0 ? 'played' : 'inProgress', positionMs: Math.floor(rnd() * 3_000_000), positionUpdatedAt: t, playedAt: null, starred: s % 50 === 0, clientUpdatedAt: t,
        });
      }
      for (let b = 0; b < 20; b++) db.bookmarks.insert({ userId: uid, episodeId: pick(pool), positionMs: Math.floor(rnd() * 3_000_000), title: sentence(3), note: null, createdAt: t, clientUpdatedAt: t });
    }
  });
  const heavyEpisodes = (subsOf.get(adminId) ?? []).flatMap((pid) => byPodcast.get(pid) ?? []);
  db.batch(() => {
    for (let i = 0; i < S.transcripts; i++) {
      const eid = heavyEpisodes[i % heavyEpisodes.length]!;
      if (db.transcripts.findOne({ episodeId: eid })) continue;
      const segments = Array.from({ length: S.segments }, (_, k) => ({ startMs: k * 4000, endMs: k * 4000 + 3800, text: `${sentence(12)}.` }));
      if (i % 5 === 0) segments[10]!.text = 'We grow tomatoes and compost in the garden all spring.';
      db.transcripts.insert({ episodeId: eid, source: 'whisper', status: 'ready', model: 'base', segments, createdAt: t });
    }
  });
  const loadMs = performance.now() - loadStart;

  // The periodic save. On the in-memory engine this rewrites the whole database.
  const lag = monitorEventLoopDelay({ resolution: 1 });
  lag.enable();
  const saveStart = performance.now();
  await db.save();
  const saveMs = performance.now() - saveStart;
  lag.disable();
  const counts = { episodes: db.episodes.count(), states: db.episodeStates.count(), transcripts: db.transcripts.count() };
  await app.close();
  const bytes = db.fileSize() || dirSize(dir);
  writeFileSync(path.join(dir, 'bench.json'), JSON.stringify({ adminId, heavyEpisodes: heavyEpisodes.slice(0, 200), podcast: podcastIds[0], transcriptEpisode: db.transcripts ? undefined : undefined }));
  return { seedTotalMs: performance.now() - t0, loadMs, firstSaveMs: saveMs, firstSaveBlockedMaxMs: lag.max / 1e6, ...counts, diskBytes: bytes };
}

function dirSize(dir: string): number {
  let n = 0;
  for (const f of readdirSync(dir)) {
    const st = statSync(path.join(dir, f));
    if (st.isFile() && /homecast\.db/.test(f)) n += st.size;
  }
  return n;
}

// ---- measuring ---------------------------------------------------------------------------------------------------
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))]!;
const mb = (n: number) => Math.round(n / 1048576);

async function timeIt(n: number, fn: (i: number) => Promise<unknown> | unknown): Promise<{ med: number; p95: number }> {
  await fn(-1); // warm up (statement cache, JIT)
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn(i);
    times.push(performance.now() - t);
  }
  return { med: median(times), p95: p95(times) };
}

async function runDb(engine: EngineName, dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const meta = JSON.parse(readFileSync(path.join(dir, 'bench.json'), 'utf8')) as { adminId: string; heavyEpisodes: string[]; podcast: string };
  const config = loadConfig(dbEnv(engine, dir), { webDir: null, startWorkers: false });
  const rss0 = process.memoryUsage().rss;

  let t = performance.now();
  const db = await openDb(engine, dir);
  out.coldOpenMs = performance.now() - t;
  t = performance.now();
  const app = await buildApp(config, { db, logger: false });
  out.appStartMs = performance.now() - t;
  global.gc?.();
  const mem = process.memoryUsage();
  out.rssAfterOpenMB = mb(mem.rss);
  out.heapAfterOpenMB = mb(mem.heapUsed);
  void rss0;

  const login = await app.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { ...ADMIN, client: 'native' } });
  const token = login.json().accessToken as string;
  const auth = { authorization: `Bearer ${token}` };
  // Every request must succeed, or the timing means nothing.
  const ok = <R extends { statusCode: number; body: string }>(r: R, what: string): R => {
    if (r.statusCode !== 200) throw new Error(`${what} returned ${r.statusCode}: ${r.body.slice(0, 200)}`);
    return r;
  };
  // The rate limiter is per client address; give each request its own so the benchmark measures the database, not the limiter.
  let n = 0;
  const from = () => `10.${(++n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  const get = async (url: string) => ok(await app.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: auth, remoteAddress: from() }), `GET ${url}`);
  const post = async (url: string, payload: unknown) => ok(await app.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: auth, payload: payload as object, remoteAddress: from() }), `POST ${url}`);

  // Full sync from nothing: a new device pulling the whole library of a heavy user, page by page.
  const fullSync = async () => {
    let cursor = 0;
    let pages = 0;
    let records = 0;
    for (;;) {
      const r = (await post('/sync', { cursor, deviceId: 'bench' })).json();
      pages++;
      records += Object.values(r.changes as Record<string, unknown[]>).reduce((a, l) => a + l.length, 0);
      cursor = r.cursor;
      if (!r.hasMore) break;
    }
    return { pages, records };
  };
  const first = await fullSync();
  out.fullSyncRecords = first.records;
  out.fullSyncPages = first.pages;
  let s = await timeIt(3, fullSync);
  out.fullSyncMedMs = s.med;

  const cur = (await post('/sync', { cursor: 0, deviceId: 'bench' })).json().cursor as number;
  void cur;
  const head = async () => {
    let cursor = 0;
    for (;;) {
      const r = (await post('/sync', { cursor, deviceId: 'bench' })).json();
      cursor = r.cursor;
      if (!r.hasMore) return cursor;
    }
  };
  const tip = await head();
  s = await timeIt(200, () => post('/sync', { cursor: tip, deviceId: 'bench' }));
  out.syncIdleMedMs = s.med;
  out.syncIdleP95Ms = s.p95;

  const states = meta.heavyEpisodes.slice(0, 25).map((episodeId, i) => ({ id: `s${hex(30)}`, episodeId, status: 'inProgress', positionMs: 1000 * (i + 1), clientUpdatedAt: Date.now(), starred: false }));
  const pushed = (await post('/sync', { cursor: tip, deviceId: 'bench', changes: { episodeStates: states } })).json();
  if (pushed.rejected.length) throw new Error(`push rejected: ${JSON.stringify(pushed.rejected[0])}`);
  out.pushRejected = pushed.rejected.length;
  s = await timeIt(100, () => post('/sync', { cursor: tip, deviceId: 'bench', changes: { episodeStates: states.map((x, i) => ({ ...x, positionMs: x.positionMs + i + 1, clientUpdatedAt: Date.now() })) } }));
  out.syncPush25MedMs = s.med;
  out.syncPush25P95Ms = s.p95;

  s = await timeIt(10, () => get('/discover?q=show&limit=50'));
  out.discoverMedMs = s.med;
  // The first search builds the full-text index (a server does it in the background after start-up).
  s = await timeIt(1, () => get('/search/transcripts?q=tomatoes%20compost&limit=20'));
  out.searchFirstMs = s.med;
  s = await timeIt(20, () => get('/search/transcripts?q=tomatoes%20compost&limit=20'));
  out.searchMedMs = s.med;
  const tr = db.transcripts.find()[0]!;
  s = await timeIt(30, () => get(`/episodes/${tr.episodeId}/transcript`));
  out.transcriptGetMedMs = s.med;
  s = await timeIt(5, () => get('/admin/overview'));
  out.adminOverviewMedMs = s.med;
  s = await timeIt(5, () => get('/admin/feeds'));
  out.adminFeedsMedMs = s.med;

  // One position update, as the player does every few seconds: read the state, change it, save it.
  const stateIds = db.episodeStates.find({ userId: meta.adminId }).slice(0, 500).map((x) => x.id);
  const wStart = performance.now();
  const N = 5000;
  for (let i = 0; i < N; i++) {
    const row = db.episodeStates.get(stateIds[i % stateIds.length]!)!;
    row.positionMs += 1000;
    db.episodeStates.save(row);
  }
  out.singleWritesPerSec = Math.round(N / ((performance.now() - wStart) / 1000));

  // A feed refresh that finds nothing new, and one that adds a few episodes, for a podcast with a full back catalogue.
  const pod = db.podcasts.get(meta.podcast)!;
  const existing = db.episodes.find({ podcastId: pod.id });
  const feedXml = (extra: number) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>${pod.title}</title>${existing.map((e) => item(e.guid, e.title, e.audioUrl, e.releasedAt, e.description)).join('')}${Array.from({ length: extra }, (_, i) => item(`new-${Date.now()}-${i}`, `New ${i}`, `http://x/${i}.mp3`, Date.now())).join('')}</channel></rss>`;
  function item(guid: string, title: string, url: string, at: number, description = `<p>${sentence(20)}</p>`) {
    return `<item><title>${title}</title><guid>${guid}</guid><pubDate>${new Date(at).toUTCString()}</pubDate><enclosure url="${url}" type="audio/mpeg" length="1"/><description><![CDATA[${description}]]></description></item>`;
  }
  let body = feedXml(0);
  const origin = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(body));
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  pod.feedUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/f.xml`;
  db.podcasts.save(pod);
  s = await timeIt(5, () => app.ctx.feeds.refresh(db.podcasts.get(pod.id)!, { force: true }));
  out.refreshNoChangeMedMs = s.med;
  s = await timeIt(5, async () => {
    body = feedXml(5);
    await app.ctx.feeds.refresh(db.podcasts.get(pod.id)!, { force: true });
  });
  out.refresh5NewMedMs = s.med;
  origin.close();

  // The periodic save after a burst of changes (autosave runs this every 5 seconds while anything changed).
  const lag = monitorEventLoopDelay({ resolution: 1 });
  lag.enable();
  t = performance.now();
  await db.save();
  out.periodicSaveMs = performance.now() - t;
  lag.disable();
  out.periodicSaveBlockedMaxMs = lag.max / 1e6;

  t = performance.now();
  const snap = db.snapshot(dir, 3);
  out.backupMs = performance.now() - t;
  out.backupMB = mb(snap.bytes);

  const end = process.memoryUsage();
  out.rssEndMB = mb(end.rss);
  out.heapEndMB = mb(end.heapUsed);
  out.diskMB = mb(db.fileSize());
  await app.close();
  return out;
}

// ---- driver ------------------------------------------------------------------------------------------------------
function child(step: 'seed' | 'run', engine: EngineName, dir: string): Record<string, number> | { error: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--expose-gc', '--max-old-space-size=8192', '--no-warnings', fileURLToPath(import.meta.url), step, '--engine', engine, '--dir', dir, '--scale', scaleName], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const line = r.stdout.split('\n').reverse().find((l) => l.startsWith('RESULT '));
  if (r.status !== 0 || !line) return { error: (r.stderr || r.stdout).split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 400) };
  return JSON.parse(line.slice(7)) as Record<string, number>;
}

const fmt = (n: number | undefined, unit = 'ms') => (n === undefined ? 'n/a' : n >= 100 ? `${Math.round(n).toLocaleString('en-US')} ${unit}` : n >= 10 ? `${n.toFixed(0)} ${unit}` : `${n.toFixed(1)} ${unit}`);

async function compare(): Promise<void> {
  const engines = (opt('engines', 'loki,sqlite,docstore') ?? 'loki,sqlite,docstore').split(',') as EngineName[];
  const results: Record<string, Record<string, number> | { error: string }> = {};
  for (const e of engines) {
    const dir = mkdtempSync(path.join(tmpdir(), `homecast-bench-${e}-`));
    process.stderr.write(`[${e}] seeding (${scaleName})…\n`);
    const seeded = child('seed', e, dir);
    if ('error' in seeded) { results[e] = seeded; continue; }
    process.stderr.write(`[${e}] measuring…\n`);
    const ran = child('run', e, dir);
    results[e] = 'error' in ran ? ran : { ...seeded, ...ran };
    rmSync(dir, { recursive: true, force: true });
  }
  const ok = engines.filter((e) => !('error' in results[e]!));
  for (const e of engines) if ('error' in results[e]!) console.log(`${e} failed: ${(results[e] as { error: string }).error}`);
  const first = results[ok[0] ?? engines[0]!] as Record<string, number>;
  if (!first) return;
  console.log(`\nScale ${scaleName}: ${S.users} users, ${first.episodes?.toLocaleString('en-US')} episodes, ${first.states?.toLocaleString('en-US')} play states, ${first.transcripts} transcripts\n`);
  const rows: [string, string, string?][] = [
    ['Seed: load everything in one batch', 'loadMs'],
    ['Cold start: open the database', 'coldOpenMs'],
    ['Cold start: build the app', 'appStartMs'],
    ['Memory after start (RSS)', 'rssAfterOpenMB', 'MB'],
    ['Heap after start', 'heapAfterOpenMB', 'MB'],
    ['Sync: idle poll, nothing changed (median)', 'syncIdleMedMs'],
    ['Sync: idle poll (p95)', 'syncIdleP95Ms'],
    ['Sync: push 25 play positions (median)', 'syncPush25MedMs'],
    ['Sync: new device pulls a heavy library (median)', 'fullSyncMedMs'],
    ['Discover search (median)', 'discoverMedMs'],
    ['Transcript search, first (builds the index)', 'searchFirstMs'],
    ['Transcript search (median)', 'searchMedMs'],
    ['Fetch one transcript (median)', 'transcriptGetMedMs'],
    ['Admin overview (median)', 'adminOverviewMedMs'],
    ['Admin feeds list (median)', 'adminFeedsMedMs'],
    ['Feed refresh, nothing new (median)', 'refreshNoChangeMedMs'],
    ['Feed refresh, 5 new episodes (median)', 'refresh5NewMedMs'],
    ['Single record writes per second', 'singleWritesPerSec', '/s'],
    ['Periodic save after a burst of writes', 'periodicSaveMs'],
    ['Periodic save: longest stall of the server', 'periodicSaveBlockedMaxMs'],
    ['Backup time', 'backupMs'],
    ['Backup size', 'backupMB', 'MB'],
    ['Database on disk', 'diskMB', 'MB'],
    ['Memory at the end (RSS)', 'rssEndMB', 'MB'],
  ];
  const head = ['| What | ' + engines.join(' | ') + ' |', '|---|' + engines.map(() => '---:').join('|') + '|'];
  const body = rows.map(([label, key, unit]) => `| ${label} | ` + engines.map((e) => (('error' in results[e]!) ? 'failed' : fmt((results[e] as Record<string, number>)[key], unit ?? 'ms'))).join(' | ') + ' |');
  console.log([...head, ...body].join('\n'));
  writeFileSync(path.join(tmpdir(), `homecast-bench-${scaleName}.json`), JSON.stringify(results, null, 2));
}

if (mode === 'seed') {
  const r = await seedDb(opt('engine') as EngineName, opt('dir')!);
  console.log('RESULT ' + JSON.stringify(r));
} else if (mode === 'run') {
  const r = await runDb(opt('engine') as EngineName, opt('dir')!);
  console.log('RESULT ' + JSON.stringify(r));
} else {
  await compare();
}
process.exit(0);
