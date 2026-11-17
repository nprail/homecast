/**
 * Query language: compiling a query object into conditions the collection can plan with, and testing documents
 * against them.
 *
 * A query is a set of conditions that must all hold. Conditions an index can answer (equality, `$in`, ranges) are kept
 * apart as `conds`, so the planner can drive from the cheapest one. Everything else is a function over the value
 * (`kind: 'fn'`), a function over the whole document (`preds`), or an `$or` (`ors`, whose branches are plans of their own
 * and can each use indexes).
 */

export type Doc = Record<string, unknown> & { id: string };

export type Scalar = string | number | boolean | null;
/** Things that have an order: numbers and dates compare as numbers, strings as strings. */
export type Comparable = number | string | Date;

export interface Ops {
  $eq?: unknown;
  $ne?: unknown;
  /** Abstract equality (`==`): `1` matches `'1'`. */
  $aeq?: unknown;
  /** Equal as moments in time: a Date, an ISO string or a timestamp on either side. */
  $dteq?: Comparable;
  $gt?: Comparable;
  $gte?: Comparable;
  $lt?: Comparable;
  $lte?: Comparable;
  /** `[low, high]`, both ends included. */
  $between?: [Comparable, Comparable];
  $in?: readonly unknown[];
  $nin?: readonly unknown[];
  /** The value is a key of this object. */
  $keyin?: object;
  $nkeyin?: object;
  /** This object has a defined value under the field's value. */
  $definedin?: object;
  $undefinedin?: object;
  /** A RegExp, a pattern string, or `[pattern, flags]`. Matches strings only. */
  $regex?: RegExp | string | [string, string];
  /** An array holding the value (or every one of an array of values), a string with that substring, an object with that key. */
  $contains?: unknown;
  $containsAny?: unknown;
  $containsNone?: unknown;
  $containsString?: string;
  /** `typeof`, plus `'array'`, `'null'` and `'date'`. A missing field is `'undefined'`. */
  $type?: string;
  $finite?: boolean;
  /** Length of an array or a string. */
  $size?: number;
  $len?: number;
  $exists?: boolean;
  $not?: Cond;
  /** JavaScript comparison (`>`, `<`) without regard to type. */
  $jgt?: unknown;
  $jgte?: unknown;
  $jlt?: unknown;
  $jlte?: unknown;
  $jbetween?: [unknown, unknown];
}

/** A condition on one field: a value to equal, a RegExp, a Date, or an object of operators. */
export type Cond = Scalar | Date | RegExp | readonly unknown[] | Ops;

export type Query<T = Record<string, unknown>> = { [K in keyof T & string]?: Cond } & {
  /** Dotted paths reach into nested objects: `{ 'owner.name': 'Maya' }`. */
  [path: `${string}.${string}`]: Cond | undefined;
} & {
  $and?: Query<T>[];
  $or?: Query<T>[];
  $nor?: Query<T>[];
  $not?: Query<T>;
  $where?: (doc: T) => boolean;
};

export interface Cnd {
  field: string;
  get: (d: Doc) => unknown;
  kind: 'eq' | 'in' | 'range' | 'fn';
  /** `eq`: the (normalised) value. */
  value?: unknown;
  /** `in`: the values. */
  set?: Set<unknown>;
  values?: unknown[];
  /** `range`: the type being compared and the bounds. */
  type?: 'number' | 'string';
  gt?: number | string;
  gte?: number | string;
  lt?: number | string;
  lte?: number | string;
  /** `fn`: a test on the field's value. */
  test?: (x: unknown) => boolean;
}

export interface Plan {
  conds: Cnd[];
  preds: ((d: Doc) => boolean)[];
  /** Each entry is an `$or`: a document must satisfy at least one of its branches. */
  ors: Plan[][];
}

// ---- values ------------------------------------------------------------------------------------

