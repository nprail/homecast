import type { Database } from '../db/index.js';
import { now } from '../util/misc.js';
import type { AuditService } from './audit.js';
import type { BackupService } from './backup.js';
import type { LoginGuard } from '../security/loginGuard.js';
import type { SessionService } from './sessions.js';
import type { SyncService } from './sync.js';
import type { TranscriptService } from './transcripts.js';
import type { UsageService } from './usage.js';

/** Periodic housekeeping: daily backup, nightly pruning, tombstone purge. */
export class Maintenance {
  private timer: NodeJS.Timeout | null = null;
  private lastNightly = '';

  constructor(
    private db: Database,
    private backup: BackupService,
    private sync: SyncService,
    private usage: UsageService,
    private audit: AuditService,
    private sessions: SessionService,
    private transcripts: TranscriptService,
    private guard: LoginGuard,
    private log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void },
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
    setTimeout(() => this.tick(), 10_000).unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  tick(): void {
    try {
      this.guard.sweep();
      const t = now();
      this.db.resetTokens.removeWhere((r) => r.expiresAt < t - 86_400_000);
      if (this.backup.due()) this.backup.run();
      const today = new Date().toDateString();
      if (new Date().getHours() >= 3 && this.lastNightly !== today) {
        this.lastNightly = today;
        const purged = this.sync.purgeTombstones();
        this.usage.prune();
        this.audit.prune();
        this.sessions.prune();
        this.transcripts.prune();
        this.log.info({ purged }, 'nightly maintenance complete');
      }
    } catch (e) {
      this.log.error({ err: e }, 'maintenance failed');
    }
  }
}
