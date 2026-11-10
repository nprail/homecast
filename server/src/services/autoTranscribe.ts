import type { Database } from '../db/index.js';
import type { Episode } from '../db/types.js';
import type { FeedService } from './feeds.js';
import type { SettingsService } from './settings.js';
import { SYSTEM_USER, type TranscriptService } from './transcripts.js';

/** At most this many auto-queued jobs wait in the queue; the rest are fed in as they finish. */
const QUEUE_HEADROOM = 3;

/**
 * Queues transcripts automatically (settings: off / new episodes / all episodes, for every podcast or a
 * selection). Only podcasts somebody subscribes to are considered. A large back catalogue is fed into
 * the queue a few episodes at a time, newest first, so manual requests are never stuck behind hundreds
 * of jobs. An episode that already has a job (done, failed or cancelled) is not queued again.
 */
export class AutoTranscriber {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database,
    private settings: SettingsService,
    private transcripts: TranscriptService,
    private feeds: FeedService,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
    setTimeout(() => this.tick(), 8000).unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Episodes that auto-transcribe would still process, newest first. */
  eligible(): Episode[] {
    const cfg = this.settings.get().autoTranscribe;
    if (!cfg.enabled) return [];
    const allowed = cfg.podcastIds ? new Set(cfg.podcastIds) : null;
    const jobbed = new Set(this.db.jobs.find().map((j) => j.episodeId));
    const out: Episode[] = [];
    for (const p of this.db.podcasts.where((x) => !x.deleted && (!allowed || allowed.has(x.id)))) {
      if (this.feeds.subscriberCount(p.id) === 0) continue;
      for (const e of this.db.episodes.find({ podcastId: p.id })) {
        if (e.deleted || jobbed.has(e.id) || this.transcripts.get(e.id)) continue;
        if (cfg.scope === 'new' && e.createdAt < cfg.enabledAt) continue;
        out.push(e);
      }
    }
    return out.sort((a, b) => b.releasedAt - a.releasedAt);
  }

  /** Queue the next few eligible episodes. Returns how many were queued. */
  tick(): number {
    const waiting = this.db.jobs.find().filter((j) => j.requestedBy === SYSTEM_USER && (j.status === 'queued' || j.status === 'running')).length;
    const room = QUEUE_HEADROOM - waiting;
    if (room <= 0) return 0;
    const next = this.eligible().slice(0, room);
    for (const e of next) this.transcripts.request(SYSTEM_USER, e.id);
    return next.length;
  }
}
