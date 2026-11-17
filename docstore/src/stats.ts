/** Aggregates over lists of numbers. All return undefined for an empty list. */
export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
export const avg = (xs: number[]): number | undefined => (xs.length ? sum(xs) / xs.length : undefined);
export function min(xs: number[]): number | undefined {
  let m: number | undefined;
  for (const x of xs) if (m === undefined || x < m) m = x;
  return m;
}
export function max(xs: number[]): number | undefined {
  let m: number | undefined;
  for (const x of xs) if (m === undefined || x > m) m = x;
  return m;
}
export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1]! + s[mid]!) / 2;
}
/** Population standard deviation (what LokiJS reports). */
export function stdDev(xs: number[]): number | undefined {
  const m = avg(xs);
  if (m === undefined) return undefined;
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / xs.length);
}
/** The most common value; the first to reach that count wins a tie. */
export function mode(xs: unknown[]): unknown {
  const counts = new Map<unknown, number>();
  let best: unknown;
  let bestN = 0;
  for (const x of xs) {
    const n = (counts.get(x) ?? 0) + 1;
    counts.set(x, n);
    if (n > bestN) (best = x), (bestN = n);
  }
  return best;
}
/** Numbers out of whatever is there: numbers as they are, numeric strings parsed, everything else skipped. */
export function numbers(xs: unknown[]): number[] {
  const out: number[] = [];
  for (const x of xs) {
    const n = typeof x === 'number' ? x : typeof x === 'string' ? parseFloat(x) : NaN;
    if (!Number.isNaN(n)) out.push(n);
  }
  return out;
}
