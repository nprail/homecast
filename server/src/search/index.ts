import type { TranscriptSegment } from '@homecast/shared';
import { STOP_WORDS, fold, stem, tokenize, withinEdits, type Token } from './text.js';

/**
 * A full-text index over transcripts: an inverted index from stemmed words to the lines they occur in, ranked with
 * BM25, with phrases, exclusions, prefix matching on the last word and typo tolerance. It lives in memory beside the
 * database and holds only postings (no transcript text): text is fetched back when hits are built, for the page of
 * results being shown.
 */

/** A line index is packed with its document number into one number: `doc * LINE_SPAN + line`. */
const LINE_SPAN = 1 << 20;
const K1 = 1.2;
const B = 0.75;
const MAX_TERMS = 8;
const MAX_EXPANSIONS = 48;
const HITS_SNIPPET = 240;
/** A search made only of words too common to index scans this many transcripts at most. */
const SCAN_LIMIT = 2000;

interface TermEntry {
  /** Packed (document, line) values, ascending. One per line the term occurs in. */
  list: number[];
  /** Number of documents it occurs in. */
  df: number;
}
interface DocInfo {
  episodeId: string;
  /** Number of words, for BM25's length normalisation. */
  len: number;
  /** The distinct terms indexed, so the document can be removed again. */
  terms: string[];
}

export interface Hit {
  startMs: number;
  text: string;
  /** Matched stretches of `text`, as `[start, end]` offsets (UTF-16 code units, end exclusive). */
  marks: [number, number][];
}
export interface Ranked {
  episodeId: string;
  score: number;
  /** Lines containing every term, or if there are none, lines containing any. */
  matches: number;
  /** Line numbers to show, best first. */
  lines: number[];
}
export interface Outcome {
  ranked: Ranked[];
  /** The best `max` lines of a ranked document, in transcript order, as text with marks. */
  hits(r: Ranked, max: number): Hit[];
}

/** One required piece of a query. */
type Req =
  | { kind: 'word'; raw: string; stems: string[]; exact: Set<string>; idf: number; map: Map<number, number[]>; exactDocs: Set<number> }
  | { kind: 'phrase'; raw: string; words: Token[]; idf: number; map: Map<number, number[]> };
type Exclusion = { kind: 'word'; stem: string } | { kind: 'phrase'; words: Token[] };

interface Parsed {
  required: ({ kind: 'word'; token: Token; last: boolean } | { kind: 'phrase'; words: Token[] })[];
  excluded: Exclusion[];
}

/** Words, "quoted phrases" and -excluded words. The last plain word also matches as a prefix (search as you type). */
export function parseQuery(q: string): Parsed {
  const required: Parsed['required'] = [];
  const excluded: Exclusion[] = [];
  const stops: Token[] = [];
  const re = /(-?)"([^"]*)"|(-?)(\S+)/g;
  let m: RegExpExecArray | null;
  let lastPlain = -1;
  while ((m = re.exec(q)) && required.length + excluded.length < MAX_TERMS) {
    const neg = (m[1] ?? m[3]) === '-';
    const quoted = m[2] !== undefined;
    const tokens = tokenize(quoted ? m[2]! : m[4]!);
    if (tokens.length === 0) continue;
    if (tokens.length > 1 || quoted) {
      if (neg) excluded.push(tokens.length === 1 ? { kind: 'word', stem: tokens[0]!.term } : { kind: 'phrase', words: tokens });
      else if (tokens.length === 1) required.push({ kind: 'word', token: tokens[0]!, last: false });
      else required.push({ kind: 'phrase', words: tokens });
      continue;
    }
    const t = tokens[0]!;
    if (neg) excluded.push({ kind: 'word', stem: t.term });
    else if (STOP_WORDS.has(t.word)) stops.push(t);
    else {
      required.push({ kind: 'word', token: t, last: false });
      lastPlain = required.length - 1;
    }
  }
  // Only the final thing typed is a prefix, and only if it is a plain word.
  if (lastPlain === required.length - 1 && lastPlain >= 0) {
    const r = required[lastPlain]!;
    if (r.kind === 'word' && r.token.word.length >= 2) r.last = true;
  }
  // A search made only of common words ("to be or not to be") is a phrase.
  if (required.length === 0 && stops.length > 1) required.push({ kind: 'phrase', words: stops });
  return { required, excluded };
}

