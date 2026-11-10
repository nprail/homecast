import { z } from 'zod';
import { smartPlaylistDefinitionSchema } from './smartPlaylist.js';

const ts = z.number().int().min(0);
const uuid = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

const base = { id: uuid, clientUpdatedAt: ts, deleted: z.boolean().optional() };

export const episodeStateChange = z.object({
  ...base,
  episodeId: uuid,
  status: z.enum(['unplayed', 'inProgress', 'played']),
  positionMs: z.number().int().min(0).max(1e10),
  /** When the position was last produced by a play event; defaults to clientUpdatedAt. */
  positionUpdatedAt: ts.optional(),
  playedAt: ts.nullable().optional(),
  starred: z.boolean().default(false),
});

export const bookmarkChange = z.object({
  ...base,
  episodeId: uuid,
  positionMs: z.number().int().min(0).max(1e10),
  title: z.string().max(200).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  createdAt: ts,
});

export const playlistChange = z.object({
  ...base,
  name: z.string().min(1).max(120),
  episodeIds: z.array(uuid).max(5000),
});

export const smartPlaylistChange = z.object({
  ...base,
  name: z.string().min(1).max(120),
  definition: smartPlaylistDefinitionSchema,
});

export const autoDownloadSchema = z.object({
  mode: z.enum(['off', 'latest', 'all']),
  count: z.number().int().min(1).max(100).optional(),
});

export const subscriptionChange = z.object({
  ...base,
  podcastId: uuid,
  autoDownload: autoDownloadSchema.default({ mode: 'off' }),
  newEpisodeNotify: z.boolean().default(true),
});

export const settingsChange = z.object({
  ...base,
  defaultSpeed: z.number().min(0.5).max(3),
  podcastSpeeds: z.record(z.string().max(64), z.number().min(0.5).max(3)).default({}),
  prefs: z.record(z.string().max(64), z.unknown()).default({}),
});

const lenient = <T extends z.ZodTypeAny>(s: T) => z.array(s).max(5000);

export const syncRequestSchema = z.object({
  cursor: z.number().int().min(0),
  deviceId: z.string().min(1).max(100),
  changes: z
    .object({
      episodeStates: lenient(episodeStateChange).default([]),
      bookmarks: lenient(bookmarkChange).default([]),
      playlists: lenient(playlistChange).default([]),
      smartPlaylists: lenient(smartPlaylistChange).default([]),
      settings: lenient(settingsChange).default([]),
      subscriptions: lenient(subscriptionChange).default([]),
    })
    .default({ episodeStates: [], bookmarks: [], playlists: [], smartPlaylists: [], settings: [], subscriptions: [] }),
});

export type SyncRequest = z.infer<typeof syncRequestSchema>;

export const SYNC_USER_COLLECTIONS = ['episodeStates', 'bookmarks', 'playlists', 'smartPlaylists', 'settings', 'subscriptions'] as const;
export type SyncUserCollection = (typeof SYNC_USER_COLLECTIONS)[number];

/** Shape of a record returned by the server (client fields plus server `rev`). */
export type SyncedRecord = Record<string, unknown> & { id: string; rev: number; deleted: boolean };

export interface SyncResponse {
  cursor: number;
  hasMore: boolean;
  /** True when the request cursor predates the tombstone horizon: discard local synced data and re-pull from 0. */
  fullResync: boolean;
  /** Ids the server refused (wrong owner, unknown podcast, private feed, ...). */
  rejected: { collection: string; id: string; reason: string }[];
  changes: {
    podcasts: SyncedRecord[];
    episodes: SyncedRecord[];
  } & Record<SyncUserCollection, SyncedRecord[]>;
}
