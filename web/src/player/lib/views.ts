import type { EpisodeView } from '@homecast/shared';
import type { EpisodeRec, EpisodeStateRec, PodDB } from './db';

/** Local-database view of every episode of subscribed podcasts, for smart-playlist evaluation. */
export async function buildEpisodeViews(db: PodDB): Promise<EpisodeView[]> {
  const subs = new Set((await db.subscriptions.toArray()).filter((s) => !s.deleted).map((s) => s.podcastId));
  const [eps, states, dls] = await Promise.all([db.episodes.toArray(), db.episodeStates.toArray(), db.downloads.toArray()]);
  return toViews(eps.filter((e) => subs.has(e.podcastId)), states, new Set(dls.map((d) => d.episodeId)));
}

export function toViews(eps: EpisodeRec[], states: EpisodeStateRec[], downloaded: Set<string>): EpisodeView[] {
  const st = new Map(states.filter((s) => !s.deleted).map((s) => [s.episodeId, s]));
  return eps.map((e) => ({
    id: e.id,
    podcastId: e.podcastId,
    title: e.title,
    releasedAt: e.releasedAt,
    durationSec: e.durationSec,
    status: st.get(e.id)?.status ?? 'unplayed',
    downloaded: downloaded.has(e.id),
    starred: st.get(e.id)?.starred ?? false,
  }));
}
