import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { Episode, Podcast } from '../db/types.js';
import { HttpError } from '../util/errors.js';
import { jitter, now } from '../util/misc.js';
import { safeFetchBuffer, SsrfError } from '../security/ssrf.js';
import { looksPrivateFeed, normalizeFeedUrl, parseFeed, type ParsedFeed } from './feedParser.js';
import type { SettingsService } from './settings.js';
import type { UsageService } from './usage.js';

export const FEED_MAX_BYTES = 10 * 1024 * 1024;
const FEED_TIMEOUT_MS = 20_000;

export interface RefreshResult {
  ok: boolean;
  notModified?: boolean;
  newEpisodes: number;
  error?: string;
}

export class FeedService {
  private inflight = new Map<string, Promise<RefreshResult>>();

  /** Called after a refresh found new episodes (wired to auto-transcribe). */
  onNewEpisodes: (() => void) | null = null;

  constructor(
    private db: Database,
    private config: Config,
    private usage: UsageService,
    private settings: SettingsService,
  ) {}

  subscriberIds(podcastId: string): string[] {
    return this.db.subscriptions.find({ podcastId }).filter((s) => !s.deleted).map((s) => s.userId);
  }

  subscriberCount(podcastId: string): number {
    return this.db.subscriptions.find({ podcastId }).filter((s) => !s.deleted).length;
  }

  private nextFetchDelay(failures: number): number {
    const base = this.settings.get().pollIntervalMinutes * 60_000;
    return failures === 0 ? jitter(base) : jitter(Math.min(base * 2 ** failures, 24 * 3600_000));
  }

  /** Attribute fetched bytes to subscribers (or one explicit user) for the usage report. */
  private attributeBytes(podcastId: string, bytes: number, userId?: string): void {
    const users = userId ? [userId] : this.subscriberIds(podcastId);
    if (!users.length || bytes <= 0) return;
    const each = Math.floor(bytes / users.length);
    users.forEach((u, i) => this.usage.add(u, 'feedBytes', i === 0 ? each + (bytes - each * users.length) : each));
  }

  private upsertEpisodes(podcast: Podcast, parsed: ParsedFeed): number {
    const existing = new Map(this.db.episodes.find({ podcastId: podcast.id }).map((e) => [e.guid, e]));
    let created = 0;
    const t = now();
    for (const p of parsed.episodes) {
      const cur = existing.get(p.guid);
      if (!cur) {
        this.db.episodes.insert({
          podcastId: podcast.id,
          guid: p.guid,
          title: p.title,
          description: p.description,
          audioUrl: p.audioUrl,
          mimeType: p.mimeType,
          durationSec: p.durationSec,
          releasedAt: p.releasedAt ?? t,
          createdAt: t,
          transcriptUrl: p.transcriptUrl,
          transcriptType: p.transcriptType,
        });
        created++;
      } else {
        const next: Partial<Episode> = {
          title: p.title,
          description: p.description,
          audioUrl: p.audioUrl,
          mimeType: p.mimeType,
          durationSec: p.durationSec || cur.durationSec,
          releasedAt: p.releasedAt ?? cur.releasedAt,
          transcriptUrl: p.transcriptUrl,
          transcriptType: p.transcriptType,
        };
        const changed = (Object.keys(next) as (keyof Episode)[]).some((k) => cur[k] !== next[k]);
        if (changed || cur.deleted) {
          Object.assign(cur, next, { deleted: false });
          this.db.episodes.save(cur);
        }
      }
    }
    return created;
  }

  private applyMeta(podcast: Podcast, parsed: ParsedFeed): void {
    const next = { title: parsed.title, author: parsed.author, description: parsed.description, imageUrl: parsed.imageUrl };
    if ((Object.keys(next) as (keyof typeof next)[]).some((k) => podcast[k] !== next[k])) Object.assign(podcast, next);
  }

  /** Fetch and ingest one feed. Concurrent calls for the same feed share one fetch. */
  refresh(podcast: Podcast, opts: { userId?: string; force?: boolean } = {}): Promise<RefreshResult> {
    const existing = this.inflight.get(podcast.id);
    if (existing) return existing;
    const p = this.doRefresh(podcast, opts).finally(() => this.inflight.delete(podcast.id));
    this.inflight.set(podcast.id, p);
    return p;
  }

