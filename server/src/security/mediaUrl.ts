import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed URLs for streaming hosted episode copies. An HTML audio element can't send the Authorization
 * header, so the URL itself carries the grant: an HMAC over the episode, the user and an expiry time,
 * keyed from the server's JWT secret (a separate subkey, so the two never cross over).
 */
export const MEDIA_URL_TTL_MS = 12 * 3600_000;

const subkey = (secret: string) => createHmac('sha256', secret).update('homecast-media-url-v1').digest();

export function signMedia(secret: string, episodeId: string, userId: string, exp: number): string {
  return createHmac('sha256', subkey(secret)).update(`${episodeId}|${userId}|${exp}`).digest('base64url');
}

export function verifyMedia(secret: string, episodeId: string, userId: string, exp: number, sig: string, nowMs: number): boolean {
  if (!Number.isSafeInteger(exp) || exp < nowMs || exp > nowMs + MEDIA_URL_TTL_MS + 60_000) return false;
  const want = Buffer.from(signMedia(secret, episodeId, userId, exp));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}
