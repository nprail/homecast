import { describe, expect, it } from 'vitest';
import { TranscriptIndex, parseQuery } from '../src/search/index.js';
import { stem, tokenize, withinEdits } from '../src/search/text.js';

const seg = (startMs: number, text: string) => ({ startMs, endMs: startMs + 3000, text });
type Segs = ReturnType<typeof seg>[];

function build(docs: Record<string, string[]>) {
  const store = new Map<string, Segs>();
  const idx = new TranscriptIndex((id) => store.get(id) ?? null);
  for (const [id, lines] of Object.entries(docs)) {
    const segs = lines.map((t, i) => seg(i * 4000, t));
    store.set(id, segs);
    idx.add(id, segs);
  }
  return { idx, store };
}
const ids = (idx: TranscriptIndex, q: string, accept: (id: string) => boolean = () => true) => idx.search(q, accept).ranked.map((r) => r.episodeId);

describe('stemmer', () => {
  it('reduces words the way Porter specified', () => {
    const pairs: [string, string][] = [
      ['caresses', 'caress'], ['ponies', 'poni'], ['ties', 'ti'], ['caress', 'caress'], ['cats', 'cat'], ['feed', 'feed'], ['agreed', 'agre'],
      ['plastered', 'plaster'], ['bled', 'bled'], ['motoring', 'motor'], ['sing', 'sing'], ['conflated', 'conflat'], ['troubled', 'troubl'],
      ['sized', 'size'], ['hopping', 'hop'], ['falling', 'fall'], ['hissing', 'hiss'], ['failing', 'fail'], ['filing', 'file'], ['happy', 'happi'],
      ['sky', 'sky'], ['relational', 'relat'], ['conditional', 'condit'], ['rational', 'ration'], ['digitizer', 'digit'], ['operator', 'oper'],
      ['feudalism', 'feudal'], ['decisiveness', 'decis'], ['hopefulness', 'hope'], ['callousness', 'callous'], ['triplicate', 'triplic'],
      ['formative', 'form'], ['formalize', 'formal'], ['electrical', 'electr'], ['hopeful', 'hope'], ['goodness', 'good'], ['revival', 'reviv'],
      ['allowance', 'allow'], ['inference', 'infer'], ['airliner', 'airlin'], ['gyroscopic', 'gyroscop'], ['adjustable', 'adjust'],
      ['defensible', 'defens'], ['irritant', 'irrit'], ['replacement', 'replac'], ['adjustment', 'adjust'], ['dependent', 'depend'],
      ['adoption', 'adopt'], ['homologous', 'homolog'], ['communism', 'commun'], ['activate', 'activ'], ['effective', 'effect'],
      ['bowdlerize', 'bowdler'], ['probate', 'probat'], ['rate', 'rate'], ['cease', 'ceas'], ['controll', 'control'], ['roll', 'roll'],
      ['tomatoes', 'tomato'], ['fermentation', 'ferment'], ['running', 'run'],
    ];
    for (const [w, s] of pairs) expect(stem(w), w).toBe(s);
  });

  it('leaves numbers, short words and other alphabets alone', () => {
    expect(stem('2024')).toBe('2024');
    expect(stem('is')).toBe('is');
    expect(stem('привет')).toBe('привет');
  });
});

describe('tokenizer', () => {
  it('folds accents and case, drops apostrophes, and keeps offsets into the original text', () => {
    const t = tokenize("Café au lait, don't ÉTÉ 42");
    expect(t.map((x) => x.word)).toEqual(['cafe', 'au', 'lait', 'dont', 'ete', '42']);
    expect(t.map((x) => [x.start, x.end])).toEqual([[0, 4], [5, 7], [8, 12], [14, 19], [20, 23], [24, 26]]);
  });

  it('measures edits', () => {
    expect(withinEdits('tomato', 'tomaato', 1)).toBe(true);
    expect(withinEdits('tomato', 'tomtao', 1)).toBe(false); // a swap is two edits
    expect(withinEdits('tomato', 'tomatoes', 1)).toBe(false);
    expect(withinEdits('abc', 'xyz', 2)).toBe(false);
  });
});

