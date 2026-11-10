/** 24:18 or 1:02:03 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}
export const remaining = (posMs: number, durMs: number) => `−${clock(Math.max(0, durMs - posMs))}`;

/** "56 min", "1 h 04 min" (episode length) */
export function lengthText(sec: number): string {
  if (!sec) return '';
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}
export function minutesLeft(durMs: number, posMs: number): string {
  const m = Math.max(0, Math.round((durMs - posMs) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min left` : `${m} min left`;
}

export function ago(ts: number, now = Date.now()): string {
  const d = Math.floor((now - ts) / 86_400_000);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 14) return `${d} days ago`;
  return shortDate(ts);
}
export const shortDate = (ts: number): string => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(new Date(ts).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}) });

export const speedText = (s: number): string => `${Number.isInteger(s) ? s.toFixed(1) : s}×`;

/** Total length "4 h 02 min" for a queue. */
export function totalText(sec: number): string {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
