/**
 * A sorted list of (value, order) keys, each pointing at a document, kept in fixed-size blocks.
 *
 * Loki keeps one big sorted array and splices into it, which costs O(n) per insert or delete. Here an insert shifts at
 * most one block (1,024 entries, a single memmove) and finding a position is two binary searches, so the cost stays
 * flat as the collection grows. A value can repeat (every document inserted in one batch may share a timestamp), so
 * entries are ordered by value and then by an insertion counter, which makes every entry exactly addressable.
 */
const CAP = 1024;
const HALF = CAP / 2;

class Block {
  n = 0;
  readonly v = new Float64Array(CAP);
  readonly o = new Float64Array(CAP);
  readonly d: unknown[] = new Array<unknown>(CAP);
}

export class OrderedList<T> {
  private blocks: Block[] = [];
  size = 0;

  /** Build from entries already sorted by (value, order). Much faster than inserting one by one. */
  static fromSorted<T>(entries: { v: number; o: number; d: T }[]): OrderedList<T> {
    const list = new OrderedList<T>();
    const fill = 768; // leave room to grow
    for (let i = 0; i < entries.length; i += fill) {
      const b = new Block();
      const end = Math.min(entries.length, i + fill);
      for (let j = i; j < end; j++) {
        const e = entries[j]!;
        b.v[b.n] = e.v;
        b.o[b.n] = e.o;
        b.d[b.n] = e.d;
        b.n++;
      }
      list.blocks.push(b);
    }
    list.size = entries.length;
    return list;
  }

  /** Smallest value, or undefined when empty. */
  min(): number | undefined {
    const b = this.blocks[0];
    return b ? b.v[0] : undefined;
  }

  /** Largest value, or undefined when empty. */
  max(): number | undefined {
    const b = this.blocks[this.blocks.length - 1];
    return b ? b.v[b.n - 1] : undefined;
  }

  insert(v: number, o: number, d: T): void {
    const blocks = this.blocks;
    if (blocks.length === 0) blocks.push(new Block());
    // Most inserts (revisions, timestamps) go at the end.
    let bi = blocks.length - 1;
    const last = blocks[bi]!;
    if (last.n === 0 || v > last.v[last.n - 1]! || (v === last.v[last.n - 1]! && o > last.o[last.n - 1]!)) {
      if (last.n === CAP) {
        const fresh = new Block();
        blocks.push(fresh);
        bi++;
        this.put(fresh, 0, v, o, d);
      } else this.put(last, last.n, v, o, d);
      this.size++;
      return;
    }
    bi = this.blockFor(v, o);
    let b = blocks[bi]!;
    if (b.n === CAP) {
      const right = new Block();
      right.v.set(b.v.subarray(HALF, CAP));
      right.o.set(b.o.subarray(HALF, CAP));
      for (let i = HALF; i < CAP; i++) {
        right.d[i - HALF] = b.d[i];
        b.d[i] = undefined;
      }
      right.n = CAP - HALF;
      b.n = HALF;
      blocks.splice(bi + 1, 0, right);
      if (v > b.v[b.n - 1]! || (v === b.v[b.n - 1]! && o > b.o[b.n - 1]!)) b = right;
    }
    this.put(b, this.indexIn(b, v, o), v, o, d);
    this.size++;
  }

  /** Remove the entry with exactly this key. Returns false if there is none. */
  remove(v: number, o: number): boolean {
    const bi = this.blockFor(v, o);
    const b = this.blocks[bi];
    if (!b) return false;
    const i = this.indexIn(b, v, o);
    if (i >= b.n || b.v[i] !== v || b.o[i] !== o) return false;
    b.v.copyWithin(i, i + 1, b.n);
    b.o.copyWithin(i, i + 1, b.n);
    b.d.copyWithin(i, i + 1, b.n);
    b.n--;
    b.d[b.n] = undefined;
    if (b.n === 0) this.blocks.splice(bi, 1);
    this.size--;
    return true;
  }

