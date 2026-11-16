import { get } from '../../lib/api';

/**
 * A signed, short-lived URL for a copy the server hosts (episode hosting), or null when there is none
 * or the server can't be reached in time. The player then streams from the podcast's own URL.
 */
export async function signedStreamUrl(episodeId: string): Promise<string | null> {
  if (!navigator.onLine) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      get<{ url: string | null }>(`/episodes/${episodeId}/stream`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 4000);
      }),
    ]);
    return r.url;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
