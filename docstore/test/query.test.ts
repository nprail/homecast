import { describe, expect, it } from 'vitest';
import { Docstore } from '../src/index.js';

interface P {
  id: string;
  name: string;
  age?: number | null;
  city?: string;
  tags?: string[];
  owner?: { name: string; level: number };
  at?: Date | number;
  active?: boolean;
  misc?: unknown;
}

const people = async (opts: { indexed?: string[]; ordered?: string[]; unique?: string[] } = {}) => {
  const col = (await Docstore.open(null)).collection<P>('people', opts);
  const rows: Omit<P, 'id'>[] = [
    { name: 'Maya', age: 31, city: 'Lyon', tags: ['a', 'b'], owner: { name: 'Zed', level: 3 }, active: true },
    { name: 'Noor', age: 25, city: 'Oslo', tags: ['b'], owner: { name: 'Yan', level: 1 }, active: false },
    { name: 'Omar', age: 40, city: 'Lyon', tags: [], owner: { name: 'Zed', level: 5 } },
    { name: 'Pia', age: null, city: 'Paris', tags: ['a', 'c', 'b'] },
    { name: 'Quin', city: 'oslo', misc: { k: 1 } },
    { name: 'Rae', age: 25, city: 'Paris', tags: ['c'], misc: [1, 2] },
  ];
  for (const r of rows) col.insert({ id: r.name.toLowerCase(), ...r });
  return col;
};
const names = (xs: P[]) => xs.map((d) => d.name).sort();

