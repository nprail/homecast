import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { useApp } from '../AppData';
import { UP_NEXT_NAME, upNextId, type EpisodeRec, type EpisodeStateRec, type PlaylistRec, type PodcastRec, type SettingsRec } from './db';

export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    on();
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}
export const useDesktop = () => useMedia('(min-width: 900px)');

/** Reachability as observed by sync (a failed request), not `navigator.onLine`, which lies on LAN-only networks. */
export function useOnline(): boolean {
  const { sync } = useApp();
  return useSyncExternalStore(sync.subscribe, () => sync.getSnapshot().state !== 'offline');
}

const EMPTY_MAP = new Map<never, never>();

/** Subscribed podcasts (not deleted), sorted by title. */
export function useSubscribedPodcasts(): PodcastRec[] | undefined {
  const { db } = useApp();
  return useLiveQuery(async () => {
    const subs = (await db.subscriptions.toArray()).filter((s) => !s.deleted);
    const pods = await db.podcasts.bulkGet(subs.map((s) => s.podcastId));
    return pods.filter((p): p is PodcastRec => !!p).sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
  }, [db]);
}
export function usePodcastMap(): Map<string, PodcastRec> {
  const { db } = useApp();
  return useLiveQuery(async () => new Map((await db.podcasts.toArray()).map((p) => [p.id, p])), [db]) ?? (EMPTY_MAP as Map<string, PodcastRec>);
}
export function useStates(): Map<string, EpisodeStateRec> {
  const { db } = useApp();
  return useLiveQuery(async () => new Map((await db.episodeStates.toArray()).filter((s) => !s.deleted).map((s) => [s.episodeId, s])), [db]) ?? (EMPTY_MAP as Map<string, EpisodeStateRec>);
}
export function useDownloadedSet(): Set<string> {
  const { db } = useApp();
  return useLiveQuery(async () => new Set((await db.downloads.toArray()).map((d) => d.episodeId)), [db]) ?? new Set<string>();
}
export function useEpisodes(ids: string[]): Map<string, EpisodeRec> {
  const { db } = useApp();
  const key = ids.join(',');
  return (
    useLiveQuery(async () => new Map((await db.episodes.bulkGet(ids)).filter((e): e is EpisodeRec => !!e).map((e) => [e.id, e])), [db, key]) ?? (EMPTY_MAP as Map<string, EpisodeRec>)
  );
}
export function useQueueIds(): string[] {
  const { db } = useApp();
  return useLiveQuery(async () => {
    const q = await db.playlists.get(upNextId(db.userId));
    return q && !q.deleted ? q.episodeIds : [];
  }, [db]) ?? [];
}
export function usePlaylists(): PlaylistRec[] {
  const { db } = useApp();
  return useLiveQuery(async () => (await db.playlists.toArray()).filter((p) => !p.deleted && p.name !== UP_NEXT_NAME).sort((a, b) => a.name.localeCompare(b.name)), [db]) ?? [];
}
export function useSettings(): SettingsRec {
  const { db, data } = useApp();
  return useLiveQuery(() => data.getSettings(), [db, data]) ?? { id: '', defaultSpeed: 1, podcastSpeeds: {}, prefs: {}, clientUpdatedAt: 0 };
}

/** Back that never leaves the app: history back when there is in-app history, else a fallback route. */
export function useGoBack(fallback = '/'): () => void {
  const nav = useNavigate();
  return () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) nav(-1);
    else nav(fallback, { replace: true });
  };
}