describe('query parsing', () => {
  it('reads words, phrases, exclusions, and makes the last plain word a prefix', () => {
    const p = parseQuery('slow "sun and water" -blight ferm');
    expect(p.required.map((r) => (r.kind === 'word' ? `${r.token.word}${r.last ? '*' : ''}` : `"${r.words.map((w) => w.word).join(' ')}"`))).toEqual(['slow', '"sun and water"', 'ferm*']);
    expect(p.excluded).toEqual([{ kind: 'word', stem: 'blight' }]);
    expect(parseQuery('the').required).toEqual([]);
    expect(parseQuery('to be or').required[0]).toMatchObject({ kind: 'phrase' });
    expect(parseQuery('well-known').required[0]).toMatchObject({ kind: 'phrase' }); // a hyphenated word is two words in a row
  });
});

describe('index', () => {
  const docs = {
    a: ['We grow tomatoes every spring.', 'Slow fermentation makes better bread.', 'The garden needs water.'],
    b: ['Tomatoes and basil go together.', 'Water the basil daily.'],
    c: ['Nothing about vegetables here.', 'Only the weather and the news.'],
  };

  it('finds documents, ranking the one with more and denser matches first', () => {
    const { idx } = build(docs);
    expect(ids(idx, 'tomatoes').sort()).toEqual(['a', 'b']);
    expect(ids(idx, 'water basil')).toEqual(['b']);
    expect(ids(idx, 'water')).toHaveLength(2);
    expect(ids(idx, 'tomatoes basil')).toEqual(['b']);
    expect(ids(idx, 'zzz')).toEqual([]);
    expect(ids(idx, '')).toEqual([]);
  });

  it('ranks by BM25: a rarer word counts for more, and so does repetition', () => {
    const { idx } = build({
      one: ['garden garden garden garden', 'garden'],
      two: ['a single garden mention'],
      three: ['garden rhubarb'],
      four: ['filler words only'],
    });
    expect(ids(idx, 'garden')[0]).toBe('one');
    expect(ids(idx, 'garden rhubarb')[0]).toBe('three'); // rhubarb is rare
  });

  it('matches word forms, accents, prefixes of the last word and near spellings', () => {
    const { idx } = build({ a: ['Fermenting tomato plants for café owners.'] });
    expect(ids(idx, 'ferment')).toEqual(['a']);
    expect(ids(idx, 'fermented tomatoes')).toEqual(['a']);
    expect(ids(idx, 'CAFE')).toEqual(['a']);
    expect(ids(idx, 'plan')).toEqual(['a']); // prefix of "plants"
    expect(ids(idx, 'plan tomato')).toEqual([]); // a prefix only for the last word
    expect(ids(idx, 'tomaato')).toEqual(['a']);
    expect(ids(idx, 'xyzzy')).toEqual([]);
  });

  it('matches phrases only when the words are next to each other, across a line break too', () => {
    const { idx } = build({ a: ['Today we plant tomatoes in spring.', 'Tomatoes need lots of sun and water.', 'Then we rest.'], b: ['water sun and'] });
    expect(ids(idx, '"sun and water"')).toEqual(['a']);
    expect(ids(idx, '"water and sun"')).toEqual([]);
    expect(ids(idx, '"spring. tomatoes"')).toEqual(['a']); // across two lines
    expect(ids(idx, '"in spring tomatoes need"')).toEqual(['a']);
    expect(ids(idx, '"to be or not to be"')).toEqual([]);
    const { idx: i2 } = build({ h: ['To be, or not to be, that is it.'] });
    expect(ids(i2, '"to be or not to be"')).toEqual(['h']); // only common words: still found
  });

  it('excludes words and phrases', () => {
    const { idx } = build(docs);
    expect(ids(idx, 'tomatoes -basil')).toEqual(['a']);
    expect(ids(idx, 'water -"slow fermentation"')).toEqual(['b']);
    expect(ids(idx, '-tomatoes')).toEqual([]); // nothing to look for
  });

  it('only looks at documents it is allowed to', () => {
    const { idx } = build(docs);
    expect(ids(idx, 'tomatoes', (id) => id === 'b')).toEqual(['b']);
    expect(ids(idx, 'tomatoes', () => false)).toEqual([]);
  });

  it('builds hits: the lines with the most terms, with marks, in transcript order', () => {
    const { idx } = build({ a: ['Only sun here.', 'Sun and water together.', 'More sun later.', 'Water alone.'] });
    const out = idx.search('sun water', () => true);
    const r = out.ranked[0]!;
    expect(r.matches).toBe(1); // one line has both words
    expect(out.hits(r, 3)).toEqual([{ startMs: 4000, text: 'Sun and water together.', marks: [[0, 3], [8, 13]] }]);
    const some = idx.search('sun', () => true);
    expect(some.hits(some.ranked[0]!, 2).map((h) => h.startMs)).toEqual([0, 4000]); // transcript order
    expect(some.ranked[0]!.matches).toBe(3);
  });

  it('joins a phrase that runs across two lines into one hit', () => {
    const { idx } = build({ a: ['We plant tomatoes in the spring.', 'Tomatoes need lots of sun.'] });
    const out = idx.search('"spring. tomatoes"', () => true);
    const h = out.hits(out.ranked[0]!, 3)[0]!;
    expect(h.text).toBe('We plant tomatoes in the spring. Tomatoes need lots of sun.');
    expect(h.marks).toEqual([[25, 31], [33, 41]]); // the full stop between the two words breaks the stretch
  });

  it('cuts long lines to a snippet around the match and moves the marks with it', () => {
    const long = `${'lorem ipsum dolor sit amet '.repeat(20)}needle in the middle ${'consectetur adipiscing elit '.repeat(20)}`;
    const { idx } = build({ a: [long] });
    const out = idx.search('needle', () => true);
    const h = out.hits(out.ranked[0]!, 1)[0]!;
    expect(h.text.length).toBeLessThanOrEqual(242);
    expect(h.text.startsWith('…') && h.text.endsWith('…')).toBe(true);
    const [s, e] = h.marks[0]!;
    expect(h.text.slice(s, e)).toBe('needle');
  });

  it('removes and replaces documents completely', () => {
    const { idx, store } = build(docs);
    idx.remove('b');
    expect(ids(idx, 'basil')).toEqual([]);
    expect(idx.has('b')).toBe(false);
    expect(ids(idx, 'tomatoes')).toEqual(['a']);
    const next = [seg(0, 'Sourdough starters need feeding.')];
    store.set('a', next);
    idx.add('a', next);
    expect(ids(idx, 'tomatoes')).toEqual([]);
    expect(ids(idx, 'sourdough')).toEqual(['a']);
    expect(idx.size).toBe(2);
    idx.remove('a');
    idx.remove('c');
    expect(idx.size).toBe(0);
    expect(ids(idx, 'sourdough')).toEqual([]);
  });

  it('agrees with a plain scan over random transcripts', () => {
    let seed = 5;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const vocab = ['garden', 'water', 'sun', 'bread', 'yeast', 'salt', 'flour', 'oven', 'basil', 'soil', 'seed', 'rain'];
    const docs: Record<string, string[]> = {};
    for (let d = 0; d < 40; d++) docs[`d${d}`] = Array.from({ length: 12 }, () => Array.from({ length: 3 + Math.floor(rnd() * 6) }, () => vocab[Math.floor(rnd() * vocab.length)]).join(' '));
    const { idx } = build(docs);
    const has = (id: string, w: string) => docs[id]!.some((l) => l.split(' ').includes(w));
    for (let k = 0; k < 200; k++) {
      const a = vocab[Math.floor(rnd() * vocab.length)]!;
      const b = vocab[Math.floor(rnd() * vocab.length)]!;
      const c = vocab[Math.floor(rnd() * vocab.length)]!;
      const want = Object.keys(docs).filter((id) => has(id, a) && has(id, b) && !has(id, c)).sort();
      // words are stemmed, so compare with the same terms spelled out (no prefix on the last one: it is an exclusion)
      expect(ids(idx, `${a} ${b} -${c}`).sort(), `${a} ${b} -${c}`).toEqual(a === c || b === c ? [] : want);
      const phrase = docs[`d${k % 40}`]![k % 12]!.split(' ').slice(0, 2);
      if (phrase.length === 2) {
        const got = ids(idx, `"${phrase.join(' ')}"`).sort();
        const need = Object.keys(docs).filter((id) => docs[id]!.some((l, i, all) => `${l} ${all[i + 1] ?? ''}`.includes(phrase.join(' ')) && (l.includes(phrase.join(' ')) || `${l} ${all[i + 1] ?? ''}`.split(' ').join(' ').includes(phrase.join(' ')))));
        for (const id of got) expect(need).toContain(id);
      }
    }
  });
});
