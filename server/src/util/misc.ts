import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const uuid = (): string => randomUUID();
export const now = (): number => Date.now();
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const dayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Remove loki bookkeeping fields before returning a record. */
export function clean<T extends object>(doc: T): Omit<T, '$loki' | 'meta'> {
  const { $loki: _l, meta: _m, ...rest } = doc as T & { $loki?: number; meta?: unknown };
  return rest as Omit<T, '$loki' | 'meta'>;
}

export function jitter(ms: number, fraction = 0.2): number {
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * fraction));
}
