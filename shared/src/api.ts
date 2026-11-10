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
      scope: z.enum(['new', 'all']),
      podcastIds: z.array(z.string().min(8).max(64)).max(1000).nullable(),
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
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
