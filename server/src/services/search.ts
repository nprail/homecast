import type { TranscriptSearchItem, TranscriptSearchResponse } from '@homecast/shared';
import type { Database } from '../db/index.js';

const HITS_PER_EPISODE = 3;
const SNIPPET_MAX = 240;

/** Lower-case only: cheap enough to run over every transcript line on each query. */
const fold = (s: string) => s.toLowerCase();

/** Words, plus "quoted phrases" kept whole. Every term must appear for a line to match. */
export function searchTerms(q: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const t = fold((m[1] ?? m[2] ?? '').replace(/\s+/g, ' ').trim());
    if (t.length) terms.push(t);
  }
  return [...new Set(terms)].slice(0, 8);
}

function snippet(text: string, terms: string[]): string {
  if (text.length <= SNIPPET_MAX) return text;
  const at = Math.max(0, fold(text).indexOf(terms[0] ?? ''));
  const start = Math.max(0, Math.min(at - 60, text.length - SNIPPET_MAX));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + SNIPPET_MAX)}${start + SNIPPET_MAX < text.length ? '…' : ''}`;
}

/**
 * Full-text search over transcripts. A scan, not an index: transcripts are plain arrays in memory
 * and a family-sized library is a few hundred episodes, so a query takes milliseconds to tens of ms.
 */
export class SearchService {
  constructor(private db: Database) {}

  /** `podcastIds` is the set the caller may search (their subscriptions). */
  transcripts(q: string, podcastIds: Set<string>, opts: { podcastId?: string; limit: number; offset: number }): TranscriptSearchResponse {
    const terms = searchTerms(q);
    if (!terms.length) return { total: 0, items: [] };
    const scope = opts.podcastId ? (podcastIds.has(opts.podcastId) ? new Set([opts.podcastId]) : new Set<string>()) : podcastIds;
    const matches = (text: string) => terms.every((t) => text.includes(t));
    const found: TranscriptSearchItem[] = [];
    for (const tr of this.db.transcripts.find()) {
      const ep = this.db.episodes.get(tr.episodeId);
      if (!ep || ep.deleted || !scope.has(ep.podcastId)) continue;
      const hits: TranscriptSearchItem['hits'] = [];
      let count = 0;
      const segs = tr.segments;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]!;
        const text = fold(seg.text);
        let hit: string | null = null;
        if (matches(text)) hit = seg.text;
        else if (terms.length > 1 || terms[0]!.includes(' ')) {
          // A phrase can straddle two lines of a transcript.
          const next = segs[i + 1];
          if (next && matches(`${text} ${fold(next.text)}`)) {
            hit = `${seg.text} ${next.text}`;
            i++;
          }
        }
        if (hit === null) continue;
        count++;
        if (hits.length < HITS_PER_EPISODE) hits.push({ startMs: seg.startMs, text: snippet(hit, terms) });
      }
      if (!count) continue;
      const podcast = this.db.podcasts.get(ep.podcastId);
      found.push({ episodeId: ep.id, podcastId: ep.podcastId, episodeTitle: ep.title, podcastTitle: podcast?.title ?? '', releasedAt: ep.releasedAt, matches: count, hits });
    }
    found.sort((a, b) => b.matches - a.matches || b.releasedAt - a.releasedAt);
    return { total: found.length, items: found.slice(opts.offset, opts.offset + opts.limit) };
  }
}