  /** Number of entries whose value is below `v` (or at most `v` when `inclusive`). */
  rank(v: number, inclusive: boolean): number {
    const { bi, i } = this.bound(v, inclusive);
    let n = i;
    for (let k = 0; k < bi; k++) n += this.blocks[k]!.n;
    return n;
  }

  /** Entries with `lo <= value <= hi` (each end optional, exclusive if its flag is set), appended in order. */
  range(lo: number | undefined, loExclusive: boolean, hi: number | undefined, hiExclusive: boolean, out: T[]): void {
    const start = lo === undefined ? { bi: 0, i: 0 } : this.bound(lo, loExclusive);
    const end = hi === undefined ? { bi: this.blocks.length, i: 0 } : this.bound(hi, !hiExclusive);
    for (let bi = start.bi; bi <= end.bi && bi < this.blocks.length; bi++) {
      const b = this.blocks[bi]!;
      const from = bi === start.bi ? start.i : 0;
      const to = bi === end.bi ? end.i : b.n;
      for (let i = from; i < to; i++) out.push(b.d[i] as T);
    }
  }

  /**
   * Visit entries with `lo <= value <= hi` in order (descending when `desc`), until `fn` returns false. Reading only as
   * far as needed is what makes "the newest 50" cost 50 and not the size of the collection.
   */
  walk(lo: number | undefined, loExclusive: boolean, hi: number | undefined, hiExclusive: boolean, desc: boolean, fn: (d: T) => boolean | void): void {
    const start = lo === undefined ? { bi: 0, i: 0 } : this.bound(lo, loExclusive);
    const end = hi === undefined ? { bi: this.blocks.length, i: 0 } : this.bound(hi, !hiExclusive);
    if (!desc) {
      for (let bi = start.bi; bi <= end.bi && bi < this.blocks.length; bi++) {
        const b = this.blocks[bi]!;
        const to = bi === end.bi ? end.i : b.n;
        for (let i = bi === start.bi ? start.i : 0; i < to; i++) if (fn(b.d[i] as T) === false) return;
      }
      return;
    }
    for (let bi = Math.min(end.bi, this.blocks.length - 1); bi >= start.bi; bi--) {
      const b = this.blocks[bi]!;
      const from = bi === start.bi ? start.i : 0;
      for (let i = (bi === end.bi ? end.i : b.n) - 1; i >= from; i--) if (fn(b.d[i] as T) === false) return;
    }
  }

  countRange(lo: number | undefined, loExclusive: boolean, hi: number | undefined, hiExclusive: boolean): number {
    const from = lo === undefined ? 0 : this.rank(lo, loExclusive);
    const to = hi === undefined ? this.size : this.rank(hi, !hiExclusive);
    return Math.max(0, to - from);
  }

  // ---- internals --------------------------------------------------------------------------------

  private put(b: Block, i: number, v: number, o: number, d: T): void {
    if (i < b.n) {
      b.v.copyWithin(i + 1, i, b.n);
      b.o.copyWithin(i + 1, i, b.n);
      b.d.copyWithin(i + 1, i, b.n);
    }
    b.v[i] = v;
    b.o[i] = o;
    b.d[i] = d;
    b.n++;
  }

