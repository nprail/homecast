import { comparator, compile, getter, sortKeys, testPlan, type Doc, type Query, type SortKey, type SortSpec } from './query.js';
import * as stats from './stats.js';

/** What a result set needs from its collection. */
export interface Source {
  query(q: object | undefined, opts?: FindOptions): Doc[];
  update(d: Doc): void;
  remove(d: Doc): void;
}

export interface FindOptions {
  /** `{ createdAt: -1, name: 1 }`, or a field name for ascending. */
  sort?: SortSpec | string;
  limit?: number;
  offset?: number;
}

/**
 * A list of documents you narrow, order and read step by step. Each step works on the documents already selected
 * (the first `find` uses the indexes). It is not lazy: every step produces its list at once. For "the newest 50 that
 * match" use `collection.find(query, { sort, limit })`, which reads only as far as it needs to.
 */
export class Resultset<T extends { id: string }> {
  /** @internal use `collection.chain()` */
  constructor(
    private readonly src: Source,
    private docs: Doc[] | null,
    private readonly all: () => Doc[],
  ) {}

  private list(): Doc[] {
    return this.docs ?? (this.docs = this.all());
  }

  /** Keep the documents matching a query. */
  find(q: Query<T>): this {
    if (this.docs === null) this.docs = this.src.query(q);
    else {
      const plan = compile(q);
      this.docs = plan === null ? [] : this.docs.filter((d) => testPlan(plan, d));
    }
    return this;
  }

  /** Keep the documents a function accepts. */
  where(fn: (d: T) => boolean): this {
    this.docs = this.list().filter((d) => fn(d as unknown as T));
    return this;
  }

  /** Order by a comparison function. */
  sort(fn: (a: T, b: T) => number): this {
    this.docs = [...this.list()].sort(fn as (a: Doc, b: Doc) => number);
    return this;
  }

  /** Order by one field, ascending unless `desc`. */
  simplesort(field: string, desc = false): this {
    return this.order(sortKeys({ [field]: desc ? -1 : 1 }));
  }

  /** Order by several fields: `[['a'], ['b', true]]` (true for descending). */
  compoundsort(specs: (string | [string, boolean?])[]): this {
    return this.order(
      specs.map((s) => {
        const [field, desc] = typeof s === 'string' ? [s, false] : s;
        return { field, get: getter(field), desc: Boolean(desc) };
      }),
    );
  }

  private order(keys: SortKey[]): this {
    this.docs = [...this.list()].sort(comparator(keys));
    return this;
  }

  limit(n: number): this {
    this.docs = this.list().slice(0, n);
    return this;
  }

  offset(n: number): this {
    this.docs = this.list().slice(n);
    return this;
  }

  /** An independent result set with the same documents, to branch from. */
  copy(): Resultset<T> {
    return new Resultset<T>(this.src, this.docs === null ? null : [...this.docs], this.all);
  }

  data(): T[] {
    return [...this.list()] as unknown as T[];
  }

  count(): number {
    return this.list().length;
  }

  first(): T | undefined {
    return this.list()[0] as unknown as T | undefined;
  }

  // ---- changing the documents ------------------------------------------------------------------

  /** Run a function that changes each document, or merge an object into each, and store them. */
  update(change: ((d: T) => void) | Partial<T>): this {
    for (const d of this.list()) {
      if (typeof change === 'function') change(d as unknown as T);
      else Object.assign(d, change);
      this.src.update(d);
    }
    return this;
  }

  /** Delete the documents from the collection. */
  remove(): this {
    for (const d of this.list()) this.src.remove(d);
    this.docs = [];
    return this;
  }

  // ---- reshaping -------------------------------------------------------------------------------

  map<U>(fn: (d: T, i: number) => U): U[] {
    return this.list().map((d, i) => fn(d as unknown as T, i));
  }

  mapReduce<M, R>(map: (d: T) => M, reduce: (all: M[]) => R): R {
    return reduce(this.map((d) => map(d)));
  }

  /**
   * Join to another list: each document is paired with the item whose `rightKey` equals its `leftKey`. The result is
   * the pair `{ left, right }`, or whatever `mapFn(left, right)` returns. Documents with no partner are left out.
   */
  eqJoin<R extends object, O = { left: T; right: R }>(other: R[] | Resultset<never>, leftKey: string, rightKey: string, mapFn?: (left: T, right: R) => O): O[] {
    const right: R[] = Array.isArray(other) ? other : (other.data() as unknown as R[]);
    const byKey = new Map<unknown, R>();
    const rget = getter(rightKey);
    for (const r of right) byKey.set(rget(r as unknown as Doc), r);
    const lget = getter(leftKey);
    const out: O[] = [];
    for (const d of this.list()) {
      const r = byKey.get(lget(d));
      if (r !== undefined) out.push(mapFn ? mapFn(d as unknown as T, r) : ({ left: d, right: r } as unknown as O));
    }
    return out;
  }

  // ---- aggregates ------------------------------------------------------------------------------

  /** The value of a field from every document. */
  extract(field: string): unknown[] {
    const get = getter(field);
    return this.list().map((d) => get(d));
  }

  /** The numbers among a field's values (numeric strings are parsed, the rest skipped). */
  extractNumerical(field: string): number[] {
    return stats.numbers(this.extract(field));
  }

  avg(field: string): number | undefined {
    return stats.avg(this.extractNumerical(field));
  }
  min(field: string): number | undefined {
    return stats.min(this.extractNumerical(field));
  }
  max(field: string): number | undefined {
    return stats.max(this.extractNumerical(field));
  }
  median(field: string): number | undefined {
    return stats.median(this.extractNumerical(field));
  }
  /** Population standard deviation. */
  stdDev(field: string): number | undefined {
    return stats.stdDev(this.extractNumerical(field));
  }
  mode(field: string): unknown {
    return stats.mode(this.extract(field));
  }
}
