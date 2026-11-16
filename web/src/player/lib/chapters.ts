import type { Chapter, ChaptersResponse } from '@homecast/shared';
import { useEffect, useState } from 'react';
import { ApiError, get } from '../../lib/api';
import { useApp } from '../AppData';
import type { ChaptersRec, PodDB } from './db';

const NONE_TTL_MS = 24 * 3600_000;

/** Chapters for an episode: from this device's cache, else the server. `null` means there are none. */
export async function loadChapters(db: PodDB, episodeId: string): Promise<ChaptersRec | null> {
  const cached = await db.chapters.get(episodeId);
  if (cached && !cached.none) return cached;
  if (cached?.none && Date.now() - cached.fetchedAt < NONE_TTL_MS) return null;
  try {
    const r = await get<ChaptersResponse>(`/episodes/${episodeId}/chapters`);
    const rec: ChaptersRec = { episodeId, source: r.source, chapters: r.chapters, fetchedAt: Date.now() };
    await db.chapters.put(rec);
    return rec;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      await db.chapters.put({ episodeId, source: null, chapters: [], none: true, fetchedAt: Date.now() });
    }
    return null; // offline or a server problem: just show no chapters, and ask again next time
  }
}

/** The episode's chapters, loaded in the background. `undefined` while loading, `null` when there are none. */
export function useChapters(episodeId: string | undefined): ChaptersRec | null | undefined {
  const { db } = useApp();
  const [rec, setRec] = useState<ChaptersRec | null | undefined>(undefined);
  useEffect(() => {
    if (!episodeId) return;
    let live = true;
    setRec(undefined);
    void loadChapters(db, episodeId).then((r) => live && setRec(r));
    return () => void (live = false);
  }, [db, episodeId]);
  return episodeId ? rec : null;
}

/** Index of the chapter containing `ms`, or -1 before the first one. */
export function chapterIndexAt(chapters: Chapter[], ms: number): number {
  let ans = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i]!.startMs <= ms) ans = i;
    else break;
  }
  return ans;
}
