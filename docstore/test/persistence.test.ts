import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CorruptionError, Docstore, LockedError, UniqueViolation } from '../src/index.js';
import { encode } from '../src/log.js';

interface Item {
  id: string;
  name: string;
  n?: number;
  body?: string;
}
const dir = () => mkdtempSync(path.join(tmpdir(), 'docstore-'));
const OPTS = { name: 'items' } as const;
const open = (d: string, o: Parameters<typeof Docstore.open>[1] = {}) => Docstore.open(d, { autoCompact: false, ...o });
const items = (s: Docstore) => s.collection<Item>(OPTS.name, { unique: ['name'], ordered: ['n'] });
const journal = (d: string) => path.join(d, readdirSync(d).filter((f) => f.startsWith('wal-')).sort().pop()!);
const tick = () => new Promise<void>((r) => setImmediate(r));
const state = (c: { find: () => Item[] }) => JSON.stringify(c.find().map((d) => ({ id: d.id, name: d.name, n: d.n })).sort((a, b) => (a.id < b.id ? -1 : 1)));

describe('persistence', () => {
  it('keeps inserts, updates and deletes across a restart, with working indexes', async () => {
    const d = dir();
    let s = await open(d);
    let col = items(s);
    const a = col.insert({ id: 'a', name: 'alpha', n: 1 });
    col.insert({ id: 'b', name: 'beta', n: 2 });
    col.insert({ id: 'c', name: 'gamma', n: 3 });
    a.n = 10;
    col.update(a);
    col.remove('b');
    await s.close();

    s = await open(d);
    col = items(s);
    expect(col.size).toBe(2);
    expect(col.get('a')!.n).toBe(10);
    expect(col.get('b')).toBeUndefined();
    expect(col.find({ n: { $gt: 5 } }).map((x) => x.id)).toEqual(['a']);
    expect(() => col.insert({ name: 'alpha' })).toThrow(UniqueViolation);
    col.insert({ id: 'd', name: 'delta', n: 4 }); // and keeps working
    await s.close();
    s = await open(d);
    expect(items(s).size).toBe(3);
    await s.close();
  });

  it('survives a crash: everything that reached the journal is there', async () => {
    const d = dir();
    const s = await open(d, { lock: false });
    const col = items(s);
    for (let i = 0; i < 50; i++) col.insert({ id: `i${i}`, name: `n${i}`, n: i });
    s.flushSync(); // this is the part a crash cannot undo; nothing is closed
    const again = await open(d, { lock: false });
    expect(items(again).size).toBe(50);
    await again.close();
  });

  it('ignores a half-written last record and carries on writing after it', async () => {
    const d = dir();
    let s = await open(d);
    let col = items(s);
    col.insert({ id: 'a', name: 'alpha' });
    col.insert({ id: 'b', name: 'beta' });
    await s.close();
    appendFileSync(journal(d), '1234abcd P 0 {"id":"c","na'); // cut off in the middle of a write
    s = await open(d);
    col = items(s);
    expect(col.size).toBe(2);
    col.insert({ id: 'c', name: 'gamma' });
    await s.close();
    s = await open(d);
    expect(items(s).size).toBe(3);
    await s.close();
  });

  it('ignores a damaged last record but refuses damage anywhere else', async () => {
    const d = dir();
    let s = await open(d);
    let col = items(s);
    for (const id of ['a', 'b', 'c']) col.insert({ id, name: id });
    await s.close();
    const j = journal(d);
    const text = readFileSync(j, 'utf8');
    // Damage the last record: tolerated.
    writeFileSync(j, text.replace(/\n$/, '').slice(0, -3) + 'XYZ\n');
    s = await open(d);
    expect(items(s).size).toBe(2);
    await s.close();
    // Damage a record in the middle: an error, and the data is left alone.
    const lines = readFileSync(journal(d), 'utf8').split('\n');
    lines[0] = lines[0]!.replace('"a"', '"z"');
    writeFileSync(journal(d), lines.join('\n'));
    await expect(open(d)).rejects.toThrow(CorruptionError);
  });

  it('drops a batch that did not finish, without swallowing what is written after it', async () => {
    const d = dir();
    let s = await open(d);
    let col = items(s);
    col.insert({ id: 'a', name: 'alpha' });
    await s.close();
    // A crash in the middle of a batch: its marker and one record, no end marker.
    appendFileSync(journal(d), encode('B') + encode('P 0 {"id":"x","name":"half"}'));
    s = await open(d);
    col = items(s);
    expect(col.get('x')).toBeUndefined();
    col.insert({ id: 'b', name: 'beta' });
    await s.close();
    s = await open(d);
    col = items(s);
    expect(col.size).toBe(2);
    expect(col.get('b')).toBeDefined();
    await s.close();
  });

  it('writes a batch as one group, and large batches in several', async () => {
    const d = dir();
    let s = await open(d);
    let col = items(s);
    const big = 'x'.repeat(100_000);
    s.batch(() => {
      for (let i = 0; i < 150; i++) col.insert({ id: `i${i}`, name: `n${i}`, body: big }); // ~15 MB
    });
    await s.close();
    s = await open(d);
    col = items(s);
    expect(col.size).toBe(150);
    expect(col.get('i149')!.body).toHaveLength(100_000);
    // The group markers are in the file.
    expect(readFileSync(journal(d), 'utf8').match(/ B\n/g)!.length).toBeGreaterThanOrEqual(2);
    await s.close();
  });

  it('stores awkward text and very large documents', async () => {
    const d = dir();
    let s = await open(d);
    let col = items(s);
    const weird = 'line1\nline2\r\n  tab\t "quotes" \\ back\u0000nul 😀 日本語';
    col.insert({ id: 'w', name: weird });
    col.insert({ id: 'huge', name: 'huge', body: 'y'.repeat(6 << 20) }); // bigger than the read buffer's first size
    await s.close();
    s = await open(d);
    col = items(s);
    expect(col.get('w')!.name).toBe(weird);
    expect(col.get('huge')!.body).toHaveLength(6 << 20);
    await s.close();
  });

  it('folds the journal into a snapshot without losing anything', async () => {
    const d = dir();
    let s = await open(d);
    let col = items(s);
    for (let i = 0; i < 2000; i++) col.insert({ id: `i${i}`, name: `n${i}`, n: i });
    for (let i = 0; i < 2000; i += 2) col.remove(`i${i}`);
    for (let i = 1; i < 2000; i += 4) {
      const x = col.get(`i${i}`)!;
      x.n = -i;
      col.update(x);
    }
    const before = state(col);
    await s.compact();
    expect(s.stats().journalBytes).toBe(0);
    expect(readdirSync(d).filter((f) => f.startsWith('snap-'))).toHaveLength(1);
    expect(readdirSync(d).filter((f) => f.startsWith('wal-'))).toHaveLength(1);
    expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    col.insert({ id: 'after', name: 'after' }); // goes to the new journal
    await s.close();
    s = await open(d);
    col = items(s);
    col.remove('after');
    expect(state(col)).toBe(before);
    await s.close();
  });

  it('keeps accepting writes while a snapshot is being written, and none are lost or doubled', async () => {
    const d = dir();
    let s = await open(d);
    let col = items(s);
    const body = 'z'.repeat(1500);
    for (let i = 0; i < 6000; i++) col.insert({ id: `i${i}`, name: `n${i}`, n: i, body }); // ~9 MB: several slices
    const done = s.compact();
    // Changes of every kind while it runs, one per turn of the event loop.
    for (let i = 0; i < 60; i++) {
      await tick();
      col.insert({ id: `new${i}`, name: `new${i}`, n: 10_000 + i });
      const old = col.get(`i${i * 3}`);
      if (old) col.remove(old);
      const upd = col.get(`i${i * 3 + 1}`)!;
      upd.n = -1;
      col.update(upd);
    }
    await done;
    const before = state(col);
    await s.close();
    s = await open(d);
    expect(state(items(s))).toBe(before);
    await s.close();
  });

  it('recovers from a crash in the middle of a snapshot', async () => {
    const d = dir();
    const s = await open(d, { lock: false });
    const col = items(s);
    const body = 'q'.repeat(1500);
    for (let i = 0; i < 4000; i++) col.insert({ id: `i${i}`, name: `n${i}`, n: i, body });
    const before = state(col);
    const done = s.compact(); // starts, writes the first slice, then waits
    // The disk right now: a half-written snapshot, and a manifest naming the old and the new journal.
    s.flushSync();
    const crashed = dir();
    for (const f of readdirSync(d)) if (f !== 'LOCK') copyFileSync(path.join(d, f), path.join(crashed, f));
    expect(readdirSync(crashed).some((f) => f.endsWith('.tmp'))).toBe(true);
    await done;
    await s.close();
    const recovered = await open(crashed);
    expect(state(items(recovered))).toBe(before);
    expect(readdirSync(crashed).some((f) => f.endsWith('.tmp'))).toBe(false);
    await recovered.close();
  });

  it('compacts by itself when the journal grows, and keeps the data', async () => {
    const d = dir();
    let s = await Docstore.open(d, { compactAtBytes: 200_000, flushIntervalMs: 5 });
    let col = items(s);
    for (let i = 0; i < 3000; i++) col.insert({ id: `i${i}`, name: `n${i}`, n: i, body: 'w'.repeat(200) });
    // Wait for the background flush and snapshot.
    for (let i = 0; i < 200 && s.stats().snapshotBytes === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.stats().snapshotBytes).toBeGreaterThan(0);
    const before = state(col);
    await s.close();
    s = await Docstore.open(d, { autoCompact: false });
    col = items(s);
    expect(state(col)).toBe(before);
    await s.close();
  });

  it('keeps collections the program no longer asks for', async () => {
    const d = dir();
    let s = await open(d);
    s.collection<Item>('old').insert({ id: 'o', name: 'kept' });
    items(s).insert({ id: 'a', name: 'a' });
    await s.close();
    s = await open(d);
    items(s); // 'old' is not registered this time
    await s.compact();
    await s.close();
    s = await open(d);
    expect(s.collection<Item>('old').get('o')!.name).toBe('kept');
    await s.close();
  });

  it('refuses a second opener, and takes over a lock left by a dead process', async () => {
    const d = dir();
    const s = await Docstore.open(d);
    await expect(Docstore.open(d)).rejects.toThrow(LockedError);
    await s.close();
    const again = await Docstore.open(d);
    await again.close();
    writeFileSync(path.join(d, 'LOCK'), '2147483646'); // no such process
    const taken = await Docstore.open(d);
    await taken.close();
    expect(existsSync(path.join(d, 'LOCK'))).toBe(false);
  });

  it('strict durability has every change on disk before the call returns', async () => {
    const d = dir();
    const s = await open(d, { durability: 'strict', lock: false });
    items(s).insert({ id: 'a', name: 'a' });
    s.batch(() => {
      items(s).insert({ id: 'b', name: 'b' });
      items(s).insert({ id: 'c', name: 'c' });
    });
    const other = await open(d, { lock: false }); // reads the files as they are right now
    expect(items(other).size).toBe(3);
    await other.close();
    await s.close();
  });

  it('exports everything to one file that restores into a new store', async () => {
    const d = dir();
    const s = await open(d);
    const col = items(s);
    for (let i = 0; i < 500; i++) col.insert({ id: `i${i}`, name: `n${i}`, n: i });
    await s.compact();
    for (let i = 0; i < 100; i++) col.remove(`i${i}`);
    col.insert({ id: 'late', name: 'late' }); // still only in the buffer
    const file = path.join(dir(), 'backup.docstore');
    const bytes = s.exportSync(file);
    expect(statSync(file).size).toBe(bytes);
    const before = state(col);
    await s.close();
    const target = path.join(dir(), 'restored');
    Docstore.restore(file, target);
    const r = await open(target);
    expect(state(items(r))).toBe(before);
    expect(() => Docstore.restore(file, target)).toThrow(/already holds a store/);
    await r.close();
  });

  it('works as a plain in-memory store too', async () => {
    const s = await Docstore.open(null);
    const col = items(s);
    s.batch(() => col.insert({ id: 'a', name: 'a' }));
    await s.flush();
    await s.compact();
    expect(col.size).toBe(1);
    const file = path.join(dir(), 'mem.docstore');
    s.exportSync(file);
    await s.close();
    const target = path.join(dir(), 'from-memory');
    Docstore.restore(file, target);
    const r = await open(target);
    expect(items(r).get('a')!.name).toBe('a');
    await r.close();
  });

  it('opens a large store quickly and holds the right number of documents', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'docstore-big-'));
    mkdirSync(d, { recursive: true });
    let s = await open(d);
    let col = items(s);
    s.batch(() => {
      for (let i = 0; i < 60_000; i++) col.insert({ id: `i${i}`, name: `n${i}`, n: i % 1000, body: 'b'.repeat(300) });
    });
    await s.compact();
    await s.close();
    s = await open(d);
    col = items(s);
    expect(col.size).toBe(60_000);
    expect(col.count({ n: { $gte: 990 } })).toBe(600);
    await s.close();
  });
});