const pack = (doc: number, line: number) => doc * LINE_SPAN + line;
const docOf = (p: number) => Math.floor(p / LINE_SPAN);
const lineOf = (p: number) => p % LINE_SPAN;

export class TranscriptIndex {
  private readonly terms = new Map<string, TermEntry>();
  private readonly docs = new Map<number, DocInfo>();
  private readonly byEpisode = new Map<string, number>();
  private nextDoc = 1;
  private totalLen = 0;
  private sorted: string[] | null = null;

  /** `fetch` returns a transcript's lines (used to check phrases and to build hits). */
  constructor(private readonly fetch: (episodeId: string) => TranscriptSegment[] | null) {}

  get size(): number {
    return this.docs.size;
  }

  has(episodeId: string): boolean {
    return this.byEpisode.has(episodeId);
  }

  // ---- changing the index ------------------------------------------------------------------------------------------

  add(episodeId: string, segments: TranscriptSegment[]): void {
    this.remove(episodeId);
    const doc = this.nextDoc++;
    const seen = new Set<string>();
    let len = 0;
    const lines = Math.min(segments.length, LINE_SPAN);
    for (let i = 0; i < lines; i++) {
      const inLine = new Set<string>();
      for (const t of tokenize(segments[i]!.text)) {
        len++;
        if (!STOP_WORDS.has(t.word)) inLine.add(t.term);
      }
      for (const term of inLine) {
        let e = this.terms.get(term);
        if (!e) {
          e = { list: [], df: 0 };
          this.terms.set(term, e);
          this.sorted = null;
        }
        e.list.push(pack(doc, i));
        if (!seen.has(term)) {
          seen.add(term);
          e.df++;
        }
      }
    }
    this.docs.set(doc, { episodeId, len, terms: [...seen] });
    this.byEpisode.set(episodeId, doc);
    this.totalLen += len;
  }

  remove(episodeId: string): void {
    const doc = this.byEpisode.get(episodeId);
    if (doc === undefined) return;
    const info = this.docs.get(doc)!;
    const lo = doc * LINE_SPAN;
    for (const term of info.terms) {
      const e = this.terms.get(term);
      if (!e) continue;
      const from = lowerBound(e.list, lo);
      let to = from;
      while (to < e.list.length && e.list[to]! < lo + LINE_SPAN) to++;
      e.list.splice(from, to - from);
      e.df--;
      if (e.list.length === 0) {
        this.terms.delete(term);
        this.sorted = null;
      }
    }
    this.totalLen -= info.len;
    this.docs.delete(doc);
    this.byEpisode.delete(episodeId);
  }

  // ---- searching ---------------------------------------------------------------------------------------------------

