import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { After, Backend, OneOf, Query, Repo, Scalar } from './repo.js';
import { pruneBackups, stampNow } from './loki.js';
import { uuid } from '../util/misc.js';

/** Loaded at run time so a server on the default engine never touches `node:sqlite`. */
function openDatabase(file: string): DatabaseSync {
  const require = createRequire(import.meta.url);
  let mod: typeof import('node:sqlite');
  try {
    mod = require('node:sqlite') as typeof import('node:sqlite');
  } catch {
    throw new Error('DB_ENGINE=sqlite needs Node.js 22.5 or newer (the built-in node:sqlite module).');
  }
  return new mod.DatabaseSync(file);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (s: string): string => {
  if (!IDENT.test(s)) throw new Error(`Invalid column name: ${s}`);
  return s;
};

type Row = { id: string; data: string };
/** Shared by every collection of one database. */
interface State {
  closed: boolean;
}
type Bind = string | number | null;
const bindValue = (v: Scalar): Bind => (typeof v === 'boolean' ? (v ? 1 : 0) : v);

/**
 * One table per collection: `id` and the whole document as JSON. Fields that are queried or must be unique get a
 * virtual column read from the JSON, with an index, so equality queries use it without storing the value twice.
 *
 * Like the in-memory engine, a document that is still referenced somewhere is the same object every time it is read,
 * so code that holds a record across an `await` (a transcript job, a feed being refreshed) sees changes made meanwhile
 * and never overwrites them with a stale copy. Once nothing references a document it is read from disk again.
 */
class SqliteRepo<T extends { id: string }> implements Repo<T> {
  private stmts = new Map<string, StatementSync>();
  private readonly table: string;
  private readonly live = new Map<string, WeakRef<T>>();
  private readonly forget = new FinalizationRegistry<string>((id) => {
    if (!this.live.get(id)?.deref()) this.live.delete(id);
  });

  constructor(
    private readonly db: DatabaseSync,
    name: string,
    private readonly columns: Set<string>,
    private readonly nextRev: (() => number) | null,
    private readonly tx: <R>(fn: () => R) => R,
    private readonly state: State,
  ) {
    this.table = `"${ident(name)}"`;
  }

  private remember(doc: T): T {
    this.live.set(doc.id, new WeakRef(doc));
    this.forget.register(doc, doc.id);
    return doc;
  }

  /** The live object for a row if there is one, otherwise a new one read from the row. */
  private hydrate(r: Row): T {
    return this.live.get(r.id)?.deref() ?? this.remember(JSON.parse(r.data) as T);
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  /** `col = ?` conditions for a query, using a virtual column where there is one and the JSON otherwise. */
  private where_(q: Query<T> | undefined): { sql: string; args: Bind[] } {
    const parts: string[] = [];
    const args: Bind[] = [];
    for (const [k, v] of Object.entries(q ?? {}) as [string, Scalar | After | OneOf | undefined][]) {
      if (v === undefined) continue;
      const ref = k === 'id' || this.columns.has(k) ? `"${ident(k)}"` : `json_extract(data, '$.${ident(k)}')`;
      if (v === null) parts.push(`${ref} IS NULL`);
      else if (typeof v === 'object' && '$in' in v) {
        parts.push(v.$in.length ? `${ref} IN (${v.$in.map(() => '?').join(', ')})` : '0');
        args.push(...v.$in);
      } else if (typeof v === 'object') (parts.push(`${ref} > ?`), args.push(v.$gt));
      else (parts.push(`${ref} = ?`), args.push(bindValue(v)));
    }
    return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', args };
  }

  insert(doc: Omit<T, 'id'> & { id?: string }): T {
    const full = { ...doc, id: doc.id ?? uuid() } as T & { rev?: number };
    if (this.state.closed) return full as T;
    if (this.nextRev) full.rev = this.nextRev();
    this.stmt(`INSERT INTO ${this.table} (id, data) VALUES (?, ?)`).run(full.id, JSON.stringify(full));
    return this.remember(full as T);
  }
  insertRaw(doc: T): void {
    this.stmt(`INSERT INTO ${this.table} (id, data) VALUES (?, ?)`).run(doc.id, JSON.stringify(doc));
  }
  private write(doc: T): T {
    if (this.state.closed) return doc;
    const r = this.stmt(`UPDATE ${this.table} SET data = ? WHERE id = ?`).run(JSON.stringify(doc), doc.id);
    if (Number(r.changes) === 0) throw new Error(`Cannot save ${this.table}: no document with id ${doc.id}`);
    return this.remember(doc);
  }
  save(doc: T): T {
    if (this.nextRev && !this.state.closed) (doc as T & { rev?: number }).rev = this.nextRev();
    return this.write(doc);
  }
  saveQuiet(doc: T): T {
    return this.write(doc);
  }
  get(id: string): T | null {
    const live = this.live.get(id)?.deref();
    if (live) return live;
    if (this.state.closed) return null;
    const r = this.stmt(`SELECT id, data FROM ${this.table} WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.hydrate(r) : null;
  }
  findOne(q: Query<T>): T | null {
    if (this.state.closed) return null;
    const w = this.where_(q);
    const r = this.stmt(`SELECT id, data FROM ${this.table}${w.sql} LIMIT 1`).get(...w.args) as Row | undefined;
    return r ? this.hydrate(r) : null;
  }
  find(q?: Query<T>): T[] {
    if (this.state.closed) return [];
    const w = this.where_(q);
    return (this.stmt(`SELECT id, data FROM ${this.table}${w.sql}`).all(...w.args) as Row[]).map((r) => this.hydrate(r));
  }
  where(fn: (d: T) => boolean): T[] {
    if (this.state.closed) return [];
    const out: T[] = [];
    for (const r of this.stmt(`SELECT id, data FROM ${this.table}`).iterate() as Iterable<Row>) {
      const d = this.hydrate(r);
      if (fn(d)) out.push(d);
    }
    return out;
  }
  count(q?: Query<T>): number {
    if (this.state.closed) return 0;
    const w = this.where_(q);
    return Number((this.stmt(`SELECT COUNT(*) AS n FROM ${this.table}${w.sql}`).get(...w.args) as { n: number | bigint }).n);
  }
  remove(doc: T): void {
    if (this.state.closed) return;
    this.stmt(`DELETE FROM ${this.table} WHERE id = ?`).run(doc.id);
    this.live.delete(doc.id);
  }
  removeWhere(fn: (d: T) => boolean): number {
    const docs = this.where(fn);
    this.tx(() => docs.forEach((d) => this.remove(d)));
    return docs.length;
  }
}

export class SqliteBackend implements Backend {
  readonly kind = 'sqlite' as const;
  private readonly state: State = { closed: false };
  private depth = 0;
  private rev = 0;
  private horizon_ = 0;
  private readonly names_: string[] = [];

  private constructor(
    private readonly db: DatabaseSync,
    readonly file: string,
    private readonly memory: boolean,
  ) {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536; PRAGMA busy_timeout = 5000');
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    const read = (k: string) => Number((db.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: number } | undefined)?.value ?? 0);
    this.rev = read('rev');
    this.horizon_ = read('horizon');
  }

  static open(opts: { dataDir: string; memory?: boolean }): SqliteBackend {
    mkdirSync(opts.dataDir, { recursive: true });
    const file = path.join(opts.dataDir, 'homecast.db.sqlite');
    return new SqliteBackend(openDatabase(opts.memory ? ':memory:' : file), file, !!opts.memory);
  }

  repo<T extends { id: string }>(name: string, unique: string[], indices: string[], nextRev: (() => number) | null, compound: string[][] = []): Repo<T> {
    ident(name);
    this.names_.push(name);
    this.db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)`);
    const have = new Set((this.db.prepare(`PRAGMA table_xinfo("${name}")`).all() as { name: string }[]).map((c) => c.name));
    const uniq = new Set(unique.filter((c) => c !== 'id'));
    const columns = new Set<string>();
    for (const c of new Set([...uniq, ...indices.filter((c) => c !== 'id')])) {
      ident(c);
      columns.add(c);
      if (!have.has(c)) this.db.exec(`ALTER TABLE "${name}" ADD COLUMN "${c}" GENERATED ALWAYS AS (json_extract(data, '$.${c}')) VIRTUAL`);
      this.db.exec(`CREATE ${uniq.has(c) ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "ix_${name}_${c}" ON "${name}" ("${c}")`);
    }
    for (const cols of compound) {
      for (const c of cols) if (!columns.has(c)) throw new Error(`Compound index on ${name} uses ${c}, which is not an indexed field`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS "ix_${name}_${cols.join('_')}" ON "${name}" (${cols.map((c) => `"${c}"`).join(', ')})`);
    }
    return new SqliteRepo<T>(this.db, name, columns, nextRev, (fn) => this.batch(fn), this.state);
  }

  names(): string[] {
    return this.names_;
  }

  private setMeta(key: string, value: number): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  bumpRev(): number {
    this.rev += 1;
    this.setMeta('rev', this.rev);
    return this.rev;
  }
  get currentRev(): number {
    return this.rev;
  }
  get horizon(): number {
    return this.horizon_;
  }
  raiseHorizon(rev: number): void {
    if (rev > this.horizon_) {
      this.horizon_ = rev;
      this.setMeta('horizon', rev);
    }
  }
  setRevState(rev: number, horizon: number): void {
    this.rev = rev;
    this.horizon_ = horizon;
    this.setMeta('rev', rev);
    this.setMeta('horizon', horizon);
  }

  /** One transaction: one commit for many changes. Nested calls join the outer one. */
  batch<R>(fn: () => R): R {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN');
    this.depth++;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  async save(): Promise<void> {
    if (!this.memory) this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  async close(): Promise<void> {
    // Background work can still be winding down; once closed, reads find nothing and writes are dropped.
    this.state.closed = true;
    if (!this.memory) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* closing anyway */
      }
    }
    this.db.close();
  }

  fileSize(): number {
    let n = 0;
    for (const f of [this.file, `${this.file}-wal`]) {
      try {
        n += statSync(f).size;
      } catch {
        /* not there */
      }
    }
    return n;
  }

  /** `VACUUM INTO` writes a consistent copy while the server keeps running. */
  snapshot(dataDir: string, keep: number): { file: string; bytes: number; kept: number } {
    const dir = path.join(dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, `homecast-${stampNow()}.sqlite`);
    const tmp = `${final}.tmp`;
    if (existsSync(tmp)) unlinkSync(tmp);
    this.db.prepare('VACUUM INTO ?').run(tmp);
    renameSync(tmp, final);
    return { file: final, bytes: statSync(final).size, kept: pruneBackups(dataDir, keep) };
  }
}
