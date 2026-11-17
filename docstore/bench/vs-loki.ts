/**
 * docstore against LokiJS on the same workload, each in its own process.
 *
 *   npm run bench -w docstore                        # 100,000 and 500,000 documents
 *   npx tsx bench/vs-loki.ts --sizes 200000
 *   npx tsx bench/vs-loki.ts one --engine docstore --n 100000      (one engine, one size, prints JSON)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Loki from 'lokijs';
import { Docstore } from '../src/index.js';

const args = process.argv.slice(2);
const mode = args[0] === 'one' ? 'one' : 'compare';
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};

interface Row {
  id: string;
  guid: string;
  podcastId: string;
  rev: number;
  title: string;
  body: string;
  n: number;
}

let seed = 99;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const BODY = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(18); // about 1 KB
const mb = (n: number) => Math.round(n / 1048576);
const make = (i: number, perPodcast: number): Row => ({ id: `id${i}`, guid: `g-${i}-${(rnd() * 1e9) | 0}`, podcastId: `p${Math.floor(i / perPodcast)}`, rev: i + 1, title: `Episode ${i}`, body: BODY, n: i % 100 });

async function time<T>(fn: () => T | Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
}

/** Longest the event loop was blocked while `fn` ran. */
async function stall(fn: () => Promise<unknown>): Promise<{ ms: number; maxStallMs: number }> {
  // A timer that wants to run every millisecond: the longest gap between runs is the longest the process was unresponsive.
  let last = performance.now();
  let max = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 1);
    last = now;
  }, 1);
  const t = performance.now();
  last = t;
  await fn();
  const ms = performance.now() - t;
  clearInterval(beat);
  max = Math.max(max, performance.now() - last - 1);
  return { ms, maxStallMs: max };
}

async function runOne(engine: 'loki' | 'docstore', n: number): Promise<Record<string, number | string>> {
  const dir = mkdtempSync(path.join(tmpdir(), `docstore-bench-${engine}-`));
  const perPodcast = 500;
  const out: Record<string, number | string> = {};
  global.gc?.();
  const heap0 = process.memoryUsage().heapUsed;

  // The two stores behind the same few functions, so the workload is identical.
  let insert!: (r: Row) => void;
  let byPodcast!: (p: string) => number;
  let tail!: (rev: number) => number;
  let newest!: (p: string) => number;
  let byGuid!: (g: string) => unknown;
  let getById!: (id: string) => Row | undefined;
  let update!: (r: Row) => void;
  let remove!: (r: Row) => void;
  let batch!: (fn: () => void) => void;
  let save!: () => Promise<void>;
  let close!: () => Promise<void>;
  let reopen!: () => Promise<number>;
  let file = '';

  if (engine === 'loki') {
    file = path.join(dir, 'db.json');
    const open = async () =>
      new Promise<{ db: Loki; col: Collection<Row> }>((resolve, reject) => {
        const db = new Loki(file, { adapter: new Loki.LokiFsAdapter(), autoload: false, autosave: false });
        db.loadDatabase({}, (err) => {
          if (err) return reject(err instanceof Error ? err : new Error(String(err)));
          const col = db.getCollection<Row>('rows') ?? db.addCollection<Row>('rows', { unique: ['id', 'guid'], indices: ['podcastId', 'rev'], clone: false });
          resolve({ db, col });
        });
      });
    const { db, col } = await open();
    insert = (r) => void col.insert(r);
    byPodcast = (p) => col.find({ podcastId: p }).length;
    tail = (rev) => col.find({ rev: { $gt: rev } }).length;
    newest = (p) => col.chain().find({ podcastId: p }).simplesort('rev', true).limit(20).data().length;
    byGuid = (g) => col.findOne({ guid: g });
    getById = (id) => col.by('id', id) as Row | undefined;
    update = (r) => void col.update(r as Row & LokiObj);
    remove = (r) => col.remove(r as Row & LokiObj);
    batch = (fn) => fn();
    save = () => new Promise((resolve, reject) => db.saveDatabase((e) => (e ? reject(e instanceof Error ? e : new Error(String(e))) : resolve())));
    close = async () => undefined;
    reopen = async () => {
      const [, ms] = await time(open);
      return ms;
    };
  } else {
    const opts = { autoCompact: false, fsyncIntervalMs: 0 };
    file = path.join(dir, 'store');
    let store = await Docstore.open(file, opts);
    const build = (s: Docstore) => s.collection<Row>('rows', { unique: ['guid'], indexed: ['podcastId'], ordered: ['rev'] });
    let col = build(store);
    insert = (r) => void col.insert(r);
    byPodcast = (p) => col.find({ podcastId: p }).length;
    tail = (rev) => col.find({ rev: { $gt: rev } }).length;
    newest = (p) => col.find({ podcastId: p }, { sort: { rev: -1 }, limit: 20 }).length;
    byGuid = (g) => col.findOne({ guid: g });
    getById = (id) => col.get(id);
    update = (r) => void col.update(r);
    remove = (r) => col.remove(r);
    batch = (fn) => store.batch(fn);
    save = async () => {
      await store.compact();
    };
    close = () => store.close();
    reopen = async () => {
      await store.close();
      const [s, ms] = await time(async () => {
        const s2 = await Docstore.open(file, opts);
        build(s2);
        return s2;
      });
      store = s;
      col = build(store);
      return ms;
    };
  }

  // Build
  const rows: Row[] = new Array<Row>(n);
  for (let i = 0; i < n; i++) rows[i] = make(i, perPodcast);
  const [, buildMs] = await time(() => batch(() => rows.forEach(insert)));
  out.insertPerSec = Math.round(n / (buildMs / 1000));
  out.buildMs = Math.round(buildMs);
  global.gc?.();
  out.heapMB = mb(process.memoryUsage().heapUsed - heap0);

  // Reads
  const pods = Math.ceil(n / perPodcast);
  const lookups = 5000;
  let [, ms] = await time(() => {
    for (let i = 0; i < lookups; i++) byPodcast(`p${Math.floor(rnd() * pods)}`);
  });
  out.byPodcastPerSec = Math.round(lookups / (ms / 1000));
  [, ms] = await time(() => {
    for (let i = 0; i < lookups; i++) tail(n - 50);
  });
  out.tailPerSec = Math.round(lookups / (ms / 1000));
  [, ms] = await time(() => {
    for (let i = 0; i < 2000; i++) newest(`p${Math.floor(rnd() * pods)}`);
  });
  out.newestPerSec = Math.round(2000 / (ms / 1000));
  [, ms] = await time(() => {
    for (let i = 0; i < 50_000; i++) byGuid(rows[Math.floor(rnd() * n)]!.guid);
  });
  out.byGuidPerSec = Math.round(50_000 / (ms / 1000));
  [, ms] = await time(() => {
    for (let i = 0; i < 200_000; i++) getById(`id${Math.floor(rnd() * n)}`);
  });
  out.byIdPerSec = Math.round(200_000 / (ms / 1000));

  // Writes to documents that are already there, then deletes and inserts at the end
  const updates = Math.min(n, 100_000);
  [, ms] = await time(() => {
    for (let i = 0; i < updates; i++) {
      const r = getById(`id${Math.floor(rnd() * n)}`)!;
      r.rev = n + i + 1;
      r.n++;
      update(r);
    }
  });
  out.updatePerSec = Math.round(updates / (ms / 1000));
  [, ms] = await time(() => {
    for (let i = 0; i < 20_000; i++) remove(getById(`id${i}`)!);
    for (let i = 0; i < 20_000; i++) insert({ ...make(n + i, perPodcast), id: `new${i}` });
  });
  out.deleteInsertPerSec = Math.round(40_000 / (ms / 1000));

  // Saving: Loki writes the whole database; docstore appends as it goes and snapshots in slices
  let s = await stall(save);
  out.saveMs = Math.round(s.ms);
  out.saveStallMs = Math.round(s.maxStallMs);
  try {
    const st = statSync(file);
    out.diskMB = mb(st.isDirectory() ? readdirSync(file).reduce((n, f) => n + statSync(path.join(file, f)).size, 0) : st.size);
  } catch {
    out.diskMB = 0;
  }
  await close();
  out.openMs = Math.round(await reopen());
  await close();
  rmSync(dir, { recursive: true, force: true });
  void s;
  return out;
}

