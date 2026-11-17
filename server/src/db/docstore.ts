import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Docstore, type Collection } from '@homecast/docstore';
import { listBackupFiles, pruneBackups, stampNow } from './loki.js';
import type { Backend, Query, Repo } from './repo.js';
import { uuid } from '../util/misc.js';

/** The store's own query operators are a superset of ours, so a query passes through unchanged. */
class DocstoreRepo<T extends { id: string }> implements Repo<T> {
  constructor(
    private readonly col: Collection<T>,
    private readonly nextRev: (() => number) | null,
  ) {}

  insert(doc: Omit<T, 'id'> & { id?: string }): T {
    const full = { ...doc, id: doc.id ?? uuid() } as T & { rev?: number };
    if (this.nextRev) full.rev = this.nextRev();
    return this.col.insert(full);
  }
  insertRaw(doc: T): void {
    this.col.insert({ ...doc });
  }
  save(doc: T): T {
    if (this.nextRev) (doc as T & { rev?: number }).rev = this.nextRev();
    return this.col.update(doc);
  }
  saveQuiet(doc: T): T {
    return this.col.update(doc);
  }
  get(id: string): T | null {
    return this.col.get(id) ?? null;
  }
  findOne(q: Query<T>): T | null {
    return this.col.findOne(q);
  }
  find(q?: Query<T>): T[] {
    return this.col.find(q);
  }
  where(fn: (d: T) => boolean): T[] {
    return this.col.where(fn);
  }
  count(q?: Query<T>): number {
    return this.col.count(q);
  }
  remove(doc: T): void {
    this.col.remove(doc);
  }
  removeWhere(fn: (d: T) => boolean): number {
    return this.col.removeWhere(fn);
  }
}

interface Meta {
  id: string;
  rev: number;
  horizon: number;
}

/** Numbers that are queried as ranges ("changed since"), so they get a sorted index. */
const ORDERED = new Set(['rev', 'createdAt', 'at']);
/** How many revision bumps are held in memory before the counter is written to the journal. */
const REV_FLUSH_EVERY = 200;

/**
 * The server's own storage engine: documents in memory with indexes, changes appended to a journal, and a snapshot
 * written in small slices in the background (see the `docstore` package).
 */
export class DocstoreBackend implements Backend {
  readonly kind = 'docstore' as const;
  readonly file: string;
  private meta: Collection<Meta>;
  private metaDoc: Meta;
  private rev = 0;
  private persistedRev = 0;
  private revReady = false;
  private readonly synced: Collection<{ id: string }>[] = [];
  private readonly names_: string[] = [];

  private constructor(
    private readonly store: Docstore,
    dir: string | null,
  ) {
    this.file = dir ?? ':memory:';
    this.meta = store.collection<Meta>('meta');
    this.metaDoc = this.meta.get('rev') ?? this.meta.insert({ id: 'rev', rev: 0, horizon: 0 });
    this.persistedRev = this.rev = this.metaDoc.rev;
  }

  static async open(opts: { dataDir: string; memory?: boolean }): Promise<DocstoreBackend> {
    const dir = opts.memory ? null : path.join(opts.dataDir, 'homecast.docstore');
    return new DocstoreBackend(await Docstore.open(dir), dir);
  }

  repo<T extends { id: string }>(name: string, unique: string[], indices: string[], nextRev: (() => number) | null, _compound: string[][] = []): Repo<T> {
    this.names_.push(name);
    const col = this.store.collection<T>(name, {
      unique: unique.filter((f) => f !== 'id'),
      indexed: indices.filter((f) => !ORDERED.has(f)),
      ordered: indices.filter((f) => ORDERED.has(f)),
    });
    if (nextRev) this.synced.push(col as unknown as Collection<{ id: string }>);
    return new DocstoreRepo<T>(col, nextRev);
  }

  names(): string[] {
    return this.names_;
  }

  /**
   * Revisions are counted in memory and written every so often. After a crash the counter restarts at the highest
   * revision found in the data (the end of the sorted `rev` index), so it never goes backwards.
   */
  private ensureRev(): void {
    if (this.revReady) return;
    this.revReady = true;
    for (const c of this.synced) this.rev = Math.max(this.rev, c.max('rev') ?? 0);
  }
  private persistRev(): void {
    if (this.rev === this.persistedRev) return;
    this.metaDoc.rev = this.rev;
    this.meta.update(this.metaDoc);
    this.persistedRev = this.rev;
  }
  bumpRev(): number {
    this.ensureRev();
    this.rev += 1;
    if (this.rev - this.persistedRev >= REV_FLUSH_EVERY) this.persistRev();
    return this.rev;
  }
  get currentRev(): number {
    this.ensureRev();
    return this.rev;
  }
  get horizon(): number {
    return this.metaDoc.horizon;
  }
  raiseHorizon(rev: number): void {
    if (rev > this.metaDoc.horizon) {
      this.metaDoc.horizon = rev;
      this.meta.update(this.metaDoc);
    }
  }
  setRevState(rev: number, horizon: number): void {
    this.revReady = true;
    this.rev = rev;
    this.metaDoc.horizon = horizon;
    this.persistRev();
    this.meta.update(this.metaDoc);
  }

  batch<R>(fn: () => R): R {
    return this.store.batch(fn);
  }

  async save(): Promise<void> {
    this.persistRev();
    await this.store.flush();
  }

  async close(): Promise<void> {
    this.persistRev();
    await this.store.close();
  }

  fileSize(): number {
    return this.store.diskBytes();
  }

  snapshot(dataDir: string, keep: number): { file: string; bytes: number; kept: number } {
    this.persistRev();
    mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
    const final = path.join(dataDir, 'backups', `homecast-${stampNow()}.docstore`);
    const bytes = this.store.exportSync(final);
    return { file: final, bytes, kept: pruneBackups(dataDir, keep) };
  }
}

export { listBackupFiles };
