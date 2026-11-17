/**
 * Turning text into the terms the search index stores: folded to lower case without accents, split into words, and
 * reduced to a stem so "tomato", "tomatoes" and "tomato's" are one term.
 */

export interface Token {
  /** The stem. */
  term: string;
  /** The word folded but not stemmed (stop words are recognised by this). */
  word: string;
  /** Where the word sits in the original text (UTF-16 offsets, end exclusive). */
  start: number;
  end: number;
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export const STOP_WORDS: ReadonlySet<string> = new Set(
  'a an and are as at be but by for if in into is it of on or such that the their then there these they this to was will with i you we he she so'.split(' '),
);

/** Lower case, accents removed, apostrophes dropped. */
export function fold(word: string): string {
  const lower = word.toLowerCase();
  const plain = /^[a-z0-9]+$/.test(lower) ? lower : lower.normalize('NFD').replace(/\p{M}/gu, '').replace(/['’]/g, '');
  return plain;
}

// A transcript repeats the same few thousand words, so folding and stemming are remembered.
const WORDS = new Map<string, { word: string; term: string }>();
const WORDS_MAX = 200_000;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD)) {
    const raw = m[0];
    let w = WORDS.get(raw);
    if (!w) {
      const word = fold(raw);
      if (!word) continue;
      w = { word, term: stem(word) };
      if (WORDS.size >= WORDS_MAX) WORDS.clear();
      WORDS.set(raw, w);
    }
    out.push({ term: w.term, word: w.word, start: m.index, end: m.index + raw.length });
  }
  return out;
}

// ---- the Porter stemmer (M. F. Porter, 1980), for English ------------------------------------------------------------

const STEP2: Record<string, string> = {
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize', bli: 'ble', alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous',
  ization: 'ize', ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful', ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble', logi: 'log',
};
const STEP3: Record<string, string> = { icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '' };
const c = '[^aeiou]';
const v = '[aeiouy]';
const C = `${c}[^aeiouy]*`;
const V = `${v}[aeiou]*`;
const MGR0 = new RegExp(`^(${C})?${V}${C}`);
const MEQ1 = new RegExp(`^(${C})?${V}${C}(${V})?$`);
const MGR1 = new RegExp(`^(${C})?${V}${C}${V}${C}`);
const SV = new RegExp(`^(${C})?${v}`);
const CVC = new RegExp(`^${C}${v}[^aeiouwxy]$`);
const DOUBLE = /([^aeiouylsz])\1$/;

export function stem(word: string): string {
  // Only plain English-looking words are stemmed; numbers, other alphabets and short words are left alone.
  if (word.length < 3 || !/^[a-z]+$/.test(word)) return word;
  let w = word;
  const first = w[0]!;
  if (first === 'y') w = 'Y' + w.slice(1);
  let m: RegExpExecArray | null;

  // 1a
  if (/^(.+?)(ss|i)es$/.test(w)) w = w.replace(/^(.+?)(ss|i)es$/, '$1$2');
  else if (/^(.+?)([^s])s$/.test(w)) w = w.replace(/^(.+?)([^s])s$/, '$1$2');
  // 1b
  if ((m = /^(.+?)eed$/.exec(w))) {
    if (MGR0.test(m[1]!)) w = w.slice(0, -1);
  } else if ((m = /^(.+?)(ed|ing)$/.exec(w)) && SV.test(m[1]!)) {
    w = m[1]!;
    if (/(at|bl|iz)$/.test(w)) w += 'e';
    else if (DOUBLE.test(w)) w = w.slice(0, -1);
    else if (CVC.test(w)) w += 'e';
  }
  // 1c
  if ((m = /^(.+?)y$/.exec(w)) && SV.test(m[1]!)) w = m[1] + 'i';
  // 2
  if ((m = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/.exec(w)) && MGR0.test(m[1]!)) w = m[1] + STEP2[m[2]!]!;
  // 3
  if ((m = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/.exec(w)) && MGR0.test(m[1]!)) w = m[1] + STEP3[m[2]!]!;
  // 4
  if ((m = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/.exec(w))) {
    if (MGR1.test(m[1]!)) w = m[1]!;
  } else if ((m = /^(.+?)(s|t)(ion)$/.exec(w)) && MGR1.test(m[1]! + m[2]!)) w = m[1]! + m[2]!;
  // 5
  if ((m = /^(.+?)e$/.exec(w)) && (MGR1.test(m[1]!) || (MEQ1.test(m[1]!) && !CVC.test(m[1]!)))) w = m[1]!;
  if (/ll$/.test(w) && MGR1.test(w)) w = w.slice(0, -1);

  return first === 'y' ? 'y' + w.slice(1) : w;
}

/** Whether `a` and `b` are within `max` single-character edits, giving up early once they cannot be. */
export function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(d);
      if (d < best) best = d;
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length]! <= max;
}