if (mode === 'one') {
  const r = await runOne(opt('engine', 'docstore') as 'loki' | 'docstore', Number(opt('n', '100000')));
  console.log('RESULT ' + JSON.stringify(r));
  process.exit(0);
}

const sizes = opt('sizes', '100000,500000').split(',').map(Number);
const labels: [string, string, string][] = [
  ['Insert 1 KB documents (per second, one batch)', 'insertPerSec', '/s'],
  ['Memory held by the data', 'heapMB', 'MB'],
  ['Indexed lookup, about 500 documents (per second)', 'byPodcastPerSec', '/s'],
  ['Range lookup, newest 50 (per second)', 'tailPerSec', '/s'],
  ['Newest 20 of a podcast of about 500 (per second)', 'newestPerSec', '/s'],
  ['Unique field lookup (per second)', 'byGuidPerSec', '/s'],
  ['Get by id (per second)', 'byIdPerSec', '/s'],
  ['Update a document (per second)', 'updatePerSec', '/s'],
  ['Delete and insert (per second)', 'deleteInsertPerSec', '/s'],
  ['Save the whole database', 'saveMs', 'ms'],
  ['Save: longest stall of the process', 'saveStallMs', 'ms'],
  ['Open from disk', 'openMs', 'ms'],
  ['On disk', 'diskMB', 'MB'],
];
for (const n of sizes) {
  const res: Record<string, Record<string, number | string> | { error: string }> = {};
  for (const engine of ['loki', 'docstore'] as const) {
    process.stderr.write(`[${engine}] ${n.toLocaleString('en-US')} documents…\n`);
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--expose-gc', '--max-old-space-size=8192', '--no-warnings', fileURLToPath(import.meta.url), 'one', '--engine', engine, '--n', String(n)], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const line = r.stdout.split('\n').reverse().find((l) => l.startsWith('RESULT '));
    res[engine] = r.status === 0 && line ? (JSON.parse(line.slice(7)) as Record<string, number>) : { error: (r.stderr || r.stdout).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200) };
  }
  console.log(`\n${n.toLocaleString('en-US')} documents\n`);
  console.log('| | loki | docstore |\n|---|---:|---:|');
  const cell = (e: 'loki' | 'docstore', key: string, unit: string) => {
    const r = res[e]!;
    if ('error' in r) return 'failed';
    const v = Number(r[key]);
    return `${v.toLocaleString('en-US')} ${unit}`;
  };
  for (const [label, key, unit] of labels) console.log(`| ${label} | ${cell('loki', key, unit)} | ${cell('docstore', key, unit)} |`);
  for (const e of ['loki', 'docstore'] as const) if ('error' in res[e]!) console.log(`\n${e} failed: ${(res[e] as { error: string }).error}`);
}