export const norm = (v: unknown): unknown => (v === undefined ? null : v);
export const isPrimitive = (v: unknown): v is string | number | boolean | null => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** A reader for a field name; dotted names walk into nested objects (and array positions). */
export function getter(field: string): (d: Doc) => unknown {
  if (!field.includes('.')) return (d) => d[field];
  const parts = field.split('.');
  return (d) => {
    let cur: unknown = d;
    for (let i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = (cur as Record<string, unknown>)[parts[i]!];
    }
    return cur;
  };
}

/** The key an ordered index files a value under: numbers and valid dates as numbers, strings as strings, else none. */
export function orderKey(v: unknown): number | string | undefined {
  if (typeof v === 'number') return Number.isNaN(v) ? undefined : v;
  if (typeof v === 'string') return v;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

const typeOf = (x: unknown): string => (x === null ? 'null' : Array.isArray(x) ? 'array' : x instanceof Date ? 'date' : typeof x);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const asTime = (v: unknown): number => (v instanceof Date ? v.getTime() : typeof v === 'string' || typeof v === 'number' ? new Date(v).getTime() : NaN);

function containsOne(x: unknown, v: unknown): boolean {
  if (Array.isArray(x)) return x.some((e) => deepEqual(e, v));
  if (typeof x === 'string') return typeof v === 'string' && x.includes(v);
  if (x !== null && typeof x === 'object') return (typeof v === 'string' || typeof v === 'number') && Object.hasOwn(x, v);
  return false;
}

// ---- sorting -----------------------------------------------------------------------------------

/** Order of types when values of different types are sorted together: nothing, booleans, numbers and dates, strings, the rest. */
function rank(v: unknown): number {
  if (v === undefined || v === null) return 0;
  switch (typeof v) {
    case 'boolean':
      return 1;
    case 'number':
      return Number.isNaN(v) ? 0 : 2;
    case 'string':
      return 3;
    default:
      return v instanceof Date ? (Number.isNaN(v.getTime()) ? 0 : 2) : 4;
  }
}

/** A total order over any two values; this is the order `sort` uses, and the order of the ordered indexes. */
export function compareValues(a: unknown, b: unknown): number {
  // The common cases first: two numbers or two strings.
  if (typeof a === 'number' && typeof b === 'number' && a === a && b === b) return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) return Number(a) - Number(b);
  if (ra === 2) return (a instanceof Date ? a.getTime() : (a as number)) - (b instanceof Date ? b.getTime() : (b as number));
  if (ra === 3) return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  return 0;
}

/** `{ createdAt: -1, name: 1 }` (or `'asc'`/`'desc'`), in key order. */
export type SortSpec = Record<string, 1 | -1 | 'asc' | 'desc'>;
export interface SortKey {
  field: string;
  get: (d: Doc) => unknown;
  desc: boolean;
}

export function sortKeys(spec: SortSpec | string | undefined): SortKey[] {
  if (spec === undefined) return [];
  const entries: [string, 1 | -1 | 'asc' | 'desc'][] = typeof spec === 'string' ? [[spec, 1]] : Object.entries(spec);
  return entries.map(([field, dir]) => ({ field, get: getter(field), desc: dir === -1 || dir === 'desc' }));
}

export function comparator(keys: SortKey[]): (a: Doc, b: Doc) => number {
  if (keys.length === 1) {
    const { get, desc } = keys[0]!;
    return desc ? (a, b) => compareValues(get(b), get(a)) : (a, b) => compareValues(get(a), get(b));
  }
  return (a, b) => {
    for (const k of keys) {
      const c = k.desc ? compareValues(k.get(b), k.get(a)) : compareValues(k.get(a), k.get(b));
      if (c !== 0) return c;
    }
    return 0;
  };
}

// ---- compiling ---------------------------------------------------------------------------------

/** `null` means the query can never match anything. */
export function compile(q: object): Plan | null {
  const plan: Plan = { conds: [], preds: [], ors: [] };
  return addQuery(plan, q) ? plan : null;
}

const isEmpty = (p: Plan) => p.conds.length === 0 && p.preds.length === 0 && p.ors.length === 0;

