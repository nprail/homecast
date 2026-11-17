import type { TranscriptSearchItem, TranscriptSearchResponse } from '@homecast/shared';
import type { Database } from '../db/index.js';
import { TranscriptIndex } from '../search/index.js';

const HITS_PER_EPISODE = 3;
const SLICE_MS = 12;

/**
 * Full-text search over transcripts, ranked, with phrases, `-excluded` words, prefix matching on the last word and
 * typo tolerance (see `search/index.ts`). The index is built in small slices after start-up, kept current as
 * transcripts are added and removed, and finished on the spot if a search arrives before it is ready.
 */
export class SearchService {
  readonly index: TranscriptIndex;
  private todo: { id: string; episodeId: string }[] | null = null;
  private touched = new Set<string>();
  private timer: NodeJS.Immediate | null = null;
  private stopped = false;
  private built = false;

  constructor(private db: Database) {
    this.index = new TranscriptIndex((episodeId) => db.transcripts.findOne({ episodeId })?.segments ?? null);
    db.onTranscriptChange((c) => {
      this.touched.add(c.doc.episodeId);
      if (c.kind === 'remove') this.index.remove(c.doc.episodeId);
      else this.index.add(c.doc.episodeId, c.doc.segments);
    });
  }

  /** Start building the index in the background. */
  warm(): void {
    if (this.todo || this.built || this.stopped) return;
    this.todo = this.db.transcripts.find().map((t) => ({ id: t.id, episodeId: t.episodeId }));
    this.timer = setImmediate(() => this.slice());
  }

  /** Stop background work (shutdown). */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearImmediate(this.timer);
    this.timer = null;
  }

  private slice(): void {
    this.timer = null;
    if (this.stopped) return;
    this.build(SLICE_MS);
    if (this.todo) this.timer = setImmediate(() => this.slice());
  }

  /** Index transcripts for up to `budgetMs`; clears `todo` when done. */
  private build(budgetMs: number): void {
    const end = Date.now() + budgetMs;
    while (this.todo && this.todo.length) {
      const next = this.todo.pop()!;
      if (!this.touched.has(next.episodeId)) {
        const tr = this.db.transcripts.get(next.id);
        if (tr) this.index.add(tr.episodeId, tr.segments);
      }
      if (Date.now() >= end) return;
    }
    this.todo = null;
    this.built = true;
    this.touched.clear();
  }

  /** `podcastIds` is the set the caller may search (their subscriptions). */
  transcripts(q: string, podcastIds: Set<string>, opts: { podcastId?: string; limit: number; offset: number }): TranscriptSearchResponse {
    if (!this.built) {
      this.todo ??= this.db.transcripts.find().map((t) => ({ id: t.id, episodeId: t.episodeId }));
      this.build(Infinity);
    }
    const scope = opts.podcastId ? (podcastIds.has(opts.podcastId) ? new Set([opts.podcastId]) : new Set<string>()) : podcastIds;
    const usable = (episodeId: string) => {
      const ep = this.db.episodes.get(episodeId);
      return !!ep && !ep.deleted && scope.has(ep.podcastId);
    };
    const out = this.index.search(q, usable);
    const withDate = out.ranked.map((r) => ({ r, at: this.db.episodes.get(r.episodeId)?.releasedAt ?? 0 }));
    withDate.sort((a, b) => b.r.score - a.r.score || b.at - a.at);
    const items: TranscriptSearchItem[] = [];
    for (const { r } of withDate.slice(opts.offset, opts.offset + opts.limit)) {
      const ep = this.db.episodes.get(r.episodeId)!;
      const podcast = this.db.podcasts.get(ep.podcastId);
      items.push({ episodeId: ep.id, podcastId: ep.podcastId, episodeTitle: ep.title, podcastTitle: podcast?.title ?? '', releasedAt: ep.releasedAt, matches: r.matches, hits: out.hits(r, HITS_PER_EPISODE) });
    }
    return { total: withDate.length, items };
  }
}
