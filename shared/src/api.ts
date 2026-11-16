import { z } from 'zod';

export const usernameSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Letters, numbers, dot, dash and underscore only');
/** Minimum length 10, no composition rules (spec §7). */
export const passwordSchema = z.string().min(10, 'At least 10 characters').max(256);

export const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  deviceName: z.string().trim().max(80).optional(),
  /** `web` keeps the refresh token in an HttpOnly cookie instead of the response body. */
  client: z.enum(['web', 'native']).default('native'),
});
export const refreshBody = z.object({ refreshToken: z.string().min(10).max(400).optional() });
export const registerBody = z.object({
  username: usernameSchema,
  password: passwordSchema,
  inviteCode: z.string().min(6).max(100).optional(),
  bootstrapToken: z.string().min(6).max(200).optional(),
  deviceName: z.string().trim().max(80).optional(),
  client: z.enum(['web', 'native']).default('native'),
});
export const resetPasswordBody = z.object({ token: z.string().min(10).max(200), password: passwordSchema });
export const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema });

export const addPodcastBody = z.object({
  feedUrl: z.string().url().max(2048),
  /** User-declared private feed (never shown in Discover). */
  private: z.boolean().optional(),
});
export const subscribeBody = z.object({ podcastId: z.string().min(8).max(64) });

export const discoverQuery = z.object({
  q: z.string().max(100).optional(),
  sort: z.enum(['subscribers', 'recent', 'az']).default('subscribers'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createInviteBody = z.object({ expiresInDays: z.number().int().min(1).max(60).default(7) });
export const patchUserBody = z.object({ role: z.enum(['admin', 'user']).optional(), disabled: z.boolean().optional() });
export const patchFeedBody = z.object({ hiddenFromDiscover: z.boolean() });
export const patchSettingsBody = z.object({
  registrationOpen: z.boolean().optional(),
  whisperModel: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._\-/]+$/).optional(),
  pollIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  autoTranscribe: z
    .object({
      enabled: z.boolean(),
      scope: z.enum(['new', 'recent', 'all']),
      recentCount: z.number().int().min(1).max(1000).optional(),
      podcastIds: z.array(z.string().min(8).max(64)).max(1000).nullable(),
    })
    .optional(),
  episodeMirror: z
    .object({
      enabled: z.boolean(),
      maxGB: z.number().positive().max(100_000).nullable(),
    })
    .optional(),
});

export interface UserDto {
  id: string;
  username: string;
  role: 'admin' | 'user';
}
export interface AuthResponse {
  user: UserDto;
  accessToken: string;
  accessTokenExpiresAt: number;
  /** Omitted for `client: "web"`: the refresh token is set as an HttpOnly cookie. */
  refreshToken?: string;
}
export interface SessionDto {
  id: string;
  deviceName: string;
  createdAt: number;
  lastUsedAt: number;
  current: boolean;
}
export interface DiscoverItem {
  id: string;
  title: string;
  author: string;
  imageUrl: string | null;
  description: string;
  subscriberCount: number;
  addedAt: number;
}
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}
/** One chapter of an episode. `startMs` is the chapter's start; it ends where the next one begins. */
export interface Chapter {
  startMs: number;
  title: string;
  img?: string;
  url?: string;
}
export type ChapterSource = 'json' | 'feed' | 'description';
export interface ChaptersResponse {
  source: ChapterSource;
  chapters: Chapter[];
}

export const transcriptSearchQuery = z.object({
  q: z.string().trim().min(2).max(100),
  /** Limit the search to one podcast. */
  podcastId: z.string().min(8).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export interface TranscriptHit {
  startMs: number;
  text: string;
}
export interface TranscriptSearchItem {
  episodeId: string;
  podcastId: string;
  episodeTitle: string;
  podcastTitle: string;
  releasedAt: number;
  /** Number of matching lines in the episode (hits holds the first few). */
  matches: number;
  hits: TranscriptHit[];
}
export interface TranscriptSearchResponse {
  total: number;
  items: TranscriptSearchItem[];
}
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
