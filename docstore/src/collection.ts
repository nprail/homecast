import { randomUUID } from 'node:crypto';
import { NotFoundError, UniqueViolation } from './errors.js';
import { OrderedList, StringList } from './ordered.js';
import {
  comparator, compile, getter, isPrimitive, norm, orderKey, sortKeys, testPlan, topK, mostlyOrdered,
  type Cnd, type Doc, type Plan, type Query,
} from './query.js';
import { Resultset, type FindOptions } from './resultset.js';
import * as stats from './stats.js';

export type { Cond, Query, Comparable, Ops, Scalar, SortSpec } from './query.js';
export type { FindOptions } from './resultset.js';

export interface CollectionOptions {
  /** Fields that must be unique across the collection (a missing or null value is allowed any number of times). Also indexed. */
  unique?: string[];
  /** Fields to index for equality and `$in` lookups. */
  indexed?: string[];
  /**
   * Fields to index for ranges (`$gt`, `$lt`, `$between`, ...) and for sorting, as well as equality. Numbers and dates
   * are kept in one sorted list and strings in another; documents whose value is neither are left out of the index.
   * A name may be a dotted path (`'owner.age'`) here and in `unique` and `indexed`.
   */
  ordered?: string[];
}

/** What the store gives a collection to record changes. */
export interface Sink {
  put(collection: string, json: string): void;
  del(collection: string, id: string): void;
}

type Bucket = Doc | Doc[] | Set<Doc>;

/** Per-document bookkeeping, kept on the document itself (non-enumerable, so copies and JSON do not carry it). */
const SHADOW = Symbol('docstore');
type Shadow = unknown[]; // [order, ...hashed values, ...ordered values]


// A bucket holds one document directly, then an array (up to 256), then a Set, so rare values cost almost nothing and common
// ones stay fast to remove from.
function bucketAdd(map: Map<unknown, Bucket>, key: unknown, doc: Doc): void {
  const cur = map.get(key);
  if (cur === undefined) map.set(key, doc);
  else if (Array.isArray(cur)) {
    if (cur.length >= 256) map.set(key, new Set([...cur, doc]));
    else cur.push(doc);
  } else if (cur instanceof Set) cur.add(doc);
  else map.set(key, [cur, doc]);
}
function bucketRemove(map: Map<unknown, Bucket>, key: unknown, doc: Doc): void {
  const cur = map.get(key);
  if (cur === undefined) return;
  if (cur === doc) map.delete(key);
  else if (Array.isArray(cur)) {
    const i = cur.indexOf(doc);
    if (i >= 0) cur.splice(i, 1);
    if (cur.length === 1) map.set(key, cur[0]!);
    else if (cur.length === 0) map.delete(key);
  } else if (cur instanceof Set) {
    cur.delete(doc);
    if (cur.size === 0) map.delete(key);
  }
}
const bucketSize = (b: Bucket | undefined): number => (b === undefined ? 0 : Array.isArray(b) ? b.length : b instanceof Set ? b.size : 1);
function bucketEach(b: Bucket | undefined, fn: (d: Doc) => void): void {
  if (b === undefined) return;
  if (Array.isArray(b)) for (let i = 0; i < b.length; i++) fn(b[i]!);
  else if (b instanceof Set) for (const d of b) fn(d);
  else fn(b);
}

interface OrdIndex {
  num: OrderedList<Doc>;
  str: StringList<Doc>;
}

/**
 * A set of documents with indexes. Documents are plain objects and the store hands back the objects it holds, as Loki
 * does: change one and call `update` to store the change (and keep the indexes right).
 */
export class Collection<T extends { id: string }> {
  private readonly docs: Map<string, Doc>;
  private readonly hashed: string[];
  private readonly hashGet: ((d: Doc) => unknown)[];
  private readonly hashMaps: Map<unknown, Bucket>[];
  private readonly orderedFields: string[];
  private readonly orderedGet: ((d: Doc) => unknown)[];
  private readonly orderedIdx: OrdIndex[];
  private readonly uniqueFields: Set<string>;
  private order = 0;

