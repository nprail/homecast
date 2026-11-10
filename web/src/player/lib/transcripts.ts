import type { TranscriptSegment } from '@homecast/shared';
import { ApiError, get, post } from '../../lib/api';
import type { PodDB, TranscriptRec } from './db';

export type TranscriptStatus =
  | { state: 'ready'; rec: TranscriptRec }
  | { state: 'none' }
  | { state: 'pending'; stage: string | null; progress: number | null; queuePosition: number | null }
  | { state: 'offline' };

interface JobDto {
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: string | null;
  progress: number | null;
  queuePosition: number | null;
  error: string | null;
}
interface TranscriptResponse {
  status: 'ready' | 'queued' | 'running';
  source?: 'feed' | 'whisper';
  model?: string | null;
  segments?: TranscriptSegment[];
  job?: JobDto | null;
}

/** Clients fetch and cache transcripts for offline reading (spec §3.8). */
export async function loadTranscript(db: PodDB, episodeId: string): Promise<TranscriptStatus> {
  const cached = await db.transcripts.get(episodeId);
  if (cached) return { state: 'ready', rec: cached };
  try {
    const r = await get<TranscriptResponse>(`/episodes/${episodeId}/transcript`);
    return await absorb(db, episodeId, r);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { state: 'none' };
    if (e instanceof TypeError) return { state: 'offline' };
    throw e;
  }
}

/** Queue generation (any user may; requests are deduplicated per episode on the server). */
export async function requestTranscript(db: PodDB, episodeId: string): Promise<TranscriptStatus> {
  const r = await post<TranscriptResponse>(`/episodes/${episodeId}/transcript`);
  return absorb(db, episodeId, r);
}

async function absorb(db: PodDB, episodeId: string, r: TranscriptResponse): Promise<TranscriptStatus> {
  if (r.status === 'ready' && r.segments) {
    const rec: TranscriptRec = { episodeId, source: r.source ?? 'whisper', model: r.model ?? null, segments: r.segments };
    await db.transcripts.put(rec);
    return { state: 'ready', rec };
  }
  if (r.status === 'ready') return loadTranscript(db, episodeId);
  return { state: 'pending', stage: r.job?.stage ?? null, progress: r.job?.progress ?? null, queuePosition: r.job?.queuePosition ?? null };
}

/** Index of the segment containing `ms` (binary search). */
export function activeSegment(segs: TranscriptSegment[], ms: number): number {
  let lo = 0;
  let hi = segs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]!.startMs <= ms) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export const modelLabel = (r: TranscriptRec): string => (r.source === 'feed' ? 'Publisher transcript' : `Whisper · ${(r.model ?? 'base').replace(/^ggml-/, '').split('-')[0]}`);