function addQuery(plan: Plan, q: object): boolean {
  for (const [key, raw] of Object.entries(q) as [string, unknown][]) {
    if (raw === undefined) continue;
    if (key.charCodeAt(0) === 36 /* $ */) {
      if (!addLogical(plan, key, raw)) return false;
    } else if (!addField(plan, key, raw)) return false;
  }
  return true;
}

function subQueries(key: string, raw: unknown): object[] {
  if (!Array.isArray(raw)) throw new Error(`${key} takes an array of queries`);
  return raw as object[];
}

function addLogical(plan: Plan, key: string, raw: unknown): boolean {
  switch (key) {
    case '$and':
      for (const sub of subQueries(key, raw)) if (!addQuery(plan, sub)) return false;
      return true;
    case '$or': {
      const branches: Plan[] = [];
      for (const sub of subQueries(key, raw)) {
        const p = compile(sub);
        if (p === null) continue;
        if (isEmpty(p)) return true; // one branch matches everything
        branches.push(p);
      }
      if (branches.length === 0) return false;
      if (branches.length === 1) {
        // A single branch is just its conditions.
        const only = branches[0]!;
        plan.conds.push(...only.conds);
        plan.preds.push(...only.preds);
        plan.ors.push(...only.ors);
      } else plan.ors.push(branches);
      return true;
    }
    case '$nor': {
      const branches: Plan[] = [];
      for (const sub of subQueries(key, raw)) {
        const p = compile(sub);
        if (p === null) continue;
        if (isEmpty(p)) return false;
        branches.push(p);
      }
      if (branches.length) plan.preds.push((d) => !branches.some((b) => testPlan(b, d)));
      return true;
    }
    case '$not': {
      const p = compile(raw as object);
      if (p === null) return true;
      if (isEmpty(p)) return false;
      plan.preds.push((d) => !testPlan(p, d));
      return true;
    }
    case '$where':
      if (typeof raw !== 'function') throw new Error('$where takes a function');
      plan.preds.push(raw as (d: Doc) => boolean);
      return true;
    default:
      throw new Error(`Unknown operator ${key}`);
  }
}

function eqCond(field: string, get: (d: Doc) => unknown, v: unknown): Cnd {
  if (isPrimitive(v) || v === undefined) return { field, get, kind: 'eq', value: norm(v) };
  return { field, get, kind: 'fn', test: (x) => deepEqual(x, v) };
}

function addField(plan: Plan, field: string, raw: unknown): boolean {
  const get = getter(field);
  if (raw === undefined || isPrimitive(raw)) {
    plan.conds.push(eqCond(field, get, raw));
    return true;
  }
  if (raw instanceof RegExp) {
    plan.conds.push(regexCond(field, get, raw));
    return true;
  }
  if (typeof raw === 'object' && !(raw instanceof Date) && !Array.isArray(raw)) {
    const keys = Object.keys(raw);
    if (keys.length > 0 && keys.every((k) => k.charCodeAt(0) === 36)) return addOps(plan, field, get, raw as Ops);
  }
  if (raw instanceof Date) {
    const t = raw.getTime();
    plan.conds.push({ field, get, kind: 'fn', test: (x) => asTime(x) === t });
  } else plan.conds.push(eqCond(field, get, raw));
  return true;
}

function regexCond(field: string, get: (d: Doc) => unknown, arg: unknown): Cnd {
  let re: RegExp;
  if (arg instanceof RegExp) re = new RegExp(arg.source, arg.flags.replace(/[gy]/g, ''));
  else if (typeof arg === 'string') re = new RegExp(arg);
  else if (Array.isArray(arg) && typeof arg[0] === 'string') re = new RegExp(arg[0], String(arg[1] ?? '').replace(/[gy]/g, ''));
  else throw new Error('$regex takes a RegExp, a string, or [pattern, flags]');
  return { field, get, kind: 'fn', test: (x) => typeof x === 'string' && re.test(x) };
}

