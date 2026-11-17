/** Values a query can match on. */
export type Scalar = string | number | boolean | null;
/** Greater than: for "changed since" queries over an indexed number such as `rev`. */
export interface After {
  $gt: number;
}
/** Any of these values: one query instead of one per value. */
export interface OneOf {
  $in: string[];
}
/** Equality on top-level fields, plus `{ $gt }` on numbers and `{ $in }` on strings. All the server needs, so both engines can answer it from an index. */
export type Query<T> = Partial<Record<keyof T & string, Scalar | After | OneOf>>;

/**
 * One collection of documents (spec §8). Everything outside `db/` goes through this interface, so the
 * storage engine can be swapped without touching the rest of the server.
 *
 * Documents come back as plain objects. Change one and call `save` to store the change: do not rely on
 * a returned object being the same instance as a previous call returned.
 */
export interface Repo<T extends { id: string }> {
  insert(doc: Omit<T, 'id'> & { id?: string }): T;
  /** Persist a changed document, bumping `rev` for synced collections. */
  save(doc: T): T;
  /** Persist without touching `rev` (server-internal bookkeeping that clients don't need). */
  saveQuiet(doc: T): T;
  get(id: string): T | null;
  findOne(q: Query<T>): T | null;
  find(q?: Query<T>): T[];
  /** Arbitrary predicate. Scans the whole collection, so prefer `find` with a query where one fits. */
  where(fn: (d: T) => boolean): T[];
  count(q?: Query<T>): number;
  remove(doc: T): void;
  removeWhere(fn: (d: T) => boolean): number;
  /** Store a document exactly as given, without assigning `rev` (copying a database between engines). */
  insertRaw(doc: T): void;
}

export type EngineName = 'loki' | 'sqlite' | 'docstore';

/** A storage engine: creates collections and owns persistence, the revision counter and backups. */
export interface Backend {
  readonly kind: EngineName;
  readonly file: string;
  /** `compound`: pairs of fields queried together (an owner and `rev`), so "what changed for this owner since X" is one index range. */
  repo<T extends { id: string }>(name: string, unique: string[], indices: string[], nextRev: (() => number) | null, compound?: string[][]): Repo<T>;
  readonly currentRev: number;
  readonly horizon: number;
  bumpRev(): number;
  raiseHorizon(rev: number): void;
  /** Set both counters (copying a database between engines). */
  setRevState(rev: number, horizon: number): void;
  /** Run `fn` as one unit: one disk write for many changes where the engine supports it. */
  batch<R>(fn: () => R): R;
  /** Flush to disk now. */
  save(): Promise<void>;
  close(): Promise<void>;
  /** Bytes on disk. */
  fileSize(): number;
  /** Consistent snapshot into `backups/`, keeping the newest `keep`. */
  snapshot(dataDir: string, keep: number): { file: string; bytes: number; kept: number };
  /** Names of the collections created so far (migration). */
  names(): string[];
}
