import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyDatabase, Database, ENGINES, type EngineName } from '../src/db/index.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'homecast-db-'));
const user = (name: string, extra: Record<string, unknown> = {}) =>
  ({ username: name, usernameKey: name.toLowerCase(), passwordHash: 'x', role: 'user', createdAt: 1, disabled: false, lastActiveAt: null, ...extra }) as never;

describe.each(ENGINES)('%s engine', (engine: EngineName) => {
  const open = (dataDir = tmp(), memory = false) => Database.open({ dataDir, memory, engine, autosaveMs: 0 });

  it('inserts, reads back, queries by equality and counts', async () => {
    const db = await open(undefined, true);
    const maya = db.users.insert(user('Maya'));
    db.users.insert(user('Eli', { role: 'admin', disabled: true }));
    expect(db.users.get(maya.id)).toMatchObject({ username: 'Maya' });
    expect(db.users.findOne({ usernameKey: 'maya' })?.id).toBe(maya.id);
    expect(db.users.find({ role: 'admin' })).toHaveLength(1);
    expect(db.users.find({ disabled: true, role: 'admin' })).toHaveLength(1);
    expect(db.users.find({ disabled: false, role: 'admin' })).toHaveLength(0);
    expect(db.users.find({ lastActiveAt: null })).toHaveLength(2);
    expect(db.users.count()).toBe(2);
    expect(db.users.count({ role: 'user' })).toBe(1);
    expect(db.users.findOne({ usernameKey: 'nobody' })).toBeNull();
    expect(db.users.get('missing')).toBeNull();
    expect(db.users.where((u) => u.username.startsWith('E'))).toHaveLength(1);
    await db.close();
  });

  it('finds documents changed after a revision, using greater-than on an indexed number', async () => {
    const db = await open(undefined, true);
    const a = db.episodes.insert({ podcastId: 'p1', guid: 'a', title: 'A', createdAt: 100 } as never);
    const b = db.episodes.insert({ podcastId: 'p1', guid: 'b', title: 'B', createdAt: 200 } as never);
    db.episodes.insert({ podcastId: 'p2', guid: 'c', title: 'C', createdAt: 300 } as never);
    expect(db.episodes.find({ podcastId: 'p1', rev: { $gt: a.rev! } }).map((e) => e.guid)).toEqual(['b']);
    expect(db.episodes.find({ rev: { $gt: b.rev! } }).map((e) => e.guid)).toEqual(['c']);
    expect(db.episodes.find({ rev: { $gt: 0 } })).toHaveLength(3);
    expect(db.episodes.count({ createdAt: { $gt: 150 } })).toBe(2);
    b.title = 'B2';
    db.episodes.save(b); // a changed document moves to the newest rev
    expect(db.episodes.find({ rev: { $gt: a.rev! + 1 } }).map((e) => e.guid).sort()).toEqual(['b', 'c']);
    await db.close();
  });

  it('finds documents matching any of several values in one query', async () => {
    const db = await open(undefined, true);
    const a = db.episodes.insert({ podcastId: 'p1', guid: 'a', title: 'A' } as never);
    db.episodes.insert({ podcastId: 'p2', guid: 'b', title: 'B' } as never);
    db.episodes.insert({ podcastId: 'p3', guid: 'c', title: 'C' } as never);
    expect(db.episodes.find({ podcastId: { $in: ['p1', 'p3'] } }).map((e) => e.guid).sort()).toEqual(['a', 'c']);
    expect(db.episodes.find({ podcastId: { $in: ['p1', 'p2', 'p3'] }, rev: { $gt: a.rev! } }).map((e) => e.guid).sort()).toEqual(['b', 'c']);
    expect(db.episodes.find({ podcastId: { $in: [] } })).toEqual([]);
    expect(db.episodes.find({ id: { $in: [a.id, 'nope'] } }).map((e) => e.guid)).toEqual(['a']);
    await db.close();
  });

  it('enforces unique fields', async () => {
    const db = await open(undefined, true);
    db.users.insert(user('Maya'));
    expect(() => db.users.insert(user('maya'))).toThrow();
    await db.close();
  });

  it('saves changes, removes documents and bumps rev only on synced collections', async () => {
    const db = await open(undefined, true);
    const p = db.podcasts.insert({ feedUrl: 'http://x/f', title: 'A' } as never);
    const first = p.rev!;
    p.title = 'B';
    db.podcasts.save(p);
    expect(p.rev).toBeGreaterThan(first);
    expect(db.podcasts.get(p.id)!.title).toBe('B');
    const rev = p.rev!;
    db.podcasts.saveQuiet(p);
    expect(p.rev).toBe(rev); // quiet saves leave rev alone
    const u = db.users.insert(user('Maya'));
    expect((u as { rev?: number }).rev).toBeUndefined();
    db.users.remove(u);
    expect(db.users.get(u.id)).toBeNull();
    expect(db.users.insert(user('A1')) && db.users.insert(user('A2')) && db.users.removeWhere((x) => x.username.startsWith('A'))).toBe(2);
    expect(db.users.count()).toBe(0);
    await db.close();
  });

  it('hands out the same object while something holds it, so a long job never overwrites newer changes with a stale copy', async () => {
    const db = await open(undefined, true);
    const job = db.jobs.insert({ type: 'transcript', episodeId: 'e', status: 'queued', attachedUsers: ['a'] } as never);
    const other = db.jobs.find({ episodeId: 'e' })[0]!;
    other.attachedUsers.push('b');
    db.jobs.saveQuiet(other);
    job.status = 'running' as never;
    db.jobs.saveQuiet(job); // the holder saves its own (current) copy
    expect(db.jobs.get(job.id)!.attachedUsers).toEqual(['a', 'b']);
    await db.close();
  });

  it('keeps data across a restart, including the revision counter', async () => {
    const dir = tmp();
    const db = await open(dir);
    const p = db.podcasts.insert({ feedUrl: 'http://x/f', title: 'A' } as never);
    db.raiseHorizon(5);
    const rev = db.currentRev;
    await db.save();
    await db.close();
    const again = await open(dir);
    expect(again.podcasts.get(p.id)).toMatchObject({ title: 'A', rev: p.rev });
    expect(again.currentRev).toBe(rev);
    expect(again.horizon).toBe(5);
    expect(again.podcasts.insert({ feedUrl: 'http://x/g', title: 'B' } as never).rev).toBe(rev + 1);
    expect(again.fileSize()).toBeGreaterThan(0);
    await again.close();
  });

  it('writes a backup that can be opened as a database, and keeps only the newest ones', async () => {
    const dir = tmp();
    const db = await open(dir);
    db.users.insert(user('Maya'));
    const snap = db.snapshot(dir, 2);
    expect(existsSync(snap.file)).toBe(true);
    expect(snap.bytes).toBeGreaterThan(0);
    expect(db.listBackups(dir).length).toBe(1);
    if (engine === 'sqlite') {
      const { DatabaseSync } = await import('node:sqlite');
      const copy = new DatabaseSync(snap.file, { readOnly: true });
      expect((copy.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
      copy.close();
    }
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1100)); // snapshot names carry the second
      db.snapshot(dir, 2);
    }
    expect(readdirSync(path.join(dir, 'backups')).filter((n) => !n.endsWith('.tmp'))).toHaveLength(2);
    await db.close();
  }, 15_000);

  it('ignores writes and finds nothing once closed, instead of throwing in background tasks', async () => {
    const db = await open(undefined, true);
    const u = db.users.insert(user('Maya'));
    await db.close();
    expect(() => db.users.save(u)).not.toThrow();
    expect(() => db.users.insert(user('Eli'))).not.toThrow();
    expect(db.users.find({ role: 'user' })).toEqual(expect.any(Array));
  });
});

