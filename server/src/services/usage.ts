import type { Database } from '../db/index.js';
import { dayKey, now, uuid } from '../util/misc.js';

export type UsageField = 'proxyBytes' | 'feedBytes' | 'transcribeBytes' | 'transcriptMinutes';

/** Daily per-user usage counters (tracking only, no quotas). */
export class UsageService {
  /** Pending increments, flushed into the DB on an interval so hot paths (proxy chunks) stay cheap. */
  private pending = new Map<string, { userId: string; day: string; add: Partial<Record<UsageField, number>> }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private db: Database) {}

  start(): void {
    this.timer = setInterval(() => this.flush(), 5000);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }

  add(userId: string, field: UsageField, amount: number): void {
    if (!(amount > 0)) return;
    const day = dayKey(now());
    const key = `${userId}|${day}`;
    const p = this.pending.get(key) ?? { userId, day, add: {} };
    p.add[field] = (p.add[field] ?? 0) + amount;
    this.pending.set(key, p);
  }

  flush(): void {
    for (const [key, p] of this.pending) {
      let row = this.db.usageStats.findOne({ key });
      if (!row) {
        row = this.db.usageStats.insert({ id: uuid(), key, userId: p.userId, day: p.day, proxyBytes: 0, feedBytes: 0, transcribeBytes: 0, transcriptMinutes: 0 });
      }
      for (const [f, v] of Object.entries(p.add) as [UsageField, number][]) row[f] += v;
      this.db.usageStats.saveQuiet(row);
    }
    this.pending.clear();
  }

  /** Daily rows are kept for one year (spec §11). */
  prune(): number {
    const cutoff = dayKey(now() - 365 * 86_400_000);
    this.flush();
    return this.db.usageStats.removeWhere((r) => r.day < cutoff);
  }
}