  /** Rank the documents `accept` allows. */
  search(q: string, accept: (episodeId: string) => boolean): Outcome {
    const parsed = parseQuery(q);
    const none: Outcome = { ranked: [], hits: () => [] };
    if (parsed.required.length === 0 || this.docs.size === 0) return none;

    const lineCache = new Map<number, TranscriptSegment[] | null>();
    const segmentsOf = (doc: number): TranscriptSegment[] | null => {
      if (!lineCache.has(doc)) lineCache.set(doc, this.fetch(this.docs.get(doc)!.episodeId));
      return lineCache.get(doc)!;
    };
    const tokenCache = new Map<string, Token[]>();
    const tokensOf = (doc: number, line: number, segs: TranscriptSegment[]): Token[] => {
      const key = `${doc}:${line}`;
      let t = tokenCache.get(key);
      if (!t) tokenCache.set(key, (t = tokenize(segs[line]?.text ?? '')));
      return t;
    };

    // 1. Words: expand each to the terms it can mean and collect the lines they occur in.
    const N = this.docs.size;
    const reqs: Req[] = [];
    for (const r of parsed.required) {
      if (r.kind === 'word') {
        const { stems, exact } = this.expand(r.token.term, r.last);
        const map = new Map<number, number[]>();
        const exactDocs = new Set<number>(); // documents that have the word as typed, not only a longer or near one
        let df = 0;
        for (const s of stems) {
          const e = this.terms.get(s)!;
          df += e.df;
          const isExact = exact.has(s);
          for (const p of e.list) {
            const d = docOf(p);
            if (isExact) exactDocs.add(d);
            const l = map.get(d);
            if (l) l.push(lineOf(p));
            else map.set(d, [lineOf(p)]);
          }
        }
        reqs.push({ kind: 'word', raw: r.token.word, stems, exact, idf: idf(N, Math.min(df, N)), map, exactDocs });
      } else {
        reqs.push({ kind: 'phrase', raw: r.words.map((w) => w.word).join(' '), words: r.words, idf: 0, map: new Map() });
      }
    }
    // A word that matches nothing makes the whole query match nothing.
    for (const r of reqs) if (r.kind === 'word' && r.map.size === 0) return none;

    // 2. Documents that have every word (and every indexed word of every phrase), and none of the excluded ones.
    const sets: Map<number, unknown>[] = reqs.filter((r): r is Extract<Req, { kind: 'word' }> => r.kind === 'word').map((r) => r.map);
    let scan = false;
    for (const r of reqs) {
      if (r.kind !== 'phrase') continue;
      const words = r.words.filter((w) => !STOP_WORDS.has(w.word));
      if (words.length === 0) {
        scan = true;
        continue;
      }
      let rarest = Infinity;
      for (const w of words) {
        const e = this.terms.get(w.term);
        if (!e) return none; // a word nobody said
        rarest = Math.min(rarest, e.df);
        sets.push(this.docSet(w.term));
      }
      r.idf = idf(N, Math.min(rarest, N)) * 1.3;
    }
    let candidates: number[];
    if (sets.length === 0) candidates = scan ? [...this.docs.keys()].slice(0, SCAN_LIMIT) : [];
    else {
      sets.sort((a, b) => a.size - b.size);
      candidates = [...sets[0]!.keys()].filter((d) => sets.every((s) => s.has(d)));
    }
    candidates = candidates.filter((d) => accept(this.docs.get(d)!.episodeId));
    for (const x of parsed.excluded) {
      if (x.kind !== 'word') continue;
      const e = this.terms.get(x.stem);
      if (!e) continue;
      const bad = new Set(e.list.map(docOf));
      candidates = candidates.filter((d) => !bad.has(d));
    }
    if (candidates.length === 0) return none;

    // 3. Phrases need the words next to each other, which the index cannot tell: check the text of the likely lines.
    const phraseLines = (words: Token[], doc: number, restrict: number[] | null): Map<number, true> | null => {
      const segs = segmentsOf(doc);
      if (!segs) return null;
      const found = new Map<number, true>();
      const starts = new Set<number>();
      if (restrict) for (const l of restrict) (starts.add(l), l > 0 && starts.add(l - 1));
      else for (let i = 0; i < segs.length; i++) starts.add(i);
      for (const s of starts) if (phraseAt(tokensOf(doc, s, segs), tokensOf(doc, s + 1, segs), words)) found.set(s, true);
      return found;
    };
    for (const r of reqs) {
      if (r.kind !== 'phrase') continue;
      const keep: number[] = [];
      const indexed = r.words.filter((w) => !STOP_WORDS.has(w.word));
      // Narrow to the lines holding the phrase's rarest indexed word, plus the line before (a phrase can straddle two lines).
      const rare = indexed.length ? indexed.reduce((a, b) => (this.terms.get(a.term)!.df <= this.terms.get(b.term)!.df ? a : b)) : null;
      const rareDocs = rare ? this.linesByDoc(rare.term) : null;
      for (const d of candidates) {
        const lines = phraseLines(r.words, d, rareDocs ? (rareDocs.get(d) ?? []) : null);
        if (lines && lines.size) {
          r.map.set(d, [...lines.keys()].sort((a, b) => a - b));
          keep.push(d);
        }
      }
      candidates = keep;
      if (candidates.length === 0) return none;
    }
    for (const x of parsed.excluded) {
      if (x.kind !== 'phrase') continue;
      candidates = candidates.filter((d) => {
        const lines = phraseLines(x.words, d, null);
        return !lines || lines.size === 0;
      });
    }
    if (candidates.length === 0) return none;

    // 4. Score: BM25 over the words, more for lines that hold every term.
    const avg = this.totalLen / N || 1;
    const ranked: Ranked[] = [];
    const termCount = reqs.length;
    for (const d of candidates) {
      const info = this.docs.get(d)!;
      const norm = K1 * (1 - B + (B * info.len) / avg);
      const perLine = new Map<number, number>(); // line -> how many of the terms it has
      let score = 0;
      for (const r of reqs) {
        const lines = unique(r.map.get(d) ?? []);
        for (const l of lines) perLine.set(l, (perLine.get(l) ?? 0) + 1);
        const tf = lines.length;
        const weight = r.kind === 'word' && !r.exactDocs.has(d) ? 0.6 : 1;
        score += r.idf * ((tf * (K1 + 1)) / (tf + norm)) * weight;
      }
      const all: number[] = [];
      const some: number[] = [];
      for (const [l, n] of perLine) (n === termCount ? all : some).push(l);
      const lines = all.length > 0 ? all : some;
      // Lines with more of the terms first, then in transcript order.
      lines.sort((a, b) => (perLine.get(b)! - perLine.get(a)!) || a - b);
      score *= 1 + 0.25 * Math.min(all.length, 4);
      ranked.push({ episodeId: info.episodeId, score, matches: lines.length, lines });
    }

    const wordStems = new Set<string>();
    for (const r of reqs) if (r.kind === 'word') for (const s of r.stems) wordStems.add(s);
    const phrases = reqs.filter((r): r is Extract<Req, { kind: 'phrase' }> => r.kind === 'phrase');

    const hits = (r: Ranked, max: number): Hit[] => {
      const doc = this.byEpisode.get(r.episodeId);
      if (doc === undefined) return [];
      const segs = segmentsOf(doc);
      if (!segs) return [];
      const chosen = r.lines.slice(0, max).sort((a, b) => a - b);
      const out: Hit[] = [];
      for (const line of chosen) {
        const seg = segs[line];
        if (!seg) continue;
        // A phrase may run on into the next line; then the hit is both lines.
        let text = seg.text;
        let runsOn = false;
        for (const p of phrases) {
          const m = phraseAt(tokensOf(doc, line, segs), tokensOf(doc, line + 1, segs), p.words);
          if (m?.straddles) runsOn = true;
        }
        if (runsOn && segs[line + 1]) text = `${seg.text} ${segs[line + 1]!.text}`;
        const toks = tokenize(text);
        const marked = new Set<number>();
        toks.forEach((t, i) => wordStems.has(t.term) && marked.add(i));
        for (const p of phrases) for (const at of phraseStarts(toks, p.words)) for (let k = 0; k < p.words.length; k++) marked.add(at + k);
        out.push(makeHit(seg.startMs, text, toks, marked));
      }
      return out;
    };
    return { ranked, hits };
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  private docSet(term: string): Map<number, unknown> {
    const out = new Map<number, unknown>();
    for (const p of this.terms.get(term)!.list) out.set(docOf(p), true);
    return out;
  }

  private linesByDoc(term: string): Map<number, number[]> {
    const out = new Map<number, number[]>();
    for (const p of this.terms.get(term)!.list) {
      const d = docOf(p);
      const l = out.get(d);
      if (l) l.push(lineOf(p));
      else out.set(d, [lineOf(p)]);
    }
    return out;
  }

  private sortedTerms(): string[] {
    return (this.sorted ??= [...this.terms.keys()].sort());
  }

  /** The indexed terms a stem can stand for: itself, terms it begins (the last word), or near spellings if there is nothing else. */
  private expand(stemmed: string, prefix: boolean): { stems: string[]; exact: Set<string> } {
    const exact = new Set<string>();
    const stems = new Set<string>();
    if (this.terms.has(stemmed)) (exact.add(stemmed), stems.add(stemmed));
    if (prefix) {
      const all = this.sortedTerms();
      let lo = 0;
      let hi = all.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (all[mid]! < stemmed) lo = mid + 1;
        else hi = mid;
      }
      // Take the commonest of the terms that start with it.
      const found: string[] = [];
      for (let i = lo; i < all.length && all[i]!.startsWith(stemmed); i++) found.push(all[i]!);
      found.sort((a, b) => this.terms.get(b)!.df - this.terms.get(a)!.df);
      for (const t of found.slice(0, MAX_EXPANSIONS)) stems.add(t);
    }
    if (stems.size === 0 && stemmed.length >= 5) {
      const max = stemmed.length >= 9 ? 2 : 1;
      const near: string[] = [];
      for (const t of this.terms.keys()) if (withinEdits(stemmed, t, max)) near.push(t);
      near.sort((a, b) => this.terms.get(b)!.df - this.terms.get(a)!.df);
      for (const t of near.slice(0, MAX_EXPANSIONS)) stems.add(t);
    }
    return { stems: [...stems], exact };
  }
}

