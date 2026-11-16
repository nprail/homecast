import type { PodcastRec } from './db';

const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);

/**
 * Same-origin URL for a podcast's cover. The server fetches and caches the image (the page's CSP only
 * allows images from this origin); `v` changes when the feed's artwork URL does, so a new cover is picked up.
 */
export function artUrl(podcast: Pick<PodcastRec, 'id' | 'imageUrl'> | null | undefined): string | null {
  if (!podcast?.imageUrl) return null;
  return `/api/v1/art/${encodeURIComponent(podcast.id)}?v=${hash(podcast.imageUrl)}`;
}