describe('moving between engines', () => {
  it('copies everything from one engine to the other, in both directions', async () => {
    const lokiDir = tmp();
    const loki = await Database.open({ dataDir: lokiDir, engine: 'loki', autosaveMs: 0 });
    const maya = loki.users.insert(user('Maya'));
    const pod = loki.podcasts.insert({ feedUrl: 'http://x/f', title: 'A' } as never);
    loki.episodes.insert({ podcastId: pod.id, guid: 'g', title: 'E' } as never);
    loki.raiseHorizon(3);

    const sqlite = await Database.open({ dataDir: tmp(), memory: true, engine: 'sqlite' });
    expect(copyDatabase(loki, sqlite)).toBe(3);
    expect(sqlite.users.get(maya.id)).toMatchObject({ username: 'Maya' });
    expect(sqlite.episodes.find({ podcastId: pod.id })).toHaveLength(1);
    expect(sqlite.currentRev).toBe(loki.currentRev);
    expect(sqlite.horizon).toBe(3);

    const back = await Database.open({ dataDir: tmp(), memory: true, engine: 'loki' });
    expect(copyDatabase(sqlite, back)).toBe(3);
    expect(back.podcasts.get(pod.id)).toMatchObject({ title: 'A', rev: pod.rev });
    await loki.close();
    await sqlite.close();
    await back.close();
  });

  it('imports an existing JSON database the first time the server starts on SQLite, and leaves the JSON alone', async () => {
    const dir = tmp();
    const loki = await Database.open({ dataDir: dir, engine: 'loki', autosaveMs: 0 });
    const maya = loki.users.insert(user('Maya'));
    await loki.save();
    await loki.close();
    const sqlite = await Database.open({ dataDir: dir, engine: 'sqlite' });
    expect(sqlite.users.get(maya.id)).toMatchObject({ username: 'Maya' });
    await sqlite.close();
    expect(existsSync(path.join(dir, 'homecast.db.json'))).toBe(true);
    // Starting again must not import a second time (the JSON is stale now).
    const second = await Database.open({ dataDir: dir, engine: 'sqlite' });
    expect(second.users.count()).toBe(1);
    await second.close();
  });
});
