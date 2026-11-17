import { describe, expect, it } from 'vitest';
import { Docstore, NotFoundError, UniqueViolation } from '../src/index.js';

interface Item {
  id: string;
  name: string;
  group?: string | null;
  n?: number;
  tags?: string[];
}

const open = async () => Docstore.open(null);
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('collection', () => {
  it('inserts, reads back, replaces and removes', async () => {
    const col = (await open()).collection<Item>('items');
    const a = col.insert({ name: 'a' });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(col.get(a.id)).toBe(a); // the same object comes back
    a.name = 'a2';
    col.update(a);
    expect(col.get(a.id)!.name).toBe('a2');
    col.update({ id: a.id, name: 'replaced' }); // a different object with the same id
    expect(col.get(a.id)!.name).toBe('replaced');
    expect(col.size).toBe(1);
    col.remove(a.id);
    expect(col.get(a.id)).toBeUndefined();
    expect(() => col.update({ id: 'nope', name: 'x' })).toThrow(NotFoundError);
    expect(() => col.insert({ id: 'dup', name: 'x' }) && col.insert({ id: 'dup', name: 'y' })).toThrow(UniqueViolation);
  });

  it('enforces unique fields, allows empty values, and lets an update keep its own value', async () => {
    const col = (await open()).collection<Item>('items', { unique: ['name'] });
    const a = col.insert({ name: 'a' });
    expect(() => col.insert({ name: 'a' })).toThrow(UniqueViolation);
    col.insert({ name: undefined as never });
    col.insert({ name: null as never });
    col.update(a); // unchanged
    const b = col.insert({ name: 'b' });
    b.name = 'a';
    expect(() => col.update(b)).toThrow(UniqueViolation);
    b.name = 'c';
    col.update(b);
    col.insert({ name: 'b' }); // b's old value is free again
  });

  it('answers equality, any-of, not-equal and range queries', async () => {
    const col = (await open()).collection<Item>('items', { indexed: ['group'], ordered: ['n'] });
    for (let i = 0; i < 100; i++) col.insert({ id: `i${i}`, name: `n${i}`, group: i % 3 === 0 ? 'x' : i % 3 === 1 ? 'y' : null, n: i % 10 });
    col.insert({ id: 'nogroup', name: 'z' }); // no group, no n
    expect(col.find({ group: 'x' })).toHaveLength(34);
    expect(col.find({ group: 'x', n: 0 }).map((d) => d.id).sort()).toEqual(['i0', 'i30', 'i60', 'i90']);
    expect(col.find({ group: { $in: ['x', 'y'] } })).toHaveLength(67);
    expect(col.find({ group: null })).toHaveLength(34); // 33 null + the one with none
    expect(col.find({ group: { $ne: 'x' } })).toHaveLength(67);
    expect(col.find({ n: { $gt: 7 } })).toHaveLength(20);
    expect(col.find({ n: { $gte: 8, $lt: 9 } })).toHaveLength(10);
    expect(col.find({ n: { $gt: 100 } })).toEqual([]);
    expect(col.find({ id: { $in: ['i1', 'i2', 'nope'] } }).map((d) => d.id)).toEqual(['i1', 'i2']);
    expect(col.findOne({ name: 'n42' })!.id).toBe('i42'); // no index: scanned
    expect(col.findOne({ name: 'missing' })).toBeNull();
    expect(col.count({ group: 'y' })).toBe(33);
    expect(col.count({ n: { $gte: 5 } })).toBe(50);
    expect(col.count({ group: 'x', n: 0 })).toBe(4);
    expect(col.count()).toBe(101);
    expect(col.max('n')).toBe(9);
    expect(col.where((d) => d.name.endsWith('9')).length).toBe(10);
    expect(() => col.find({ n: { $bogus: 1 } as never })).toThrow(/Unknown operator/);
  });

  it('keeps indexes right when an indexed field changes, on the same object or a replacement', async () => {
    const col = (await open()).collection<Item>('items', { indexed: ['group'], ordered: ['n'] });
    const a = col.insert({ id: 'a', name: 'a', group: 'x', n: 1 });
    a.group = 'y';
    a.n = 50;
    col.update(a);
    expect(col.find({ group: 'x' })).toEqual([]);
    expect(col.find({ group: 'y' })).toEqual([a]);
    expect(col.find({ n: 1 })).toEqual([]);
    expect(col.find({ n: { $gt: 10 } })).toEqual([a]);
    const copy: Item = { id: 'a', name: 'a', group: 'z', n: 2 };
    col.update(copy);
    expect(col.find({ group: 'y' })).toEqual([]);
    expect(col.find({ group: 'z' })).toEqual([copy]);
    expect(col.get('a')).toBe(copy);
    copy.n = undefined;
    col.update(copy);
    expect(col.find({ n: { $gte: 0 } })).toEqual([]);
    col.remove(copy);
    expect(col.find({ group: 'z' })).toEqual([]);
    expect(col.count()).toBe(0);
  });

  it('does not leak its bookkeeping into copies or JSON', async () => {
    const col = (await open()).collection<Item>('items', { indexed: ['group'] });
    const a = col.insert({ name: 'a', group: 'x' });
    expect(Object.keys(a).sort()).toEqual(['group', 'id', 'name']);
    expect({ ...a }).toEqual(JSON.parse(JSON.stringify(a)));
    expect(Object.getOwnPropertySymbols({ ...a })).toEqual([]);
  });

  it('removeWhere removes what matches', async () => {
    const col = (await open()).collection<Item>('items', { indexed: ['group'] });
    for (let i = 0; i < 20; i++) col.insert({ name: `n${i}`, group: i % 2 ? 'odd' : 'even' });
    expect(col.removeWhere((d) => d.group === 'odd')).toBe(10);
    expect(col.find({ group: 'odd' })).toEqual([]);
    expect(col.count()).toBe(10);
  });

  it('agrees with a plain scan across thousands of random changes and queries', async () => {
    const r = rng(42);
    const col = (await open()).collection<Item>('items', { unique: ['name'], indexed: ['group'], ordered: ['n'] });
    const groups = ['a', 'b', 'c', 'd', null, undefined];
    let nextName = 0;
    const live = new Map<string, Item>();
    const naive = (q: { group?: unknown; n?: { $gt?: number; $lte?: number }; groups?: (string | null)[] }) =>
      [...live.values()].filter((d) => {
        if ('group' in q && (d.group ?? null) !== (q.group ?? null)) return false;
        if (q.groups && !q.groups.includes((d.group ?? null) as never)) return false;
        if (q.n) {
          if (typeof d.n !== 'number') return false;
          if (q.n.$gt !== undefined && !(d.n > q.n.$gt)) return false;
          if (q.n.$lte !== undefined && !(d.n <= q.n.$lte)) return false;
        }
        return true;
      });
    const ids = (l: Item[]) => l.map((d) => d.id).sort();
    for (let step = 0; step < 6000; step++) {
      const roll = r();
      const pickId = () => [...live.keys()][Math.floor(r() * live.size)]!;
      if (roll < 0.45 || live.size === 0) {
        const d = col.insert({ name: `n${nextName++}`, group: groups[Math.floor(r() * groups.length)] as never, n: r() < 0.9 ? Math.floor(r() * 50) : undefined });
        live.set(d.id, d);
      } else if (roll < 0.7) {
        const d = live.get(pickId())!;
        d.group = groups[Math.floor(r() * groups.length)] as never;
        d.n = r() < 0.9 ? Math.floor(r() * 50) : undefined;
        col.update(d);
      } else if (roll < 0.85) {
        const old = live.get(pickId())!;
        const d = { ...old, group: groups[Math.floor(r() * groups.length)] as never, n: Math.floor(r() * 50) };
        col.update(d);
        live.set(d.id, d);
      } else {
        const d = live.get(pickId())!;
        col.remove(d);
        live.delete(d.id);
      }
      if (step % 100 === 0) {
        expect(col.size).toBe(live.size);
        for (const g of ['a', 'b', 'c', 'd', null]) {
          expect(ids(col.find({ group: g as never }))).toEqual(ids(naive({ group: g })));
          expect(col.count({ group: g as never })).toBe(naive({ group: g }).length);
        }
        expect(ids(col.find({ group: { $in: ['a', 'c', null] } }))).toEqual(ids(naive({ groups: ['a', 'c', null] })));
        for (let q = 0; q < 10; q++) {
          const gt = Math.floor(r() * 50);
          const le = gt + Math.floor(r() * 20);
          expect(ids(col.find({ n: { $gt: gt, $lte: le } }))).toEqual(ids(naive({ n: { $gt: gt, $lte: le } })));
          expect(ids(col.find({ group: 'b', n: { $gt: gt } }))).toEqual(ids(naive({ group: 'b', n: { $gt: gt } })));
          expect(col.count({ n: { $gt: gt, $lte: le } })).toBe(naive({ n: { $gt: gt, $lte: le } }).length);
        }
      }
    }
  });
});
