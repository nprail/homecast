import { describe, expect, it } from 'vitest';
import { OrderedList, StringList } from '../src/ordered.js';

/** Deterministic random numbers so a failure can be replayed. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

interface Entry {
  v: number;
  o: number;
  d: number;
}
const cmp = (a: Entry, b: Entry) => a.v - b.v || a.o - b.o;

describe('OrderedList', () => {
  it('matches a plain sorted array through thousands of random inserts, removes and range queries', () => {
    const r = rng(7);
    const list = new OrderedList<number>();
    let model: Entry[] = [];
    let order = 0;
    for (let step = 0; step < 30_000; step++) {
      const roll = r();
      if (roll < 0.6 || model.length === 0) {
        // Few distinct values, so there are many ties.
        const e = { v: Math.floor(r() * 400), o: order++, d: step };
        list.insert(e.v, e.o, e.d);
        model.push(e);
        model.sort(cmp);
      } else {
        const i = Math.floor(r() * model.length);
        const e = model[i]!;
        expect(list.remove(e.v, e.o)).toBe(true);
        model.splice(i, 1);
      }
      if (step % 500 === 0) {
        expect(list.size).toBe(model.length);
        expect(list.max()).toBe(model.length ? model[model.length - 1]!.v : undefined);
        for (let q = 0; q < 20; q++) {
          const a = Math.floor(r() * 420) - 10;
          const b = a + Math.floor(r() * 80);
          for (const [loEx, hiEx] of [[false, false], [true, false], [false, true], [true, true]] as const) {
            const want = model.filter((e) => (loEx ? e.v > a : e.v >= a) && (hiEx ? e.v < b : e.v <= b)).map((e) => e.d);
            const got: number[] = [];
            list.range(a, loEx, b, hiEx, got);
            expect(got).toEqual(want);
            expect(list.countRange(a, loEx, b, hiEx)).toBe(want.length);
          }
          expect(list.countRange(a, true, undefined, false)).toBe(model.filter((e) => e.v > a).length);
          expect(list.countRange(undefined, false, b, true)).toBe(model.filter((e) => e.v < b).length);
          expect(list.rank(a, false)).toBe(model.filter((e) => e.v < a).length);
          expect(list.rank(a, true)).toBe(model.filter((e) => e.v <= a).length);
        }
      }
    }
    // Remove everything.
    for (const e of model) expect(list.remove(e.v, e.o)).toBe(true);
    expect(list.size).toBe(0);
    expect(list.max()).toBeUndefined();
    expect(list.remove(1, 1)).toBe(false);
  });

  it('appends in order cheaply and builds from a sorted array', () => {
    const list = new OrderedList<number>();
    for (let i = 0; i < 100_000; i++) list.insert(i, i, i);
    expect(list.size).toBe(100_000);
    expect(list.countRange(99_000, true, undefined, false)).toBe(999);
    const built = OrderedList.fromSorted(Array.from({ length: 50_000 }, (_, i) => ({ v: Math.floor(i / 3), o: i, d: i })));
    expect(built.size).toBe(50_000);
    expect(built.countRange(10, false, 10, false)).toBe(3);
    built.insert(10, 999_999, -1); // grows from a built list too
    expect(built.countRange(10, false, 10, false)).toBe(4);
  });

  it('keeps entries with the same value apart, in insertion order', () => {
    const list = new OrderedList<string>();
    for (let i = 0; i < 5000; i++) list.insert(5, i, `d${i}`);
    expect(list.remove(5, 2500)).toBe(true);
    expect(list.remove(5, 2500)).toBe(false);
    const got: string[] = [];
    list.range(5, false, 5, false, got);
    expect(got).toHaveLength(4999);
    expect(got[0]).toBe('d0');
    expect(got[2500]).toBe('d2501');
  });
});

describe('walk and StringList', () => {
  it('walks ranges in both directions and stops when told to', () => {
    const list = new OrderedList<number>();
    for (let i = 0; i < 5000; i++) list.insert(Math.floor(i / 3), i, i); // many blocks, ties of three
    const up: number[] = [];
    list.walk(100, false, 200, true, false, (d) => void up.push(d));
    expect(up[0]).toBe(300);
    expect(up.length).toBe(300);
    const down: number[] = [];
    list.walk(100, false, 200, true, true, (d) => void down.push(d));
    expect(down).toEqual([...up].reverse());
    const first: number[] = [];
    list.walk(undefined, false, undefined, false, true, (d) => (first.push(d), first.length < 5));
    expect(first).toEqual([4999, 4998, 4997, 4996, 4995]);
    const none: number[] = [];
    list.walk(10_000, false, undefined, false, false, (d) => void none.push(d));
    expect(none).toEqual([]);
    expect(list.min()).toBe(0);
    expect(list.max()).toBe(1666);
  });

  it('keeps strings in order through random inserts and removes, with ranges, counts and walks', () => {
    const r = rng(11);
    const list = new StringList<number>();
    let model: { v: string; o: number; d: number }[] = [];
    const word = () => 'abcde'.charAt(Math.floor(r() * 5)) + String(Math.floor(r() * 30)).padStart(2, '0');
    let order = 0;
    for (let step = 0; step < 20_000; step++) {
      if (r() < 0.6 || model.length === 0) {
        const e = { v: word(), o: order++, d: step };
        list.insert(e.v, e.o, e.d);
        model.push(e);
        model.sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : a.o - b.o));
      } else {
        const i = Math.floor(r() * model.length);
        const [e] = model.splice(i, 1);
        expect(list.remove(e!.v, e!.o)).toBe(true);
      }
      if (step % 500 === 0) {
        const lo = word();
        const hi = word();
        const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
        const want = model.filter((e) => e.v > a && e.v <= b).map((e) => e.d);
        const got: number[] = [];
        list.range(a, true, b, false, got);
        expect(got).toEqual(want);
        expect(list.countRange(a, true, b, false)).toBe(want.length);
        const back: number[] = [];
        list.walk(a, true, b, false, true, (d) => void back.push(d));
        expect(back).toEqual([...want].reverse());
      }
    }
    expect(list.size).toBe(model.length);
    expect(list.max()).toBe(model[model.length - 1]!.v);
    expect(list.min()).toBe(model[0]!.v);
    model = [];
  });

  it('builds from sorted entries', () => {
    const entries = Array.from({ length: 3000 }, (_, i) => ({ v: String(i).padStart(5, '0'), o: i, d: i }));
    const list = StringList.fromSorted(entries);
    expect(list.size).toBe(3000);
    const got: number[] = [];
    list.range('00010', false, '00014', false, got);
    expect(got).toEqual([10, 11, 12, 13, 14]);
    list.insert('00012', 9999, -1);
    expect(list.countRange('00012', false, '00012', false)).toBe(2);
  });
});
