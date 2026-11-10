import type { SmartPlaylistDefinition } from '@homecast/shared';

/** Fields every record carries. `rev` is assigned by the server on every synced write. */
export interface Base {
  id: string;
  rev?: number;
  deleted?: boolean;
  /** When the tombstone was created; tombstones are purged 90 days later. */
  deletedAt?: number;
}

export interface User {
  id: string;
  username: string;
  /** Lower-cased username, the unique key. */
  usernameKey: string;
  passwordHash: string;
  role: 'admin' | 'user';
  createdAt: number;
  disabled: boolean;
  lastActiveAt: number | null;
}

/** A refresh-token family == a session == a device login. */
export interface RefreshToken {
  id: string; // session id (sid)
  userId: string;
  tokenHash: string;
  previousTokenHash: string | null;
  deviceName: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  ip: string | null;
}

export interface Invite {
  id: string;
  codeHash: string;
  codePrefix: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedBy: string | null;
  usedAt: number | null;
  revokedAt: number | null;
}

export interface ResetToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  usedAt: number | null;
}

export interface Podcast extends Base {
  feedUrl: string;
  isPrivate: boolean;
  hiddenFromDiscover: boolean;
  title: string;
  author: string;
  imageUrl: string | null;
  description: string;
  createdAt: number;
  lastFetchedAt: number | null;
  lastFetchMs: number | null;
  etag: string | null;
  lastModified: string | null;
  fetchError: string | null;
  failureCount: number;
  nextFetchAt: number;
  createdBy: string | null;
}

export interface Episode extends Base {
  podcastId: string;
  guid: string;
  title: string;
  description: string;
  audioUrl: string;
  mimeType: string;
  durationSec: number;
  releasedAt: number;
  createdAt: number;
  transcriptUrl: string | null;
  transcriptType: string | null;
}

export interface Transcript extends Base {
  episodeId: string;
  source: 'feed' | 'whisper';
  status: 'ready';
  model: string | null;
  segments: { startMs: number; endMs: number; text: string }[];
  createdAt: number;
}

export interface Subscription extends Base {
  userId: string;
  podcastId: string;
  autoDownload: { mode: 'off' | 'latest' | 'all'; count?: number };
  newEpisodeNotify: boolean;
  clientUpdatedAt: number;
}

export interface EpisodeState extends Base {
  userId: string;
  episodeId: string;
  status: 'unplayed' | 'inProgress' | 'played';
  positionMs: number;
  positionUpdatedAt: number;
  playedAt: number | null;
  starred: boolean;
  clientUpdatedAt: number;
}

export interface Bookmark extends Base {
  userId: string;
  episodeId: string;
  positionMs: number;
  title: string | null;
  note: string | null;
  createdAt: number;
  clientUpdatedAt: number;
}

export interface Playlist extends Base {
  userId: string;
  name: string;
  episodeIds: string[];
  clientUpdatedAt: number;
}

export interface SmartPlaylist extends Base {
  userId: string;
  name: string;
  definition: SmartPlaylistDefinition;
  clientUpdatedAt: number;
}

export interface UserSettings extends Base {
  userId: string;
  defaultSpeed: number;
  podcastSpeeds: Record<string, number>;
  prefs: Record<string, unknown>;
  clientUpdatedAt: number;
}

export interface Job {
  id: string;
  type: 'transcript';
  episodeId: string;
  podcastId: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: string | null;
  progress: number | null;
  error: string | null;
  requestedBy: string;
  attachedUsers: string[];
  source: 'feed' | 'whisper' | null;
  audioSeconds: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
}

export interface UsageStat {
  id: string;
  /** `userId|day`, unique. */
  key: string;
  userId: string;
  day: string; // YYYY-MM-DD (UTC)
  proxyBytes: number;
  feedBytes: number;
  transcribeBytes: number;
  transcriptMinutes: number;
}

export interface AuditLogEntry {
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

export interface ServerSettings {
  id: string;
  registrationOpen: boolean;
  whisperModel: string;
  pollIntervalMinutes: number;
  autoTranscribe: { enabled: boolean; scope: 'new' | 'all'; podcastIds: string[] | null; enabledAt: number };
  lastBackupAt: number | null;
  lastBackupBytes: number | null;
}

export interface Meta {
  id: string;
  rev: number;
  /** Highest rev of any purged tombstone; clients with an older cursor must fully resync. */
  horizon?: number;
}
