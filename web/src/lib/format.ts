export function fmtBytes(n: number, digits = 1): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(digits)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(digits)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : digits)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}
/** Gigabytes with one decimal, as in the usage cards and chart. */
export const fmtGB = (n: number): string => (n / 1e9).toFixed(1);
export const fmtInt = (n: number): string => new Intl.NumberFormat('en-US').format(Math.round(n));

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "Just now", "12 min ago", "3 hours ago", "Yesterday", "3 days ago"; future: "In 6 days". */
export function relTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'Never';
  const diff = now - ts;
  const abs = Math.abs(diff);
  const min = Math.floor(abs / 60_000);
  const hr = Math.floor(abs / 3_600_000);
  const day = Math.floor(abs / 86_400_000);
  if (diff < 0) {
    const rm = Math.round(abs / 60_000);
    const rh = Math.round(abs / 3_600_000);
    const rd = Math.round(abs / 86_400_000);
    if (rm < 1) return 'Soon';
    if (rh < 1) return `In ${rm} min`;
    if (rd < 1) return `In ${plural(rh, 'hour')}`;
    return `In ${plural(rd, 'day')}`;
  }
  if (min < 1) return 'Just now';
  if (hr < 1) return `${min} min ago`;
  if (day < 1) return `${plural(hr, 'hour')} ago`;
  if (day === 1) return 'Yesterday';
  return `${plural(day, 'day')} ago`;
}

export const fmtClock = (ts: number): string => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "Today, 09:12" / "Yesterday, 14:30" / "Nov 3, 14:30". */
export function fmtWhen(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date(now)) - start(d)) / 86_400_000);
  if (days === 0) return `Today, ${fmtClock(ts)}`;
  if (days === 1) return `Yesterday, ${fmtClock(ts)}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${fmtClock(ts)}`;
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  if (d >= 1) return `${plural(d, 'day')}`;
  const h = Math.floor(sec / 3600);
  if (h >= 1) return plural(h, 'hour');
  return plural(Math.max(1, Math.floor(sec / 60)), 'minute');
}

/** Audio length: "56 min", "1 h 12 min". */
export function fmtAudioLength(sec: number | null): string {
  if (!sec) return '—';
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}

/** Elapsed time: "1 m 48 s". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`;
}

export const fmtDay = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