function addOps(plan: Plan, field: string, get: (d: Doc) => unknown, ops: Ops): boolean {
  let range: Cnd | null = null;
  // Bounds of a range must all be of one type; a bound that cannot be compared matches nothing.
  const bound = (op: '$gt' | '$gte' | '$lt' | '$lte', arg: unknown): boolean => {
    const k = orderKey(arg);
    if (k === undefined) return false;
    const type = typeof k === 'number' ? 'number' : 'string';
    if (range === null) {
      range = { field, get, kind: 'range', type };
      plan.conds.push(range);
    } else if (range.type !== type) return false;
    const r = range as Cnd;
    const key = op === '$gt' ? 'gt' : op === '$gte' ? 'gte' : op === '$lt' ? 'lt' : 'lte';
    const cur = r[key];
    r[key] = cur === undefined ? k : op === '$gt' || op === '$gte' ? (k > cur ? k : cur) : k < cur ? k : cur;
    return true;
  };
  const fn = (test: (x: unknown) => boolean) => plan.conds.push({ field, get, kind: 'fn', test });

  for (const [op, arg] of Object.entries(ops) as [string, unknown][]) {
    switch (op) {
      case '$eq':
        plan.conds.push(eqCond(field, get, arg));
        break;
      case '$ne':
        if (isPrimitive(arg) || arg === undefined) {
          const v = norm(arg);
          fn((x) => norm(x) !== v);
        } else fn((x) => !deepEqual(x, arg));
        break;
      case '$aeq':
        // eslint-disable-next-line eqeqeq
        fn((x) => x == (arg as never));
        break;
      case '$dteq': {
        const t = asTime(arg);
        fn((x) => asTime(x) === t);
        break;
      }
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        if (!bound(op, arg)) return false;
        break;
      case '$between': {
        if (!Array.isArray(arg) || arg.length !== 2) throw new Error('$between takes [low, high]');
        if (!bound('$gte', arg[0]) || !bound('$lte', arg[1])) return false;
        break;
      }
      case '$in': {
        if (!Array.isArray(arg)) throw new Error('$in takes an array');
        const values = arg.map(norm);
        if (values.every(isPrimitive)) plan.conds.push({ field, get, kind: 'in', values, set: new Set(values) });
        else fn((x) => values.some((v) => deepEqual(x, v)));
        break;
      }
      case '$nin': {
        if (!Array.isArray(arg)) throw new Error('$nin takes an array');
        const values = arg.map(norm);
        if (values.every(isPrimitive)) {
          const set = new Set<unknown>(values);
          fn((x) => !set.has(norm(x)));
        } else fn((x) => !values.some((v) => deepEqual(x, v)));
        break;
      }
      case '$keyin':
        fn((x) => (typeof x === 'string' || typeof x === 'number') && x in (arg as object));
        break;
      case '$nkeyin':
        fn((x) => !((typeof x === 'string' || typeof x === 'number') && x in (arg as object)));
        break;
      case '$definedin':
        fn((x) => (typeof x === 'string' || typeof x === 'number') && (arg as Record<string, unknown>)[x] !== undefined);
        break;
      case '$undefinedin':
        fn((x) => !((typeof x === 'string' || typeof x === 'number') && (arg as Record<string, unknown>)[x] !== undefined));
        break;
      case '$regex':
        plan.conds.push(regexCond(field, get, arg));
        break;
      case '$contains': {
        const list = asList(arg);
        fn((x) => list.every((v) => containsOne(x, v)));
        break;
      }
      case '$containsAny': {
        const list = asList(arg);
        fn((x) => list.some((v) => containsOne(x, v)));
        break;
      }
      case '$containsNone': {
        const list = asList(arg);
        fn((x) => !list.some((v) => containsOne(x, v)));
        break;
      }
      case '$containsString':
        fn((x) => typeof x === 'string' && typeof arg === 'string' && x.includes(arg));
        break;
      case '$type':
        fn((x) => typeOf(x) === arg);
        break;
      case '$finite':
        fn((x) => (typeof x === 'number' && Number.isFinite(x)) === Boolean(arg));
        break;
      case '$size':
      case '$len':
        fn((x) => (Array.isArray(x) || typeof x === 'string') && x.length === arg);
        break;
      case '$exists':
        fn((x) => (x !== undefined) === Boolean(arg));
        break;
      case '$jgt':
        fn((x) => (x as number) > (arg as number));
        break;
      case '$jgte':
        fn((x) => (x as number) >= (arg as number));
        break;
      case '$jlt':
        fn((x) => (x as number) < (arg as number));
        break;
      case '$jlte':
        fn((x) => (x as number) <= (arg as number));
        break;
      case '$jbetween': {
        if (!Array.isArray(arg) || arg.length !== 2) throw new Error('$jbetween takes [low, high]');
        fn((x) => (x as number) >= (arg[0] as number) && (x as number) <= (arg[1] as number));
        break;
      }
      case '$not': {
        const inner = compile({ [field]: arg });
        if (inner === null) break; // not (nothing) is everything
        if (isEmpty(inner)) return false;
        plan.preds.push((d) => !testPlan(inner, d));
        break;
      }
      default:
        throw new Error(`Unknown operator ${op} on ${field}`);
    }
  }
  return true;
}

