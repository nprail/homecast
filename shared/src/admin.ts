/** Response shapes of the /api/v1/admin routes, shared with the dashboard. */
export interface AdminOverview {
  version: string;
  uptimeSec: number;
  users: { total: number; activeToday: number };
  podcasts: { total: number; withErrors: number };
  episodes: { total: number; last24h: number };
  database: { bytes: number; diskFreeBytes: number | null };
  backup: { lastAt: number | null; lastBytes: number | null; kept: number };
  feedHealth: AdminFeed[];
  recentActivity: AuditEntry[];
}

export type FeedStatus = 'ok' | 'error' | 'slow' | 'pending';
export interface AdminFeed {
  id: string;
  title: string;
  feedUrl: string;
  isPrivate: boolean;
  hiddenFromDiscover: boolean;
  subscribers: number;
  lastFetchedAt: number | null;
  lastFetchMs: number | null;
  fetchError: string | null;
  status: FeedStatus;
  statusLabel: string;
  episodeCount: number;
}

export interface AdminUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  disabled: boolean;
  createdAt: number;
  lastActiveAt: number | null;
  devices: number;
  podcasts: number;
}

export type InviteStatus = 'pending' | 'used' | 'expired' | 'revoked';
export interface AdminInvite {
  id: string;
  codePrefix: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  status: InviteStatus;
  usedBy: string | null;
}

export interface AdminJob {
  id: string;
  episodeId: string;
  episodeTitle: string;
  podcastTitle: string;
  requestedBy: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: string | null;
  progress: number | null;
  queuePosition: number | null;
  audioSeconds: number | null;
  source: 'feed' | 'whisper' | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
}
export interface AdminJobs {
  model: string;
  concurrency: number;
  counts: { running: number; queued: number; doneLast24h: number; failedLast24h: number };
  jobs: AdminJob[];
}

export interface UsageDay {
  day: string;
  proxyBytes: number;
  feedBytes: number;
  transcribeBytes: number;
  transcriptMinutes: number;
}
export interface UsageUser {
  userId: string;
  username: string;
  proxyBytes: number;
  feedBytes: number;
  transcribeBytes: number;
  transcriptMinutes: number;
}
export interface AdminUsage {
  days: number;
  from: string;
  to: string;
  feedCount: number;
  pollIntervalMinutes: number;
  whisperModel: string;
  totals: Omit<UsageDay, 'day'>;
  daily: UsageDay[];
  byUser: UsageUser[];
}

export interface AuditEntry {
  id: string;
  at: number;
  actorId: string | null;
  actorName: string | null;
  action: string;
  target: string | null;
  targetLabel: string | null;
  ip: string | null;
  detail: string | null;
}

export type AutoTranscribeScope = 'new' | 'all';
export interface AutoTranscribeSettings {
  enabled: boolean;
  /** `new`: only episodes the server discovers after this was switched on. `all`: also the back catalogue. */
  scope: AutoTranscribeScope;
  /** `null` = every podcast with a subscriber; otherwise only these podcast ids. */
  podcastIds: string[] | null;
}
export interface AdminSettings {
  registrationOpen: boolean;
  whisperModel: string;
  pollIntervalMinutes: number;
  autoTranscribe: AutoTranscribeSettings;
  /** Episodes currently eligible for auto-transcription but not yet queued or done. */
  autoTranscribePending: number;
}