describe('operators', () => {
  it('compares: $eq $ne $gt $gte $lt $lte $between, on numbers and on strings', async () => {
    const col = await people();
    expect(names(col.find({ age: { $eq: 25 } }))).toEqual(['Noor', 'Rae']);
    expect(names(col.find({ age: { $ne: 25 } }))).toEqual(['Maya', 'Omar', 'Pia', 'Quin']);
    expect(names(col.find({ age: { $gt: 25, $lt: 40 } }))).toEqual(['Maya']);
    expect(names(col.find({ age: { $gte: 25, $lte: 31 } }))).toEqual(['Maya', 'Noor', 'Rae']);
    expect(names(col.find({ age: { $between: [25, 31] } }))).toEqual(['Maya', 'Noor', 'Rae']);
    expect(names(col.find({ city: { $gt: 'Oslo' } }))).toEqual(['Pia', 'Quin', 'Rae']); // strings compare as strings, 'oslo' > 'Oslo'
    expect(names(col.find({ city: { $between: ['Lyon', 'Oslo'] } }))).toEqual(['Maya', 'Noor', 'Omar']);
    expect(col.find({ age: { $gt: 'a' as never } })).toEqual([]); // a string bound only matches strings
    expect(col.find({ age: { $gt: 1, $lt: 'z' as never } })).toEqual([]); // mixed bounds match nothing
  });

  it('answers the same with and without indexes', async () => {
    const plain = await people();
    const indexed = await people({ indexed: ['city'], ordered: ['age', 'city', 'owner.level'] });
    const queries = [
      { age: { $gte: 25, $lt: 40 } },
      { city: { $gt: 'Lyon', $lte: 'Oslo' } },
      { city: 'Lyon', age: { $gt: 30 } },
      { 'owner.level': { $gte: 3 } },
      { age: 25 },
      { age: null },
      { city: { $in: ['Lyon', 'Paris'] } },
    ];
    for (const q of queries) expect(names(indexed.find(q as never))).toEqual(names(plain.find(q as never)));
  });

  it('matches sets: $in $nin and $keyin $nkeyin $definedin $undefinedin', async () => {
    const col = await people();
    expect(names(col.find({ city: { $in: ['Oslo', 'Paris'] } }))).toEqual(['Noor', 'Pia', 'Rae']);
    expect(names(col.find({ city: { $nin: ['Oslo', 'Paris'] } }))).toEqual(['Maya', 'Omar', 'Quin']);
    expect(names(col.find({ age: { $in: [null] } }))).toEqual(['Pia', 'Quin']);
    const known = { Lyon: 1, Oslo: undefined };
    expect(names(col.find({ city: { $keyin: known } }))).toEqual(['Maya', 'Noor', 'Omar']);
    expect(names(col.find({ city: { $nkeyin: known } }))).toEqual(['Pia', 'Quin', 'Rae']);
    expect(names(col.find({ city: { $definedin: known } }))).toEqual(['Maya', 'Omar']);
    expect(names(col.find({ city: { $undefinedin: known } }))).toEqual(['Noor', 'Pia', 'Quin', 'Rae']);
  });

  it('matches text and containers: $regex $containsString $contains $containsAny $containsNone', async () => {
    const col = await people();
    expect(names(col.find({ city: { $regex: /^o/i } }))).toEqual(['Noor', 'Quin']);
    expect(names(col.find({ city: { $regex: '^O' } }))).toEqual(['Noor']);
    expect(names(col.find({ city: { $regex: ['^o', 'i'] } }))).toEqual(['Noor', 'Quin']);
    expect(names(col.find({ city: /ar/ }))).toEqual(['Pia', 'Rae']); // a RegExp as the whole condition
    const g = /ar/g; // a global RegExp is stateful in JS; here it must not be
    expect(names(col.find({ city: g }))).toEqual(['Pia', 'Rae']);
    expect(names(col.find({ city: g }))).toEqual(['Pia', 'Rae']);
    expect(names(col.find({ name: { $containsString: 'oo' } }))).toEqual(['Noor']);
    expect(names(col.find({ tags: { $contains: 'b' } }))).toEqual(['Maya', 'Noor', 'Pia']);
    expect(names(col.find({ tags: { $contains: ['a', 'b'] } }))).toEqual(['Maya', 'Pia']);
    expect(names(col.find({ tags: { $containsAny: ['a', 'c'] } }))).toEqual(['Maya', 'Pia', 'Rae']);
    expect(names(col.find({ tags: { $containsNone: ['a', 'b'] } }))).toEqual(['Omar', 'Quin', 'Rae']);
    expect(names(col.find({ name: { $contains: 'ay' } }))).toEqual(['Maya']); // a string contains a substring
  });

  it('checks shape: $type $exists $finite $size $len', async () => {
    const col = await people();
    expect(names(col.find({ tags: { $type: 'array' } }))).toEqual(['Maya', 'Noor', 'Omar', 'Pia', 'Rae']);
    expect(names(col.find({ age: { $type: 'null' } }))).toEqual(['Pia']);
    expect(names(col.find({ age: { $type: 'undefined' } }))).toEqual(['Quin']);
    expect(names(col.find({ misc: { $type: 'object' } }))).toEqual(['Quin']);
    expect(names(col.find({ owner: { $exists: true } }))).toEqual(['Maya', 'Noor', 'Omar']);
    expect(names(col.find({ owner: { $exists: false } }))).toEqual(['Pia', 'Quin', 'Rae']);
    expect(names(col.find({ age: { $finite: true } }))).toEqual(['Maya', 'Noor', 'Omar', 'Rae']);
    expect(names(col.find({ tags: { $size: 2 } }))).toEqual(['Maya']);
    expect(names(col.find({ name: { $len: 4 } }))).toEqual(['Maya', 'Noor', 'Omar', 'Quin']);
  });

  it('compares loosely and as dates: $aeq $dteq $jgt $jlt $jbetween', async () => {
    const col = await people();
    expect(names(col.find({ age: { $aeq: '25' } }))).toEqual(['Noor', 'Rae']);
    expect(names(col.find({ age: { $jgt: 30 } }))).toEqual(['Maya', 'Omar']);
    expect(names(col.find({ age: { $jbetween: [25, 31] } }))).toEqual(['Maya', 'Noor', 'Rae']);
    const d = (await Docstore.open(null)).collection<P>('d');
    d.insert({ id: 'a', name: 'a', at: new Date('2024-05-01T00:00:00Z') });
    d.insert({ id: 'b', name: 'b', at: new Date('2024-06-01T00:00:00Z').getTime() });
    d.insert({ id: 'c', name: 'c', at: '2024-05-01T00:00:00.000Z' as never }); // what a Date becomes after a reload
    expect(d.find({ at: { $dteq: new Date('2024-05-01T00:00:00Z') } }).map((x) => x.id).sort()).toEqual(['a', 'c']);
    expect(d.find({ at: { $dteq: '2024-06-01T00:00:00Z' } }).map((x) => x.id)).toEqual(['b']);
    expect(d.find({ at: new Date('2024-05-01T00:00:00Z') }).map((x) => x.id).sort()).toEqual(['a', 'c']);
  });

  it('compares dates and numbers as numbers on an ordered field', async () => {
    const col = (await Docstore.open(null)).collection<P>('d', { ordered: ['at'] });
    col.insert({ id: 'a', name: 'a', at: new Date('2024-05-01T00:00:00Z') });
    col.insert({ id: 'b', name: 'b', at: new Date('2024-06-01T00:00:00Z') });
    col.insert({ id: 'c', name: 'c', at: new Date('2024-07-01T00:00:00Z') });
    expect(col.find({ at: { $gt: new Date('2024-05-15T00:00:00Z') } }).map((x) => x.id)).toEqual(['b', 'c']);
    expect(col.find({ at: { $lt: new Date('2024-06-15T00:00:00Z').getTime() } }).map((x) => x.id)).toEqual(['a', 'b']);
    expect(col.find({}, { sort: { at: -1 } }).map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });

  it('reaches into nested objects with dotted paths, indexed or not', async () => {
    const col = await people({ ordered: ['owner.level'], indexed: ['owner.name'] });
    expect(names(col.find({ 'owner.name': 'Zed' }))).toEqual(['Maya', 'Omar']);
    expect(names(col.find({ 'owner.level': { $gte: 3 } }))).toEqual(['Maya', 'Omar']);
    expect(names(col.find({ 'owner.name': 'Zed', 'owner.level': { $lt: 4 } }))).toEqual(['Maya']);
    expect(col.find({ 'owner.nothing.deeper': 1 } as never)).toEqual([]);
    const m = col.findOne({ 'owner.name': 'Zed', 'owner.level': 3 })!;
    m.owner!.level = 9;
    col.update(m); // the index follows a change inside the nested object
    expect(names(col.find({ 'owner.level': 9 }))).toEqual(['Maya']);
    expect(names(col.find({ 'owner.level': 3 }))).toEqual([]);
  });

  it('matches arrays and objects by value', async () => {
    const col = await people();
    expect(names(col.find({ tags: ['b'] }))).toEqual(['Noor']);
    expect(names(col.find({ tags: [] }))).toEqual(['Omar']);
    expect(names(col.find({ owner: { $eq: { name: 'Yan', level: 1 } } }))).toEqual(['Noor']);
    expect(names(col.find({ misc: { $eq: [1, 2] } }))).toEqual(['Rae']);
    expect(names(col.find({ misc: { $in: [{ k: 1 }, 7] } }))).toEqual(['Quin']);
  });

  it('rejects an unknown operator', async () => {
    const col = await people();
    expect(() => col.find({ age: { $wat: 1 } } as never)).toThrow(/Unknown operator \$wat/);
    expect(() => col.find({ $wat: [] } as never)).toThrow(/Unknown operator \$wat/);
  });
});

describe('logic', () => {
  it('combines with $and $or $nor $not $where, and $not on a field', async () => {
    const col = await people({ indexed: ['city'], ordered: ['age'] });
    expect(names(col.find({ $or: [{ city: 'Lyon' }, { age: { $lt: 26 } }] }))).toEqual(['Maya', 'Noor', 'Omar', 'Rae']);
    expect(names(col.find({ $or: [{ city: 'Lyon' }, { city: 'Oslo' }], age: { $gt: 26 } }))).toEqual(['Maya', 'Omar']);
    expect(names(col.find({ $and: [{ age: { $gt: 20 } }, { age: { $lt: 35 } }, { city: { $ne: 'Oslo' } }] }))).toEqual(['Maya', 'Rae']);
    expect(names(col.find({ $nor: [{ city: 'Lyon' }, { age: 25 }] }))).toEqual(['Pia', 'Quin']);
    expect(names(col.find({ $not: { city: 'Lyon' } }))).toEqual(['Noor', 'Pia', 'Quin', 'Rae']);
    expect(names(col.find({ age: { $not: { $gt: 30 } } }))).toEqual(['Noor', 'Pia', 'Quin', 'Rae']);
    expect(names(col.find({ city: { $not: /^[LO]/ } }))).toEqual(['Pia', 'Quin', 'Rae']);
    expect(names(col.find({ $where: (d) => d.name.length === 3 }))).toEqual(['Pia', 'Rae']);
    expect(names(col.find({ $or: [{ $and: [{ city: 'Lyon' }, { age: { $gt: 35 } }] }, { name: 'Pia' }] }))).toEqual(['Omar', 'Pia']);
  });

  it('handles empty and impossible branches', async () => {
    const col = await people();
    expect(col.find({ $or: [{}, { city: 'Lyon' }] })).toHaveLength(6); // one branch matches everything
    expect(col.find({ $or: [] })).toEqual([]);
    expect(col.find({ $and: [] })).toHaveLength(6);
    expect(col.find({ $nor: [{}] })).toEqual([]);
    expect(col.find({ $or: [{ age: { $gt: 'x' as never } }, { city: 'Lyon' }] })).toHaveLength(2); // an impossible branch is dropped
  });

  it('uses indexes for each branch of an $or, and counts correctly', async () => {
    const col = await people({ indexed: ['city'], ordered: ['age'] });
    expect(col.count({ $or: [{ city: 'Lyon' }, { age: { $lt: 26 } }] })).toBe(4);
    expect(col.count({ city: 'Lyon' })).toBe(2);
    expect(col.count({ age: { $gt: 25 } })).toBe(2);
    expect(col.count({ $or: [{ city: 'Nowhere' }, { city: 'Lyon' }] })).toBe(2);
  });
});

describe('sorting and paging', () => {
  const build = async (ordered: string[]) => {
    const col = (await Docstore.open(null)).collection<P>('s', { ordered });
    const ages = [30, 10, 20, 10, 40, 20, 30, 50];
    ages.forEach((age, i) => col.insert({ id: `i${i}`, name: String.fromCharCode(104 - i), age, city: i % 2 ? 'x' : 'y' }));
    return col;
  };

  it('sorts by one or several fields, with offset and limit', async () => {
    const col = await build([]);
    expect(col.find({}, { sort: 'age' }).map((d) => d.age)).toEqual([10, 10, 20, 20, 30, 30, 40, 50]);
    expect(col.find({}, { sort: { age: -1 } }).map((d) => d.age)).toEqual([50, 40, 30, 30, 20, 20, 10, 10]);
    expect(col.find({}, { sort: { age: 'asc', name: 'desc' } }).map((d) => `${d.age}${d.name}`)).toEqual(['10g', '10e', '20f', '20c', '30h', '30b', '40d', '50a']);
    expect(col.find({}, { sort: { age: 1 }, offset: 2, limit: 3 }).map((d) => d.age)).toEqual([20, 20, 30]);
    expect(col.find({ city: 'x' }, { sort: { age: -1 }, limit: 2 }).map((d) => d.age)).toEqual([50, 20]);
  });

  it('puts missing values first and orders types: nothing, booleans, numbers, strings', async () => {
    const col = (await Docstore.open(null)).collection<P>('m');
    col.insert({ id: 's', name: 'a', misc: 'b' });
    col.insert({ id: 'n', name: 'a', misc: 2 });
    col.insert({ id: 'u', name: 'a' });
    col.insert({ id: 't', name: 'a', misc: true });
    col.insert({ id: 'z', name: 'a', misc: null });
    col.insert({ id: 'x', name: 'a', misc: 'a' });
    col.insert({ id: 'm', name: 'a', misc: 1 });
    const order = col.find({}, { sort: 'misc' }).map((d) => d.id);
    expect(order.slice(0, 2).sort()).toEqual(['u', 'z']);
    expect(order.slice(2)).toEqual(['t', 'm', 'n', 'x', 's']);
  });

  it('reads the newest N straight off an ordered index, the same as sorting everything', async () => {
    const plain = await build([]);
    const indexed = await build(['age']);
    for (const [q, sort, offset, limit] of [
      [{}, { age: -1 }, 0, 3],
      [{}, { age: 1 }, 0, 3],
      [{ city: 'x' }, { age: -1 }, 1, 2],
      [{ age: { $gt: 15 } }, { age: 1 }, 0, 4],
      [{ age: { $gt: 15, $lte: 30 } }, { age: -1 }, 1, 10],
      [{ name: { $regex: /[a-d]/ } }, { age: -1 }, 0, 2],
    ] as const) {
      const a = plain.find(q as never, { sort: { ...sort }, offset, limit }).map((d) => d.age);
      const b = indexed.find(q as never, { sort: { ...sort }, offset, limit }).map((d) => d.age);
      expect(b).toEqual(a);
    }
  });

  it('sorts strings on an ordered field and does not use an index that misses documents', async () => {
    const col = (await Docstore.open(null)).collection<P>('t', { ordered: ['city'] });
    for (const c of ['pear', 'apple', 'fig', 'banana']) col.insert({ name: c, city: c });
    expect(col.find({}, { sort: 'city', limit: 2 }).map((d) => d.city)).toEqual(['apple', 'banana']);
    expect(col.find({}, { sort: { city: -1 }, limit: 2 }).map((d) => d.city)).toEqual(['pear', 'fig']);
    col.insert({ name: 'none' }); // no city: the index no longer covers everything, so it sorts instead
    expect(col.find({}, { sort: 'city', limit: 2 }).map((d) => d.name)).toEqual(['none', 'apple']);
  });

  it('findOne with a sort returns the first in that order', async () => {
    const col = await build(['age']);
    expect(col.findOne({ city: 'y' }, { sort: { age: -1 } })!.age).toBe(40);
    expect(col.findOne({ age: 999 })).toBeNull();
  });
});

describe('result sets and aggregates', () => {
  it('chains find, where, sort, limit and offset', async () => {
    const col = await people({ indexed: ['city'] });
    const r = col.chain().find({ age: { $gte: 25 } }).where((d) => d.name !== 'Omar').simplesort('age').limit(2).data();
    expect(r.map((d) => d.name).sort()).toEqual(['Noor', 'Rae']);
    expect(col.chain().find({ city: { $in: ['Lyon', 'Paris'] } }).compoundsort([['city'], ['name', true]]).data().map((d) => d.name)).toEqual(['Omar', 'Maya', 'Rae', 'Pia']);
    expect(col.chain().simplesort('name', true).offset(1).limit(2).data().map((d) => d.name)).toEqual(['Quin', 'Pia']);
    expect(col.chain().sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name)).first()!.name).toBe('Pia');
    expect(col.chain().find({ city: 'Lyon' }).count()).toBe(2);
    const base = col.chain().find({ city: 'Lyon' });
    const copy = base.copy().find({ age: { $gt: 35 } });
    expect(base.count()).toBe(2);
    expect(copy.count()).toBe(1);
  });

  it('updates and removes through a result set', async () => {
    const col = await people({ ordered: ['age'] });
    col.chain().find({ city: 'Lyon' }).update((d) => void (d.age = 99));
    expect(names(col.find({ age: 99 }))).toEqual(['Maya', 'Omar']);
    expect(col.findAndUpdate({ age: 99 }, { age: 98 })).toBe(2);
    expect(col.count({ age: 98 })).toBe(2);
    expect(col.updateWhere((d) => d.name === 'Pia', (d) => void (d.age = 1))).toBe(1);
    expect(col.findAndRemove({ age: { $gte: 98 } })).toBe(2);
    expect(col.removeWhere((d) => d.name === 'Pia')).toBe(1);
    expect(col.size).toBe(3);
  });

  it('maps, reduces and joins', async () => {
    const col = await people();
    expect(col.chain().find({ city: 'Lyon' }).map((d) => d.name).sort()).toEqual(['Maya', 'Omar']);
    expect(col.chain().mapReduce((d) => d.age ?? 0, (xs) => xs.reduce((a, b) => a + b, 0))).toBe(121);
    const cities = [{ city: 'Lyon', country: 'FR' }, { city: 'Oslo', country: 'NO' }];
    const joined = col.chain().find({ city: { $in: ['Lyon', 'Oslo', 'Paris'] } }).eqJoin(cities, 'city', 'city', (l, r) => `${l.name}:${r.country}`);
    expect(joined.sort()).toEqual(['Maya:FR', 'Noor:NO', 'Omar:FR']);
    const pairs = col.chain().find({ name: 'Noor' }).eqJoin(cities, 'city', 'city');
    expect(pairs[0]!.right.country).toBe('NO');
  });

  it('aggregates', async () => {
    const col = await people({ ordered: ['age'] });
    expect(col.max('age')).toBe(40); // from the index
    expect(col.min('age')).toBe(25);
    expect(col.avg('age')).toBe((31 + 25 + 40 + 25) / 4);
    expect(col.median('age')).toBe(28);
    expect(col.stdDev('age')).toBeCloseTo(Math.sqrt(((31 - 30.25) ** 2 + (25 - 30.25) ** 2 * 2 + (40 - 30.25) ** 2) / 4), 10);
    expect(col.mode('city')).toBe('Lyon');
    expect(col.chain().find({ city: 'Paris' }).max('age')).toBe(25);
    expect(col.extractNumerical('age')).toEqual([31, 25, 40, 25]);
    expect(col.max('nothing')).toBeUndefined();
    const plain = await people(); // no index: scans, same answer
    expect(plain.max('age')).toBe(40);
    expect(plain.min('age')).toBe(25);
  });

  it('looks up by a field with by()', async () => {
    const col = await people({ unique: ['name'] });
    expect(col.by('name', 'Maya')!.id).toBe('maya');
    expect(col.by('id', 'noor')!.name).toBe('Noor');
    expect(col.by('name', 'Nobody')).toBeUndefined();
  });
});

