import { statfsSync } from 'node:fs';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { now } from '../util/misc.js';
import type { AuditService } from './audit.js';
import type { SettingsService } from './settings.js';

const BACKUPS_KEPT = 14;

export class BackupService {
  constructor(
    private db: Database,
    private config: Config,
    private settings: SettingsService,
    private audit: AuditService,
  ) {}

  run(actorId?: string | null): { bytes: number; kept: number } {
    const r = this.db.snapshot(this.config.dataDir, BACKUPS_KEPT);
    this.settings.recordBackup(now(), r.bytes);
    this.audit.log({ action: 'backup.completed', actorId: actorId ?? null, detail: String(r.bytes) });
    return r;
  }

  info(): { lastAt: number | null; lastBytes: number | null; kept: number } {
    const s = this.settings.get();
    return { lastAt: s.lastBackupAt, lastBytes: s.lastBackupBytes, kept: this.db.listBackups(this.config.dataDir).length };
  }

  /** Daily at 03:00 server time; also catches up if the process was down at that time. */
  due(): boolean {
    const d = new Date();
    const boundary = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 3, 0, 0, 0).getTime();
    const last = this.settings.get().lastBackupAt ?? 0;
    return now() >= boundary && last < boundary;
  }

  diskFreeBytes(): number | null {
    try {
      const s = statfsSync(this.config.dataDir);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }
}
