import type { DiscoverItem } from '@homecast/shared';
import type { Database } from '../db/index.js';

/**
 * Podcasts that appear in Discover: followed by at least one person, not a private feed, not hidden by an
 * admin. `exclude` drops podcasts the asker already follows. Used by the signed-in and the public directory.
 */
export function directoryItems(db: Database, opts: { q?: string | undefined; exclude?: Set<string> }): DiscoverItem[] {
  const counts = new Map<string, number>();
  for (const s of db.subscriptions.where((x) => !x.deleted)) counts.set(s.podcastId, (counts.get(s.podcastId) ?? 0) + 1);
  const needle = opts.q?.trim().toLowerCase();
  const items: DiscoverItem[] = [];
  for (const [podcastId, n] of counts) {
    const p = db.podcasts.get(podcastId);
    if (!p || p.deleted || p.isPrivate || p.hiddenFromDiscover || opts.exclude?.has(podcastId)) continue;
    if (needle && !p.title.toLowerCase().includes(needle) && !p.author.toLowerCase().includes(needle)) continue;
    items.push({ id: p.id, title: p.title, author: p.author, imageUrl: p.imageUrl, description: p.description.slice(0, 300), subscriberCount: n, addedAt: p.createdAt });
  }
  return items;
}