// ---- testing -----------------------------------------------------------------------------------

export function testCond(c: Cnd, d: Doc): boolean {
  const x = c.get(d);
  switch (c.kind) {
    case 'eq':
      return norm(x) === c.value;
    case 'in':
      return c.set!.has(norm(x));
    case 'fn':
      return c.test!(x);
    case 'range': {
      let k: number | string;
      if (c.type === 'number') {
        if (typeof x === 'number') k = x;
        else if (x instanceof Date) k = x.getTime();
        else return false;
        if (Number.isNaN(k)) return false;
      } else {
        if (typeof x !== 'string') return false;
        k = x;
      }
      if (c.gt !== undefined && !(k > c.gt)) return false;
      if (c.gte !== undefined && !(k >= c.gte)) return false;
      if (c.lt !== undefined && !(k < c.lt)) return false;
      if (c.lte !== undefined && !(k <= c.lte)) return false;
      return true;
    }
  }
}

/** Whether a document satisfies a plan, optionally leaving out a condition or `$or` that was already answered by an index. */
export function testPlan(plan: Plan, d: Doc, skipCond?: Cnd | null, skipOr?: Plan[] | null): boolean {
  const { conds, preds, ors } = plan;
  for (let i = 0; i < conds.length; i++) {
    const c = conds[i]!;
    if (c !== skipCond && !testCond(c, d)) return false;
  }
  for (let i = 0; i < preds.length; i++) if (!preds[i]!(d)) return false;
  for (let i = 0; i < ors.length; i++) {
    const branches = ors[i]!;
    if (branches === skipOr) continue;
    let any = false;
    for (let j = 0; j < branches.length && !any; j++) any = testPlan(branches[j]!, d);
    if (!any) return false;
  }
  return true;
}

/**
 * The first `k` of `docs` in `cmp` order, without sorting all of them: one pass, with an insertion only for a document
 * that beats the current k-th. Ties keep their original order, as a stable sort would.
 */
export function topK(docs: Doc[], cmp: (a: Doc, b: Doc) => number, k: number): Doc[] {
  const best: Doc[] = [];
  let n = 0;
  for (let j = 0; j < docs.length; j++) {
    const d = docs[j]!;
    if (n === k && cmp(d, best[k - 1]!) >= 0) continue;
    // Binary search for the slot after any equal documents, then shift the worse ones down by hand (k is small).
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmp(d, best[mid]!) < 0) hi = mid;
      else lo = mid + 1;
    }
    const end = n === k ? k - 1 : n;
    for (let m = end; m > lo; m--) best[m] = best[m - 1]!;
    best[lo] = d;
    if (n < k) n++;
  }
  return best;
}

/** Whether the documents already come in (nearly) `cmp` order or (nearly) the reverse, which a stable sort then handles in one pass. */
export function mostlyOrdered(docs: Doc[], cmp: (a: Doc, b: Doc) => number): boolean {
  const n = Math.min(docs.length - 1, 512);
  let down = 0;
  for (let i = 0; i < n; i++) if (cmp(docs[i]!, docs[i + 1]!) > 0) down++;
  return down * 8 < n || down * 8 > n * 7;
}
