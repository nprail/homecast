import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import Loki from 'lokijs';
import type { Backend, Query, Repo } from './repo.js';
import { uuid } from '../util/misc.js';

/** The whole database lives in memory as plain objects; the file is a JSON dump written every few seconds. */
class LokiRepo<T extends { id: string }> implements Repo<T> {
  constructor(
    readonly col: Collection<T>,
    private readonly nextRev: (() => number) | null,
  ) {}

  insert(doc: Omit<T, 'id'> & { id?: string }): T {
    const full = { ...doc, id: doc.id ?? uuid() } as T & { rev?: number };
    if (this.nextRev) full.rev = this.nextRev();
    return this.col.insert(full as T) as T;
  }
  insertRaw(doc: T): void {
    this.col.insert({ ...doc });
  }
  save(doc: T): T {
    if (this.nextRev) (doc as T & { rev?: number }).rev = this.nextRev();
    return this.col.update(doc as T & LokiObj) as T;
  }
  saveQuiet(doc: T): T {
    return this.col.update(doc as T & LokiObj) as T;
  }
  get(id: string): T | null {
    return (this.col.by('id', id) as T | undefined) ?? null;
  }
  /**
   * `{ field: { $in: [a, b] } }` becomes one indexed lookup per value. Loki's own `$in` ignores its indexes and scans
   * the collection, so the in-memory engine does the cheaper thing itself.
   */
  private expand(q: Query<T>): Query<T>[] {
    const key = Object.keys(q).find((k) => {
      const v = (q as Record<string, unknown>)[k];
      return typeof v === 'object' && v !== null && '$in' in v;
    });
    if (!key) return [q];
    const { [key]: values, ...rest } = q as Record<string, { $in: string[] }>;
    return values!.$in.flatMap((v) => this.expand({ ...rest, [key]: v } as Query<T>));
  }
  findOne(q: Query<T>): T | null {
    for (const one of this.expand(q)) {
      const hit = this.col.findOne(one as LokiQuery<T & LokiObj>) as T | null;
      if (hit) return hit;
    }
    return null;
  }
  find(q?: Query<T>): T[] {
    if (!q) return this.col.find() as T[];
    const parts = this.expand(q);
    return (parts.length === 1 ? this.col.find(parts[0] as LokiQuery<T & LokiObj>) : parts.flatMap((one) => this.col.find(one as LokiQuery<T & LokiObj>))) as T[];
  }
  where(fn: (d: T) => boolean): T[] {
    return this.col.where(fn as unknown as (d: T) => boolean) as T[];
  }
  count(q?: Query<T>): number {
    return q ? this.expand(q).reduce((n, one) => n + this.col.count(one as LokiQuery<T & LokiObj>), 0) : this.col.count();
  }
  remove(doc: T): void {
    this.col.remove(doc as T & LokiObj);
  }
  removeWhere(fn: (d: T) => boolean): number {
    const docs = this.where(fn);
    for (const d of docs) this.col.remove(d as T & LokiObj);
    return docs.length;
  }
}

interface Meta {
  id: string;
  rev: number;
  horizon?: number;
}

export class LokiBackend implements Backend {
  readonly kind = 'loki' as const;
  private meta: Collection<Meta>;
  private metaDoc: Meta & LokiObj;
  private readonly names_: string[] = [];

  private constructor(
    readonly loki: Loki,
    readonly file: string,
  ) {
    this.meta = this.collection<Meta>('meta', []);
    this.metaDoc = (this.meta.findOne({ id: 'rev' }) as (Meta & LokiObj) | null) ?? (this.meta.insert({ id: 'rev', rev: 0 }) as Meta & LokiObj);
  }

  static async open(opts: { dataDir: string; memory?: boolean; autosaveMs?: number }): Promise<LokiBackend> {
    const file = path.join(opts.dataDir, 'homecast.db.json');
    mkdirSync(opts.dataDir, { recursive: true });
    // Data directories created before the rename (when the project was called Podcast Sync).
    const legacy = path.join(opts.dataDir, 'podsync.db.json');
    if (!opts.memory && !existsSync(file) && existsSync(legacy)) renameSync(legacy, file);
    const loki = await new Promise<Loki>((resolve, reject) => {
      const db: Loki = new Loki(file, {
        adapter: opts.memory ? new Loki.LokiMemoryAdapter() : new Loki.LokiFsAdapter(),
        autoload: false,
        autosave: !opts.memory,
        autosaveInterval: opts.autosaveMs ?? 5000,
        serializationMethod: 'normal',
      });
      db.loadDatabase({}, (err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(db)));
    });
    return new LokiBackend(loki, file);
  }

  private collection<T extends { id: string }>(name: string, unique: string[], indices: string[] = []): Collection<T> {
    return (this.loki.getCollection<T>(name) ??
      this.loki.addCollection<T>(name, { unique: ['id', ...unique] as never, indices: indices as never, clone: false })) as Collection<T>;
  }

  repo<T extends { id: string }>(name: string, unique: string[], indices: string[], nextRev: (() => number) | null, _compound: string[][] = []): Repo<T> {
    if (name !== 'meta') this.names_.push(name);
    return new LokiRepo(this.collection<T>(name, unique, indices), nextRev);
  }

  names(): string[] {
    return this.names_;
  }

  bumpRev(): number {
    this.metaDoc.rev += 1;
    this.meta.update(this.metaDoc);
    return this.metaDoc.rev;
  }
  get currentRev(): number {
    return this.metaDoc.rev;
  }
  get horizon(): number {
    return this.metaDoc.horizon ?? 0;
  }
  raiseHorizon(rev: number): void {
    if (rev > this.horizon) {
      this.metaDoc.horizon = rev;
      this.meta.update(this.metaDoc);
    }
  }
  setRevState(rev: number, horizon: number): void {
    this.metaDoc.rev = rev;
    this.metaDoc.horizon = horizon;
    this.meta.update(this.metaDoc);
  }

  /** Memory-resident, so there is nothing to group. */
  batch<R>(fn: () => R): R {
    return fn();
  }

  save(): Promise<void> {
    return new Promise((resolve, reject) => this.loki.saveDatabase((err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve())));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.loki.close(() => resolve()));
  }

  fileSize(): number {
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  snapshot(dataDir: string, keep: number): { file: string; bytes: number; kept: number } {
    const dir = path.join(dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, `homecast-${stampNow()}.json`);
    const tmp = `${final}.tmp`;
    const data = this.loki.serialize();
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, final);
    return { file: final, bytes: Buffer.byteLength(data), kept: pruneBackups(dataDir, keep) };
  }
}

export const stampNow = (): string => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

export function listBackupFiles(dataDir: string): { name: string; bytes: number; mtime: number }[] {
  const dir = path.join(dataDir, 'backups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^(homecast|podsync)-.*\.(json|sqlite)$/.test(n))
    .map((name) => {
      const st = statSync(path.join(dir, name));
      return { name, bytes: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
}

/** Delete all but the newest `keep` snapshots; returns how many remain. */
export function pruneBackups(dataDir: string, keep: number): number {
  const files = listBackupFiles(dataDir);
  for (const old of files.slice(keep)) {
    try {
      unlinkSync(path.join(dataDir, 'backups', old.name));
    } catch {
      /* ignore */
    }
  }
  return Math.min(files.length, keep);
}