  /** @internal use `Docstore.collection` */
  constructor(
    readonly name: string,
    opts: CollectionOptions,
    private readonly sink: Sink,
    initial?: Map<string, Doc>,
  ) {
    this.docs = initial ?? new Map();
    this.uniqueFields = new Set((opts.unique ?? []).filter((f) => f !== 'id'));
    const ordered = [...new Set((opts.ordered ?? []).filter((f) => f !== 'id'))];
    this.orderedFields = ordered;
    this.hashed = [...new Set([...this.uniqueFields, ...(opts.indexed ?? [])])].filter((f) => f !== 'id' && !ordered.includes(f));
    // A unique field that is also ordered still needs its uniqueness checked, so it keeps a hash index too.
    for (const f of this.uniqueFields) if (ordered.includes(f) && !this.hashed.includes(f)) this.hashed.push(f);
    this.hashGet = this.hashed.map(getter);
    this.hashMaps = this.hashed.map(() => new Map());
    this.orderedGet = ordered.map(getter);
    this.orderedIdx = ordered.map(() => ({ num: new OrderedList<Doc>(), str: new StringList<Doc>() }));
    if (initial) this.load();
  }

  /** Index documents read from disk in one pass: sorted lists are built once instead of inserted into. */
  private load(): void {
    const nums = this.orderedFields.map(() => [] as { v: number; o: number; d: Doc }[]);
    const strs = this.orderedFields.map(() => [] as { v: string; o: number; d: Doc }[]);
    for (const doc of this.docs.values()) {
      const o = this.order++;
      const shadow: Shadow = [o];
      for (let i = 0; i < this.hashed.length; i++) {
        const v = norm(this.hashGet[i]!(doc));
        shadow.push(v);
        if (isPrimitive(v)) {
          if (this.uniqueFields.has(this.hashed[i]!) && v !== null && this.hashMaps[i]!.has(v)) throw new UniqueViolation(`${this.name}.${this.hashed[i]}: duplicate value ${String(v)} in stored data`);
          bucketAdd(this.hashMaps[i]!, v, doc);
        }
      }
      for (let i = 0; i < this.orderedFields.length; i++) {
        const k = orderKey(this.orderedGet[i]!(doc));
        shadow.push(k);
        if (typeof k === 'number') nums[i]!.push({ v: k, o, d: doc });
        else if (typeof k === 'string') strs[i]!.push({ v: k, o, d: doc });
      }
      Object.defineProperty(doc, SHADOW, { value: shadow, writable: true, configurable: true, enumerable: false });
    }
    for (let i = 0; i < this.orderedFields.length; i++) {
      nums[i]!.sort((a, b) => a.v - b.v || a.o - b.o);
      strs[i]!.sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : a.o - b.o));
      this.orderedIdx[i] = { num: OrderedList.fromSorted(nums[i]!), str: StringList.fromSorted(strs[i]!) };
    }
  }

  get size(): number {
    return this.docs.size;
  }

  // ---- writing -------------------------------------------------------------------------------

  /** Add a document. It gets an `id` if it has none. Returns the same object. */
  insert(doc: Omit<T, 'id'> & { id?: string }): T {
    const d = doc as unknown as Doc;
    if (d.id === undefined || d.id === null) d.id = randomUUID();
    if (this.docs.has(d.id)) throw new UniqueViolation(`${this.name}: a document with id ${d.id} already exists`);
    this.checkUnique(d, undefined);
    this.index(d, this.order++);
    this.docs.set(d.id, d);
    this.sink.put(this.name, JSON.stringify(d));
    return d as unknown as T;
  }

  /** Store the current state of a document that is already in the collection. */
  update(doc: T): T {
    const d = doc as unknown as Doc;
    const cur = this.docs.get(d.id);
    if (!cur) throw new NotFoundError(`${this.name}: no document with id ${d.id}`);
    this.checkUnique(d, cur);
    const shadow = (cur as unknown as Record<symbol, Shadow>)[SHADOW]!;
    this.reindex(d, cur, shadow);
    if (cur !== d) this.docs.set(d.id, d);
    this.sink.put(this.name, JSON.stringify(d));
    return doc;
  }

  remove(doc: T | string): void {
    const id = typeof doc === 'string' ? doc : doc.id;
    const cur = this.docs.get(id);
    if (!cur) return;
    this.unindex(cur);
    this.docs.delete(id);
    this.sink.del(this.name, id);
  }

  /** Delete every document matching a query or a function; returns how many. */
  removeWhere(q: Query<T> | ((d: T) => boolean)): number {
    const hit = typeof q === 'function' ? this.where(q) : this.find(q);
    for (const d of hit) this.remove(d);
    return hit.length;
  }

  /** Change every document matching a query (`change` is a function that edits it, or an object merged in) and store them. */
  findAndUpdate(q: Query<T>, change: ((d: T) => void) | Partial<T>): number {
    return this.chain().find(q).update(change).count();
  }

  /** Change every document a function accepts, with another function, and store them. */
  updateWhere(filter: (d: T) => boolean, change: (d: T) => void): number {
    return this.chain().where(filter).update(change).count();
  }

  /** Delete every document matching a query; returns how many. */
  findAndRemove(q: Query<T>): number {
    return this.removeWhere(q);
  }

  // ---- reading -------------------------------------------------------------------------------

  get(id: string): T | undefined {
    return this.docs.get(id) as unknown as T | undefined;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  /** The document whose (unique or indexed) field equals a value: `by('email', 'a@b.c')`. */
  by(field: string, value: unknown): T | undefined {
    if (field === 'id') return typeof value === 'string' ? this.get(value) : undefined;
    return this.findOne({ [field]: value } as Query<T>) ?? undefined;
  }

  findOne(q: Query<T>, opts?: Pick<FindOptions, 'sort'>): T | null {
    return this.query(q, { ...opts, limit: 1 })[0] as unknown as T | null ?? null;
  }

  /** Documents matching a query (all of them with none), optionally sorted, skipping `offset` and stopping after `limit`. */
  find(q?: Query<T>, opts?: FindOptions): T[] {
    if (!q && !opts) return [...this.docs.values()] as unknown as T[];
    return this.query(q, opts) as unknown as T[];
  }

  where(fn: (d: T) => boolean): T[] {
    const out: T[] = [];
    for (const d of this.docs.values()) if (fn(d as unknown as T)) out.push(d as unknown as T);
    return out;
  }

  /** Start a result set: narrow, sort, page and aggregate step by step. */
  chain(): Resultset<T> {
    return new Resultset<T>(
      { query: (q, o) => this.query(q, o), update: (d) => void this.update(d as unknown as T), remove: (d) => this.remove(d as unknown as T) },
      null,
      () => [...this.docs.values()],
    );
  }

  /** Counting that the indexes can answer does not touch the documents. */
  count(q?: Query<T>): number {
    if (!q) return this.docs.size;
    const plan = compile(q);
    if (plan === null) return 0;
    if (plan.conds.length === 0 && plan.preds.length === 0 && plan.ors.length === 0) return this.docs.size;
    if (plan.conds.length === 1 && plan.preds.length === 0 && plan.ors.length === 0) {
      const n = this.indexedCount(plan.conds[0]!);
      if (n !== undefined) return n;
    }
    return this.run(plan, Infinity).length;
  }

  values(): IterableIterator<T> {
    return this.docs.values() as unknown as IterableIterator<T>;
  }

  // ---- aggregates ----------------------------------------------------------------------------

  /** Largest number in a field, or undefined. On an ordered field this costs nothing: it is the end of the index. */
  max(field: string): number | undefined {
    const i = this.orderedFields.indexOf(field);
    return i >= 0 ? this.orderedIdx[i]!.num.max() : this.chain().max(field);
  }

  /** Smallest number in a field, or undefined. Free on an ordered field. */
  min(field: string): number | undefined {
    const i = this.orderedFields.indexOf(field);
    return i >= 0 ? this.orderedIdx[i]!.num.min() : this.chain().min(field);
  }

  avg(field: string): number | undefined {
    return this.chain().avg(field);
  }
  median(field: string): number | undefined {
    return this.chain().median(field);
  }
  stdDev(field: string): number | undefined {
    return this.chain().stdDev(field);
  }
  mode(field: string): unknown {
    return this.chain().mode(field);
  }
  /** The value of a field from every document. */
  extract(field: string): unknown[] {
    return this.chain().extract(field);
  }
  extractNumerical(field: string): number[] {
    return stats.numbers(this.extract(field));
  }

  // ---- indexes -------------------------------------------------------------------------------

  private index(d: Doc, ord: number): void {
    const shadow: Shadow = [ord];
    for (let i = 0; i < this.hashed.length; i++) {
      const v = norm(this.hashGet[i]!(d));
      shadow.push(v);
      if (isPrimitive(v)) bucketAdd(this.hashMaps[i]!, v, d);
    }
    for (let i = 0; i < this.orderedFields.length; i++) {
      const k = orderKey(this.orderedGet[i]!(d));
      shadow.push(k);
      this.orderedAdd(i, k, ord, d);
    }
    Object.defineProperty(d, SHADOW, { value: shadow, writable: true, configurable: true, enumerable: false });
  }

  private orderedAdd(i: number, k: number | string | undefined, ord: number, d: Doc): void {
    if (typeof k === 'number') this.orderedIdx[i]!.num.insert(k, ord, d);
    else if (typeof k === 'string') this.orderedIdx[i]!.str.insert(k, ord, d);
  }

  private orderedDrop(i: number, k: unknown, ord: number): void {
    if (typeof k === 'number') this.orderedIdx[i]!.num.remove(k, ord);
    else if (typeof k === 'string') this.orderedIdx[i]!.str.remove(k, ord);
  }

  private unindex(d: Doc): void {
    const shadow = (d as unknown as Record<symbol, Shadow>)[SHADOW];
    if (!shadow) return;
    const ord = shadow[0] as number;
    for (let i = 0; i < this.hashed.length; i++) {
      const v = shadow[1 + i];
      if (isPrimitive(v)) bucketRemove(this.hashMaps[i]!, v, d);
    }
    for (let i = 0; i < this.orderedFields.length; i++) this.orderedDrop(i, shadow[1 + this.hashed.length + i], ord);
  }

  /** Bring the indexes in line with a document's current values, using the values it was indexed under before. */
  private reindex(next: Doc, cur: Doc, shadow: Shadow): void {
    const ord = shadow[0] as number;
    const sameObject = cur === next;
    const out: Shadow = [ord];
    for (let i = 0; i < this.hashed.length; i++) {
      const old = shadow[1 + i];
      const v = norm(this.hashGet[i]!(next));
      out.push(v);
      if (sameObject && old === v) continue;
      if (isPrimitive(old)) bucketRemove(this.hashMaps[i]!, old, cur);
      if (isPrimitive(v)) bucketAdd(this.hashMaps[i]!, v, next);
    }
    const base = 1 + this.hashed.length;
    for (let i = 0; i < this.orderedFields.length; i++) {
      const old = shadow[base + i];
      const k = orderKey(this.orderedGet[i]!(next));
      out.push(k);
      if (sameObject && old === k) continue;
      this.orderedDrop(i, old, ord);
      this.orderedAdd(i, k, ord, next);
    }
    Object.defineProperty(next, SHADOW, { value: out, writable: true, configurable: true, enumerable: false });
  }

  private checkUnique(d: Doc, self: Doc | undefined): void {
    for (const f of this.uniqueFields) {
      const i = this.hashed.indexOf(f);
      const v = norm(this.hashGet[i]!(d));
      if (v === null || !isPrimitive(v)) continue;
      const bucket = this.hashMaps[i]!.get(v);
      let clash = false;
      bucketEach(bucket, (other) => {
        if (other !== self && other.id !== d.id) clash = true;
      });
      if (clash) throw new UniqueViolation(`${this.name}.${f}: ${String(v)} is already taken`);
    }
  }

  // ---- queries -------------------------------------------------------------------------------

  private rangeBounds(c: Cnd): { lo: number | string | undefined; loEx: boolean; hi: number | string | undefined; hiEx: boolean } {
    let lo = c.gte;
    let loEx = false;
    if (c.gt !== undefined && (lo === undefined || c.gt >= lo)) (lo = c.gt), (loEx = true);
    let hi = c.lte;
    let hiEx = false;
    if (c.lt !== undefined && (hi === undefined || c.lt <= hi)) (hi = c.lt), (hiEx = true);
    return { lo, loEx, hi, hiEx };
  }

  /** How many documents an index would hand back for one condition, or undefined if no index can answer it. */
  private indexedCount(c: Cnd): number | undefined {
    if (c.field === 'id') {
      if (c.kind === 'eq') return typeof c.value === 'string' && this.docs.has(c.value) ? 1 : 0;
      if (c.kind === 'in') {
        let n = 0;
        for (const v of c.set!) if (typeof v === 'string' && this.docs.has(v)) n++;
        return n;
      }
      return undefined;
    }
    const hi = this.hashed.indexOf(c.field);
    if (hi >= 0 && c.kind === 'eq') return isPrimitive(c.value) ? bucketSize(this.hashMaps[hi]!.get(c.value)) : 0;
    if (hi >= 0 && c.kind === 'in') {
      let n = 0;
      for (const v of c.set!) n += bucketSize(this.hashMaps[hi]!.get(v));
      return n;
    }
    const oi = this.orderedFields.indexOf(c.field);
    if (oi >= 0) {
      const idx = this.orderedIdx[oi]!;
      if (c.kind === 'eq') {
        if (typeof c.value === 'number') return idx.num.countRange(c.value, false, c.value, false);
        if (typeof c.value === 'string') return idx.str.countRange(c.value, false, c.value, false);
        return undefined;
      }
      if (c.kind === 'range') {
        const b = this.rangeBounds(c);
        return c.type === 'number' ? idx.num.countRange(b.lo as number | undefined, b.loEx, b.hi as number | undefined, b.hiEx) : idx.str.countRange(b.lo as string | undefined, b.loEx, b.hi as string | undefined, b.hiEx);
      }
    }
    return undefined;
  }

  /** Whether some index can produce the documents for this condition. */
  private canIndex(c: Cnd): boolean {
    if (c.kind === 'fn') return false;
    if (c.field === 'id') return c.kind === 'eq' || c.kind === 'in';
    if (this.hashed.includes(c.field)) return c.kind === 'eq' || c.kind === 'in';
    if (!this.orderedFields.includes(c.field)) return false;
    return c.kind === 'range' || (c.kind === 'eq' && (typeof c.value === 'number' || typeof c.value === 'string'));
  }

  /** A cheap upper bound on the documents a plan needs to look at, or undefined when nothing in it uses an index. */
  private estimate(plan: Plan): number | undefined {
    let best: number | undefined;
    for (const c of plan.conds) {
      if (!this.canIndex(c)) continue;
      const n = this.indexedCount(c);
      if (n !== undefined && (best === undefined || n < best)) best = n;
    }
    for (const branches of plan.ors) {
      const n = this.orEstimate(branches);
      if (n !== undefined && (best === undefined || n < best)) best = n;
    }
    return best;
  }

  private orEstimate(branches: Plan[]): number | undefined {
    let n = 0;
    for (const b of branches) {
      const e = this.estimate(b);
      if (e === undefined) return undefined;
      n += e;
    }
    return n;
  }

  /** Run a query with its options: sorted, paged. */
  private query(q: object | undefined, opts?: FindOptions): Doc[] {
    const plan = q ? compile(q) : { conds: [], preds: [], ors: [] };
    if (plan === null) return [];
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? Infinity;
    const need = offset + limit;
    const keys = sortKeys(opts?.sort);
    if (keys.length === 0) {
      const out = this.run(plan, need);
      return offset > 0 || out.length > limit ? out.slice(offset, offset + limit) : out;
    }
    if (keys.length === 1 && need !== Infinity) {
      const walked = this.walkSorted(plan, keys[0]!.field, keys[0]!.desc, need);
      if (walked) return offset > 0 ? walked.slice(offset) : walked;
    }
    const all = this.run(plan, Infinity);
    const cmp = comparator(keys);
    if (need <= 256 && all.length > need * 4 && !mostlyOrdered(all, cmp)) return topK(all, cmp, need).slice(offset);
    all.sort(cmp);
    return offset > 0 || all.length > limit ? all.slice(offset, offset + limit) : all;
  }

  /**
   * Read the first `need` documents in sort order straight off an ordered index, checking the query on each as it goes.
   * Worth it when the query would otherwise read many documents and sort them; returns null when it is not possible
   * (no ordered index on the field, or some documents have no sortable value there) or not worth it.
   */
  private walkSorted(plan: Plan, field: string, desc: boolean, need: number): Doc[] | null {
    const oi = this.orderedFields.indexOf(field);
    if (oi < 0) return null;
    const idx = this.orderedIdx[oi]!;
    if (idx.num.size + idx.str.size !== this.docs.size) return null;
    const range = plan.conds.find((c) => c.kind === 'range' && c.field === field) ?? null;
    // The walk may not find its matches near the start of the index (the newest 20 of a podcast that last posted a
    // year ago). So it gets a budget, the cost of the alternative (read the matches and sort them), and gives up
    // when it is spent.
    let budget = Infinity;
    if (range === null) {
      const n = this.estimate(plan);
      if (n !== undefined) {
        // If the matches were spread evenly it would take need * size / n steps to find them: not worth trying when that
        // is several times what reading and sorting the matches costs.
        if ((need * this.docs.size) / Math.max(n, 1) > 4 * n) return null;
        budget = Math.max(64, 3 * n);
      } else budget = this.docs.size;
    }
    const out: Doc[] = [];
    let tested = 0;
    let gaveUp = false;
    const take = (d: Doc): boolean => {
      if (testPlan(plan, d, range)) out.push(d);
      if (out.length >= need) return false;
      if (++tested > budget) return (gaveUp = true), false;
      return true;
    };
    const num = (lo?: number, loEx = false, hi?: number, hiEx = false) => idx.num.walk(lo, loEx, hi, hiEx, desc, take);
    const str = (lo?: string, loEx = false, hi?: string, hiEx = false) => idx.str.walk(lo, loEx, hi, hiEx, desc, take);
    if (range !== null) {
      const b = this.rangeBounds(range);
      if (range.type === 'number') num(b.lo as number | undefined, b.loEx, b.hi as number | undefined, b.hiEx);
      else str(b.lo as string | undefined, b.loEx, b.hi as string | undefined, b.hiEx);
    } else if (desc) {
      str();
      if (out.length < need && !gaveUp) num();
    } else {
      num();
      if (out.length < need && !gaveUp) str();
    }
    return gaveUp ? null : out;
  }

  /**
   * Pick the index that answers the query most narrowly, read just those documents, and check the rest.
   * With only one thing an index can answer there is nothing to compare, so no counting is done.
   */
  private run(plan: Plan, limit: number): Doc[] {
    const out: Doc[] = [];
    const { conds, preds, ors } = plan;
    if (conds.length === 0 && preds.length === 0 && ors.length === 0) {
      for (const d of this.docs.values()) {
        out.push(d);
        if (out.length >= limit) break;
      }
      return out;
    }
    let best = -1;
    let bestOr = -1;
    let candidates = 0;
    for (let i = 0; i < conds.length; i++) {
      if (this.canIndex(conds[i]!)) {
        candidates++;
        if (best < 0) best = i;
      }
    }
    candidates += ors.length;
    if (candidates > 1 || (candidates === 1 && best < 0)) {
      let bestN = Infinity;
      best = -1;
      for (let i = 0; i < conds.length; i++) {
        if (!this.canIndex(conds[i]!)) continue;
        const n = this.indexedCount(conds[i]!);
        if (n !== undefined && n < bestN) (best = i), (bestN = n);
      }
      for (let i = 0; i < ors.length; i++) {
        const n = this.orEstimate(ors[i]!);
        if (n !== undefined && n < bestN) (best = -1), (bestOr = i), (bestN = n);
      }
      if (bestN === 0) return out;
    }

    if (bestOr >= 0) {
      // Union of what each branch finds (each one using its own indexes), then check everything else.
      const branches = ors[bestOr]!;
      const seen = new Set<Doc>();
      for (const b of branches) {
        for (const d of this.run(b, Infinity)) {
          if (seen.has(d)) continue;
          seen.add(d);
          if (testPlan(plan, d, null, branches)) {
            out.push(d);
            if (out.length >= limit) return out;
          }
        }
      }
      return out;
    }

    // The documents an index hands back already satisfy its condition; only the others need checking.
    const c = best < 0 ? null : conds[best]!;
    const alone = conds.length === (c ? 1 : 0) && preds.length === 0 && ors.length === 0;
    const take: (d: Doc) => void = alone
      ? (d) => {
          if (out.length < limit) out.push(d);
        }
      : (d) => {
          if (out.length < limit && testPlan(plan, d, c)) out.push(d);
        };
    if (c === null) {
      for (const d of this.docs.values()) {
        take(d);
        if (out.length >= limit) break;
      }
      return out;
    }
    if (c.field === 'id') {
      if (c.kind === 'in') {
        for (const v of c.set!) {
          const d = typeof v === 'string' ? this.docs.get(v) : undefined;
          if (d) take(d);
        }
      } else {
        const d = this.docs.get(c.value as string);
        if (d) take(d);
      }
      return out;
    }
    const hi = this.hashed.indexOf(c.field);
    if (hi >= 0 && c.kind === 'eq') bucketEach(this.hashMaps[hi]!.get(c.value), take);
    else if (hi >= 0 && c.kind === 'in') for (const v of c.set!) bucketEach(this.hashMaps[hi]!.get(v), take);
    else {
      const idx = this.orderedIdx[this.orderedFields.indexOf(c.field)]!;
      const hits: Doc[] = [];
      if (c.kind === 'eq') {
        if (typeof c.value === 'number') idx.num.range(c.value, false, c.value, false, hits);
        else idx.str.range(c.value as string, false, c.value as string, false, hits);
      } else {
        const b = this.rangeBounds(c);
        if (c.type === 'number') idx.num.range(b.lo as number | undefined, b.loEx, b.hi as number | undefined, b.hiEx, hits);
        else idx.str.range(b.lo as string | undefined, b.loEx, b.hi as string | undefined, b.hiEx, hits);
      }
      for (const d of hits) take(d);
    }
    return out;
  }
}
