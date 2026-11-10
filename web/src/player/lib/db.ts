import Dexie, { type Table } from 'dexie';
import type { SmartPlaylistDefinition, TranscriptSegment } from '@homecast/shared';

/**
 * Local-first database (spec §2, §9). Everything the UI shows is read from here; the network only
 * feeds it through the sync engine. Synced rows mirror the server's records, plus `dirty` (1 while a
 * local change hasn't been acknowledged by the server).
 */
interface Synced {
  id: string;
  rev?: number;
  deleted?: boolean;
  dirty?: 0 | 1;
}

export interface PodcastRec extends Synced {
  feedUrl: string;
  isPrivate: boolean;
  title: string;
  author: string;
  imageUrl: string | null;
  description: string;
}
export interface EpisodeRec extends Synced {
  podcastId: string;
  guid: string;
  title: string;
  description: string;
  audioUrl: string;
  mimeType: string;
  durationSec: number;
  releasedAt: number;
  hasPublisherTranscript?: boolean;
}
export interface AutoDownload {
  mode: 'off' | 'latest' | 'all';
  count?: number;
}
export interface SubscriptionRec extends Synced {
  podcastId: string;
  autoDownload: AutoDownload;
  newEpisodeNotify: boolean;
  clientUpdatedAt: number;
}
export interface EpisodeStateRec extends Synced {
  episodeId: string;
  status: 'unplayed' | 'inProgress' | 'played';
  positionMs: number;
  positionUpdatedAt?: number;
  playedAt?: number | null;
  starred: boolean;
  clientUpdatedAt: number;
}
export interface BookmarkRec extends Synced {
  episodeId: string;
  positionMs: number;
  title: string | null;
  note: string | null;
  createdAt: number;
  clientUpdatedAt: number;
}
export interface PlaylistRec extends Synced {
  name: string;
  episodeIds: string[];
  clientUpdatedAt: number;
}
export interface SmartPlaylistRec extends Synced {
  name: string;
  definition: SmartPlaylistDefinition;
  clientUpdatedAt: number;
}
export interface SettingsRec extends Synced {
  defaultSpeed: number;
  podcastSpeeds: Record<string, number>;
  prefs: Prefs;
  clientUpdatedAt: number;
}
/** Synced preferences stored in `settings.prefs`. */
export interface Prefs {
  /** Delete played downloads after N days, per podcast. */
  cleanupDays?: Record<string, number>;
  [k: string]: unknown;
}
export interface TranscriptRec {
  episodeId: string;
  source: 'feed' | 'whisper';
  model: string | null;
  segments: TranscriptSegment[];
}
export interface DownloadRec {
  episodeId: string;
  podcastId: string;
  bytes: number;
  at: number;
}
export interface KV {
  key: string;
  value: unknown;
}

export class PodDB extends Dexie {
  podcasts!: Table<PodcastRec, string>;
  episodes!: Table<EpisodeRec, string>;
  subscriptions!: Table<SubscriptionRec, string>;
  episodeStates!: Table<EpisodeStateRec, string>;
  bookmarks!: Table<BookmarkRec, string>;
  playlists!: Table<PlaylistRec, string>;
  smartPlaylists!: Table<SmartPlaylistRec, string>;
  settings!: Table<SettingsRec, string>;
  transcripts!: Table<TranscriptRec, string>;
  downloads!: Table<DownloadRec, string>;
  kv!: Table<KV, string>;

  constructor(readonly userId: string) {
    super(`homecast-${userId}`);
    this.version(1).stores({
      podcasts: 'id, title',
      episodes: 'id, podcastId, releasedAt',
      subscriptions: 'id, podcastId, dirty',
      episodeStates: 'id, episodeId, status, dirty',
      bookmarks: 'id, episodeId, dirty',
      playlists: 'id, dirty',
      smartPlaylists: 'id, dirty',
      settings: 'id, dirty',
      transcripts: 'episodeId',
      downloads: 'episodeId, podcastId',
      kv: 'key',
    });
  }

  async getKV<T>(key: string, fallback: T): Promise<T> {
    const r = await this.kv.get(key);
    return r ? (r.value as T) : fallback;
  }
  setKV(key: string, value: unknown) {
    return this.kv.put({ key, value });
  }
}

// ---- deterministic ids -------------------------------------------------------------------------
// One row per (user, episode) and per (user, podcast) is the rule, so every device derives the same
// id and the server never has to reconcile duplicates. Max 64 chars (server schema).
const hex = (uuid: string) => uuid.replace(/-/g, '');
export const stateId = (userId: string, episodeId: string) => `${hex(userId)}${hex(episodeId)}`.slice(0, 64);
export const subId = (userId: string, podcastId: string) => `${hex(userId)}${hex(podcastId)}`.slice(0, 64);
export const settingsId = (userId: string) => `s${hex(userId)}`;
export const upNextId = (userId: string) => `q${hex(userId)}`;
export const UP_NEXT_NAME = '__upnext__';
/** `crypto.randomUUID` only exists in secure contexts; a LAN `http://` origin needs the fallback. */
export const newId = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export const DEFAULT_SPEED = 1;
export const defaultSettings = (userId: string): SettingsRec => ({ id: settingsId(userId), defaultSpeed: DEFAULT_SPEED, podcastSpeeds: {}, prefs: {}, clientUpdatedAt: 0, dirty: 0 });