  private async doRefresh(podcast: Podcast, opts: { userId?: string; force?: boolean }): Promise<RefreshResult> {
    const started = now();
    const headers: Record<string, string> = { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' };
    if (!opts.force) {
      if (podcast.etag) headers['if-none-match'] = podcast.etag;
      if (podcast.lastModified) headers['if-modified-since'] = podcast.lastModified;
    }
    try {
      const res = await safeFetchBuffer(podcast.feedUrl, {
        maxBytes: FEED_MAX_BYTES,
        timeoutMs: FEED_TIMEOUT_MS,
        headers,
        allowPrivate: this.config.allowPrivateNetworks,
      });
      this.attributeBytes(podcast.id, res.bytes, opts.userId);
      podcast.lastFetchMs = now() - started;
      podcast.lastFetchedAt = now();
      if (res.status === 304) {
        podcast.fetchError = null;
        podcast.failureCount = 0;
        podcast.nextFetchAt = now() + this.nextFetchDelay(0);
        this.db.podcasts.saveQuiet(podcast);
        return { ok: true, notModified: true, newEpisodes: 0 };
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}${res.status === 410 ? ' Gone' : ''}`);
      const parsed = parseFeed(res.body.toString('utf8'), this.config.maxEpisodesPerFeed);
      this.applyMeta(podcast, parsed);
      const created = this.upsertEpisodes(podcast, parsed);
      const etag = res.headers.etag;
      const lm = res.headers['last-modified'];
      podcast.etag = typeof etag === 'string' ? etag : null;
      podcast.lastModified = typeof lm === 'string' ? lm : null;
      podcast.fetchError = null;
      podcast.failureCount = 0;
      podcast.nextFetchAt = now() + this.nextFetchDelay(0);
      this.db.podcasts.save(podcast);
      if (created > 0) this.onNewEpisodes?.();
      return { ok: true, newEpisodes: created };
    } catch (e) {
      const msg = e instanceof SsrfError ? e.message : e instanceof Error ? e.message : 'Fetch failed';
      podcast.lastFetchMs = now() - started;
      podcast.lastFetchedAt = now();
      podcast.fetchError = (/timeout|UND_ERR/i.test(msg) ? 'Timed out' : msg).slice(0, 200);
      podcast.failureCount += 1;
      podcast.nextFetchAt = now() + this.nextFetchDelay(podcast.failureCount);
      this.db.podcasts.saveQuiet(podcast);
      return { ok: false, newEpisodes: 0, error: podcast.fetchError };
    }
  }

  /** Validate a feed URL, create the podcast if new, and return it. The caller subscribes. */
  async addByUrl(userId: string, rawUrl: string, declaredPrivate = false): Promise<Podcast> {
    let feedUrl: string;
    try {
      feedUrl = normalizeFeedUrl(rawUrl);
    } catch {
      throw new HttpError(400, 'Invalid feed URL', 'invalid_feed');
    }
    const existing = this.db.podcasts.findOne({ feedUrl });
    if (existing) {
      if (existing.deleted) {
        existing.deleted = false;
        this.db.podcasts.save(existing);
      }
      if (declaredPrivate && !existing.isPrivate) {
        existing.isPrivate = true;
        this.db.podcasts.save(existing);
      }
      return existing;
    }
    let res;
    try {
      res = await safeFetchBuffer(feedUrl, { maxBytes: FEED_MAX_BYTES, timeoutMs: FEED_TIMEOUT_MS, allowPrivate: this.config.allowPrivateNetworks });
    } catch (e) {
      throw new HttpError(400, e instanceof SsrfError ? e.message : `Could not fetch feed: ${e instanceof Error ? e.message : 'error'}`, 'invalid_feed');
    }
    this.usage.add(userId, 'feedBytes', res.bytes);
    if (res.status < 200 || res.status >= 300) throw new HttpError(400, `Feed returned HTTP ${res.status}`, 'invalid_feed');
    let parsed: ParsedFeed;
    try {
      parsed = parseFeed(res.body.toString('utf8'), this.config.maxEpisodesPerFeed);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : 'Invalid feed', 'invalid_feed');
    }
    const t = now();
    const etag = res.headers.etag;
    const lm = res.headers['last-modified'];
    const podcast = this.db.podcasts.insert({
      feedUrl,
      isPrivate: declaredPrivate || looksPrivateFeed(feedUrl),
      hiddenFromDiscover: false,
      title: parsed.title,
      author: parsed.author,
      imageUrl: parsed.imageUrl,
      description: parsed.description,
      createdAt: t,
      lastFetchedAt: t,
      lastFetchMs: null,
      etag: typeof etag === 'string' ? etag : null,
      lastModified: typeof lm === 'string' ? lm : null,
      fetchError: null,
      failureCount: 0,
      nextFetchAt: t + this.nextFetchDelay(0),
      createdBy: userId,
    });
    this.upsertEpisodes(podcast, parsed);
    return podcast;
  }

  /** Create or revive a subscription (clients may also create these through sync). */
  subscribe(userId: string, podcastId: string) {
    const existing = this.db.subscriptions.find({ userId, podcastId })[0];
    if (existing) {
      if (existing.deleted) {
        existing.deleted = false;
        existing.clientUpdatedAt = now();
        return this.db.subscriptions.save(existing);
      }
      return existing;
    }
    return this.db.subscriptions.insert({
      userId,
      podcastId,
      autoDownload: { mode: 'off' },
      newEpisodeNotify: true,
      clientUpdatedAt: now(),
      deleted: false,
    });
  }

  /** Feeds with no subscribers (spec: admin "remove orphans"). Their episodes go with them. */
  removeOrphans(): number {
    let n = 0;
    for (const p of this.db.podcasts.find()) {
      if (this.subscriberCount(p.id) === 0) {
        const eps = this.db.episodes.find({ podcastId: p.id });
        for (const e of eps) {
          const tr = this.db.transcripts.findOne({ episodeId: e.id });
          if (tr) this.db.transcripts.remove(tr);
          this.db.episodes.remove(e);
        }
        this.db.podcasts.remove(p);
        n++;
      }
    }
    return n;
  }
}

export class FeedPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private db: Database,
    private feeds: FeedService,
    private log: { warn: (o: unknown, m?: string) => void },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    setTimeout(() => void this.tick(), 5000).unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(concurrency = 3): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const t = now();
      const due = this.db.podcasts.where((p) => !p.deleted && p.nextFetchAt <= t && this.feeds.subscriberCount(p.id) > 0);
      let i = 0;
      const worker = async () => {
        while (i < due.length) {
          const p = due[i++]!;
          try {
            await this.feeds.refresh(p);
          } catch (e) {
            this.log.warn({ err: e, podcast: p.id }, 'feed poll failed');
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
      return due.length;
    } finally {
      this.running = false;
    }
  }
}