  /** The first block whose last key is at or after (v, o): where that key belongs. */
  private blockFor(v: number, o: number): number {
    let lo = 0;
    let hi = this.blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const b = this.blocks[mid]!;
      const lv = b.v[b.n - 1]!;
      if (lv < v || (lv === v && b.o[b.n - 1]! < o)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private indexIn(b: Block, v: number, o: number): number {
    let lo = 0;
    let hi = b.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const mv = b.v[mid]!;
      if (mv < v || (mv === v && b.o[mid]! < o)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Position of the first entry with value >= v (or > v when `after`). */
  private bound(v: number, after: boolean): { bi: number; i: number } {
    const blocks = this.blocks;
    let lo = 0;
    let hi = blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const b = blocks[mid]!;
      const lv = b.v[b.n - 1]!;
      if (after ? lv <= v : lv < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo === blocks.length) return { bi: lo, i: 0 };
    const b = blocks[lo]!;
    let l = 0;
    let h = b.n;
    while (l < h) {
      const mid = (l + h) >> 1;
      const mv = b.v[mid]!;
      if (after ? mv <= v : mv < v) l = mid + 1;
      else h = mid;
    }
    return { bi: lo, i: l };
  }
}


class SBlock {
  n = 0;
  readonly v: string[] = new Array<string>(CAP).fill('');
  readonly o = new Float64Array(CAP);
  readonly d: unknown[] = new Array<unknown>(CAP);
}

/** The same structure for string keys (compared by code unit, as `<` does). */
export class StringList<T> {
  private blocks: SBlock[] = [];
  size = 0;

  /** Build from entries already sorted by (value, order). Much faster than inserting one by one. */
  static fromSorted<T>(entries: { v: string; o: number; d: T }[]): StringList<T> {
    const list = new StringList<T>();
    const fill = 768; // leave room to grow
    for (let i = 0; i < entries.length; i += fill) {
      const b = new SBlock();
      const end = Math.min(entries.length, i + fill);
      for (let j = i; j < end; j++) {
        const e = entries[j]!;
        b.v[b.n] = e.v;
        b.o[b.n] = e.o;
        b.d[b.n] = e.d;
        b.n++;
      }
      list.blocks.push(b);
    }
    list.size = entries.length;
    return list;
  }

  /** Smallest value, or undefined when empty. */
  min(): string | undefined {
    const b = this.blocks[0];
    return b ? b.v[0] : undefined;
  }

  /** Largest value, or undefined when empty. */
  max(): string | undefined {
    const b = this.blocks[this.blocks.length - 1];
    return b ? b.v[b.n - 1] : undefined;
  }

  insert(v: string, o: number, d: T): void {
    const blocks = this.blocks;
    if (blocks.length === 0) blocks.push(new SBlock());
    // Most inserts (revisions, timestamps) go at the end.
    let bi = blocks.length - 1;
    const last = blocks[bi]!;
    if (last.n === 0 || v > last.v[last.n - 1]! || (v === last.v[last.n - 1]! && o > last.o[last.n - 1]!)) {
      if (last.n === CAP) {
        const fresh = new SBlock();
        blocks.push(fresh);
        bi++;
        this.put(fresh, 0, v, o, d);
      } else this.put(last, last.n, v, o, d);
      this.size++;
      return;
    }
    bi = this.blockFor(v, o);
    let b = blocks[bi]!;
    if (b.n === CAP) {
      const right = new SBlock();
      for (let i = HALF; i < CAP; i++) right.v[i - HALF] = b.v[i]!;
      right.o.set(b.o.subarray(HALF, CAP));
      for (let i = HALF; i < CAP; i++) {
        right.d[i - HALF] = b.d[i];
        b.d[i] = undefined;
      }
      right.n = CAP - HALF;
      b.n = HALF;
      blocks.splice(bi + 1, 0, right);
      if (v > b.v[b.n - 1]! || (v === b.v[b.n - 1]! && o > b.o[b.n - 1]!)) b = right;
    }
    this.put(b, this.indexIn(b, v, o), v, o, d);
    this.size++;
  }

  /** Remove the entry with exactly this key. Returns false if there is none. */
  remove(v: string, o: number): boolean {
    const bi = this.blockFor(v, o);
    const b = this.blocks[bi];
    if (!b) return false;
    const i = this.indexIn(b, v, o);
    if (i >= b.n || b.v[i] !== v || b.o[i] !== o) return false;
    b.v.copyWithin(i, i + 1, b.n);
    b.o.copyWithin(i, i + 1, b.n);
    b.d.copyWithin(i, i + 1, b.n);
    b.n--;
    b.d[b.n] = undefined;
    if (b.n === 0) this.blocks.splice(bi, 1);
    this.size--;
    return true;
  }

  /** Number of entries whose value is below `v` (or at most `v` when `inclusive`). */
  rank(v: string, inclusive: boolean): number {
    const { bi, i } = this.bound(v, inclusive);
    let n = i;
    for (let k = 0; k < bi; k++) n += this.blocks[k]!.n;
    return n;
  }

  /** Entries with `lo <= value <= hi` (each end optional, exclusive if its flag is set), appended in order. */
  range(lo: string | undefined, loExclusive: boolean, hi: string | undefined, hiExclusive: boolean, out: T[]): void {
    const start = lo === undefined ? { bi: 0, i: 0 } : this.bound(lo, loExclusive);
    const end = hi === undefined ? { bi: this.blocks.length, i: 0 } : this.bound(hi, !hiExclusive);
    for (let bi = start.bi; bi <= end.bi && bi < this.blocks.length; bi++) {
      const b = this.blocks[bi]!;
      const from = bi === start.bi ? start.i : 0;
      const to = bi === end.bi ? end.i : b.n;
      for (let i = from; i < to; i++) out.push(b.d[i] as T);
    }
  }

  /**
   * Visit entries with `lo <= value <= hi` in order (descending when `desc`), until `fn` returns false. Reading only as
   * far as needed is what makes "the newest 50" cost 50 and not the size of the collection.
   */
  walk(lo: string | undefined, loExclusive: boolean, hi: string | undefined, hiExclusive: boolean, desc: boolean, fn: (d: T) => boolean | void): void {
    const start = lo === undefined ? { bi: 0, i: 0 } : this.bound(lo, loExclusive);
    const end = hi === undefined ? { bi: this.blocks.length, i: 0 } : this.bound(hi, !hiExclusive);
    if (!desc) {
      for (let bi = start.bi; bi <= end.bi && bi < this.blocks.length; bi++) {
        const b = this.blocks[bi]!;
        const to = bi === end.bi ? end.i : b.n;
        for (let i = bi === start.bi ? start.i : 0; i < to; i++) if (fn(b.d[i] as T) === false) return;
      }
      return;
    }
    for (let bi = Math.min(end.bi, this.blocks.length - 1); bi >= start.bi; bi--) {
      const b = this.blocks[bi]!;
      const from = bi === start.bi ? start.i : 0;
      for (let i = (bi === end.bi ? end.i : b.n) - 1; i >= from; i--) if (fn(b.d[i] as T) === false) return;
    }
  }

  countRange(lo: string | undefined, loExclusive: boolean, hi: string | undefined, hiExclusive: boolean): number {
    const from = lo === undefined ? 0 : this.rank(lo, loExclusive);
    const to = hi === undefined ? this.size : this.rank(hi, !hiExclusive);
    return Math.max(0, to - from);
  }

  // ---- internals --------------------------------------------------------------------------------

  private put(b: SBlock, i: number, v: string, o: number, d: T): void {
    if (i < b.n) {
      b.v.copyWithin(i + 1, i, b.n);
      b.o.copyWithin(i + 1, i, b.n);
      b.d.copyWithin(i + 1, i, b.n);
    }
    b.v[i] = v;
    b.o[i] = o;
    b.d[i] = d;
    b.n++;
  }

  /** The first block whose last key is at or after (v, o): where that key belongs. */
  private blockFor(v: string, o: number): number {
    let lo = 0;
    let hi = this.blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const b = this.blocks[mid]!;
      const lv = b.v[b.n - 1]!;
      if (lv < v || (lv === v && b.o[b.n - 1]! < o)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private indexIn(b: SBlock, v: string, o: number): number {
    let lo = 0;
    let hi = b.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const mv = b.v[mid]!;
      if (mv < v || (mv === v && b.o[mid]! < o)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Position of the first entry with value >= v (or > v when `after`). */
  private bound(v: string, after: boolean): { bi: number; i: number } {
    const blocks = this.blocks;
    let lo = 0;
    let hi = blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const b = blocks[mid]!;
      const lv = b.v[b.n - 1]!;
      if (after ? lv <= v : lv < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo === blocks.length) return { bi: lo, i: 0 };
    const b = blocks[lo]!;
    let l = 0;
    let h = b.n;
    while (l < h) {
      const mid = (l + h) >> 1;
      const mv = b.v[mid]!;
      if (after ? mv <= v : mv < v) l = mid + 1;
      else h = mid;
    }
    return { bi: lo, i: l };
  }
}