describe('randomised: every query agrees with a plain JavaScript filter', () => {
  it('matches a naive scan over random documents and random queries', async () => {
    let seed = Number(process.env.FUZZ_SEED ?? 7);
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const words = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'Alpha', 'zeta', ''];
    type R = { id: string; n?: number | null; s?: string; g?: string; t?: string[]; o?: { k: number }; b?: boolean };
    const col = (await Docstore.open(null)).collection<R>('f', { indexed: ['g'], ordered: ['n', 's', 'o.k'] });
    const mirror = new Map<string, R>();
    const make = (id: string): R => {
      const r: R = { id };
      if (rnd() < 0.9) r.n = rnd() < 0.1 ? null : Math.floor(rnd() * 20) - 5;
      if (rnd() < 0.85) r.s = pick(words);
      if (rnd() < 0.8) r.g = pick(['x', 'y', 'z']);
      if (rnd() < 0.7) r.t = Array.from({ length: Math.floor(rnd() * 4) }, () => pick(['a', 'b', 'c', 'd']));
      if (rnd() < 0.6) r.o = { k: Math.floor(rnd() * 10) };
      if (rnd() < 0.5) r.b = rnd() < 0.5;
      return r;
    };
    for (let i = 0; i < 400; i++) {
      const r = make(`d${i}`);
      col.insert(r);
      mirror.set(r.id, JSON.parse(JSON.stringify(r)) as R);
    }
    const mutate = () => {
      const id = `d${Math.floor(rnd() * 400)}`;
      const cur = col.get(id);
      if (rnd() < 0.15) {
        if (cur) col.remove(id), mirror.delete(id);
        else {
          const r = make(id);
          col.insert(r);
          mirror.set(id, JSON.parse(JSON.stringify(r)) as R);
        }
      } else if (cur) {
        const fresh = make(id);
        col.update(fresh);
        mirror.set(id, JSON.parse(JSON.stringify(fresh)) as R);
      }
    };

    type Gen = { q: object; test: (d: R) => boolean };
    const leaf = (): Gen => {
      switch (Math.floor(rnd() * 14)) {
        case 0: { const v = Math.floor(rnd() * 20) - 5; return { q: { n: v }, test: (d) => d.n === v }; }
        case 1: { const a = Math.floor(rnd() * 20) - 5; return { q: { n: { $gt: a } }, test: (d) => typeof d.n === 'number' && d.n > a }; }
        case 2: { const a = Math.floor(rnd() * 20) - 5; const b = a + Math.floor(rnd() * 8); return { q: { n: { $gte: a, $lt: b } }, test: (d) => typeof d.n === 'number' && d.n >= a && d.n < b }; }
        case 3: { const v = pick(words); return { q: { s: v }, test: (d) => d.s === v }; }
        case 4: { const v = pick(words); return { q: { s: { $gte: v } }, test: (d) => typeof d.s === 'string' && d.s >= v }; }
        case 5: { const vs = [pick(['x', 'y', 'z']), pick(['x', 'y', 'z'])]; return { q: { g: { $in: vs } }, test: (d) => d.g !== undefined && vs.includes(d.g) }; }
        case 6: { const v = pick(['x', 'y', 'z']); return { q: { g: { $ne: v } }, test: (d) => d.g !== v }; }
        case 7: { const v = pick(['a', 'b', 'c', 'd']); return { q: { t: { $contains: v } }, test: (d) => !!d.t?.includes(v) }; }
        case 8: { const v = Math.floor(rnd() * 10); return { q: { 'o.k': { $lte: v } }, test: (d) => d.o !== undefined && d.o.k <= v }; }
        case 9: return { q: { s: { $regex: /^a/i } }, test: (d) => typeof d.s === 'string' && /^a/i.test(d.s) };
        case 10: return { q: { o: { $exists: true } }, test: (d) => d.o !== undefined };
        case 11: return { q: { t: { $size: 2 } }, test: (d) => d.t?.length === 2 };
        case 12: return { q: { b: true }, test: (d) => d.b === true };
        default: return { q: { n: null }, test: (d) => d.n === null || d.n === undefined };
      }
    };
    const gen = (depth: number): Gen => {
      if (depth === 0 || rnd() < 0.35) return leaf();
      const kids = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => gen(depth - 1));
      switch (Math.floor(rnd() * 5)) {
        case 0: return { q: { $or: kids.map((k) => k.q) }, test: (d) => kids.some((k) => k.test(d)) };
        case 1: return { q: { $and: kids.map((k) => k.q) }, test: (d) => kids.every((k) => k.test(d)) };
        case 2: return { q: { $nor: kids.map((k) => k.q) }, test: (d) => !kids.some((k) => k.test(d)) };
        case 3: return { q: { $not: kids[0]!.q }, test: (d) => !kids[0]!.test(d) };
        default: { const a = kids[0]!; const b = leaf(); return { q: { $and: [a.q, b.q] }, test: (d) => a.test(d) && b.test(d) }; }
      }
    };

    for (let round = 0; round < 60; round++) {
      for (let k = 0; k < 15; k++) mutate();
      const docs = [...mirror.values()];
      for (let k = 0; k < 12; k++) {
        const g = gen(3);
        const expected = docs.filter(g.test).map((d) => d.id).sort();
        const got = col.find(g.q as never).map((d) => d.id).sort();
        expect(got, JSON.stringify(g.q)).toEqual(expected);
        expect(col.count(g.q as never), JSON.stringify(g.q)).toBe(expected.length);
        const field = pick(['n', 's', 'g']);
        const desc = rnd() < 0.5;
        const limit = 1 + Math.floor(rnd() * 8);
        const offset = Math.floor(rnd() * 4);
        const sorted = col.find(g.q as never, { sort: { [field]: desc ? -1 : 1 }, limit, offset }) as R[];
        const key = (d: R) => d[field as 'n' | 's' | 'g'] ?? null; // a missing value and null sort together
        const naive = docs.filter(g.test);
        const rank = (v: unknown) => (v === undefined || v === null ? 0 : typeof v === 'number' ? 2 : 3);
        const cmp = (a: unknown, b: unknown) => (rank(a) !== rank(b) ? rank(a) - rank(b) : (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0);
        naive.sort((a, b) => (desc ? cmp(key(b), key(a)) : cmp(key(a), key(b))));
        // ties may come out in any order, so compare the sort keys, not the ids
        expect(sorted.map(key), `${JSON.stringify(g.q)} sort ${field} ${desc ? 'desc' : 'asc'} ${offset}+${limit}`).toEqual(naive.slice(offset, offset + limit).map(key));
        for (const d of sorted) expect(g.test(d)).toBe(true);
      }
    }
  });
});
