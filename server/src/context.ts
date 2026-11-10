import type { Config } from './config.js';
import type { Database } from './db/index.js';
import type { LoginGuard } from './security/loginGuard.js';
import type { AuditService } from './services/audit.js';
import type { AutoTranscriber } from './services/autoTranscribe.js';
import type { BackupService } from './services/backup.js';
import type { FeedPoller, FeedService } from './services/feeds.js';
import type { SessionService } from './services/sessions.js';
import type { SettingsService } from './services/settings.js';
import type { SyncService } from './services/sync.js';
import type { TranscriptService } from './services/transcripts.js';
import type { UsageService } from './services/usage.js';

export interface Ctx {
  config: Config;
  db: Database;
  sessions: SessionService;
  audit: AuditService;
  usage: UsageService;
  settings: SettingsService;
  feeds: FeedService;
  poller: FeedPoller;
  transcripts: TranscriptService;
  autoTranscribe: AutoTranscriber;
  sync: SyncService;
  backup: BackupService;
  loginGuard: LoginGuard;
  /** Printed to the log on first run while no users exist (spec §3.9). */
  bootstrap: { token: string | null };
  startedAt: number;
}