// ---- helpers -------------------------------------------------------------------------------------------------------

const idf = (n: number, df: number) => Math.log(1 + (n - df + 0.5) / (df + 0.5));

function lowerBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function unique(xs: number[]): number[] {
  return xs.length < 2 ? xs : [...new Set(xs)];
}

/** Positions in `tokens` where the phrase's words follow one another. */
function phraseStarts(tokens: Token[], words: Token[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + words.length <= tokens.length; i++) {
    let ok = true;
    for (let k = 0; k < words.length && ok; k++) ok = tokens[i + k]!.term === words[k]!.term;
    if (ok) out.push(i);
  }
  return out;
}

/** Does the phrase start in this line (running on into the next one counts)? */
function phraseAt(here: Token[], next: Token[], words: Token[]): { straddles: boolean } | null {
  const joined = [...here, ...next];
  for (const at of phraseStarts(joined, words)) {
    if (at < here.length) return { straddles: at + words.length > here.length };
  }
  return null;
}

/** Cut the text down to a readable snippet around the first match and shift the marks to match it. */
function makeHit(startMs: number, text: string, toks: Token[], marked: Set<number>): Hit {
  let marks: [number, number][] = [];
  [...marked].sort((a, b) => a - b).forEach((i) => {
    const t = toks[i]!;
    const prev = marks[marks.length - 1];
    // Neighbouring words separated only by spaces read as one highlighted stretch.
    if (prev && /^\s+$/.test(text.slice(prev[1], t.start))) prev[1] = t.end;
    else marks.push([t.start, t.end]);
  });
  if (text.length <= HITS_SNIPPET) return { startMs, text, marks };
  const at = marks[0]?.[0] ?? 0;
  const start = Math.max(0, Math.min(at - 60, text.length - HITS_SNIPPET));
  const end = Math.min(text.length, start + HITS_SNIPPET);
  const lead = start > 0 ? '…' : '';
  const shift = lead.length - start;
  marks = marks.filter(([s, e]) => e > start && s < end).map(([s, e]) => [Math.max(s, start) + shift, Math.min(e, end) + shift]);
  return { startMs, text: `${lead}${text.slice(start, end)}${end < text.length ? '…' : ''}`, marks };
}

export { fold, stem };
