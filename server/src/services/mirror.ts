import { mkdirSync, renameSync, rmSync, existsSync, statfsSync } from 'node:fs';
import path from 'node:path';
import type { EpisodeMirrorStatus } from '@homecast/shared';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { Episode, EpisodeMirror } from '../db/types.js';
import { safeDownloadToFile, SsrfError } from '../security/ssrf.js';
import { now } from '../util/misc.js';
import type { SettingsService } from './settings.js';

/** One episode's audio is never mirrored above this size. */
export const MAX_EPISODE_BYTES = 4 * 1024 ** 3;
/** Copying stops while less than this is free on the data disk, so the database and backups can't be starved. */
export const DISK_RESERVE_BYTES = 5 * 1024 ** 3;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const TICK_MS = 5 * 60_000;
const RETRY_BASE_MS = 15 * 60_000;
const RETRY_MAX_MS = 24 * 3600_000;

export interface LocalAudio {
  path: string;
  mimeType: string;
  bytes: number;
}

type Stop = 'cap' | 'disk' | null;

/**
 * Optional server-side copies of episode audio ("episode hosting"). Off by default.
 *
 * When enabled, every episode of a podcast that someone subscribes to is downloaded once into
 * DATA_DIR/media, one at a time, newest first. Copies are used by the audio proxy (so downloads come
 * from the server) and by the transcript worker. Copies are removed when the episode leaves the
 * database, its podcast loses all subscribers, or the feed changes the audio URL. Turning hosting off
 * keeps existing copies; they can be deleted explicitly from the admin dashboard.
 */
export class MirrorService {
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private abort = new AbortController();
  private stoppedReason: Stop = null;
  private lastError: string | null = null;

  constructor(
    private db: Database,
    private config: Config,
    private settings: SettingsService,
    private log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
  ) {}

  get dir(): string {
    return path.join(this.config.dataDir, 'media');
  }

  enabled(): boolean {
    return this.settings.get().episodeMirror.enabled;
  }

  start(): void {
    this.timer = setInterval(() => void this.kick(), TICK_MS);
    this.timer.unref();
    setTimeout(() => void this.kick(), 30_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
  }

  /**
   * Start copying if hosting is enabled and no copy run is already in progress. Resolves when the run
   * finishes (immediately when disabled). Tests await this; the server just fires it and forgets.
   */
  kick(): Promise<void> {
    if (this.running) return this.running;
    if (!this.enabled()) return Promise.resolve();
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** The local copy of an episode, if one is complete and still matches the feed's audio URL. */
  localAudio(episode: Pick<Episode, 'id' | 'audioUrl'>): LocalAudio | null {
    const rec = this.db.episodeMirrors.get(episode.id);
    if (!rec || rec.status !== 'ready' || !rec.file || rec.sourceUrl !== episode.audioUrl) return null;
    const file = path.join(this.dir, rec.file);
    if (!existsSync(file)) return null;
    return { path: file, mimeType: rec.mimeType, bytes: rec.bytes };
  }

  localAudioById(episodeId: string): LocalAudio | null {
    const ep = this.db.episodes.get(episodeId);
    return ep && !ep.deleted ? this.localAudio(ep) : null;
  }

  // ---- the copy loop --------------------------------------------------------------------------

  private async run(): Promise<void> {
    this.stoppedReason = null;
    this.lastError = null;
    this.sweep();
    while (this.enabled() && !this.abort.signal.aborted) {
      const next = this.nextCandidate();
      if (!next) break;
      const budget = this.budget();
      if (budget.stop) {
        this.stoppedReason = budget.stop;
        this.log.info({ reason: budget.stop }, 'episode hosting paused');
        break;
      }
      const outcome = await this.fetchOne(next, budget.maxBytes);
      if (outcome === 'limit') {
        this.stoppedReason = budget.binding;
        break;
      }
    }
  }

  /** How much more we may store right now, and which limit (if any) is binding. */
  private budget(): { stop: Stop; maxBytes: number; binding: Stop } {
    const { maxGB } = this.settings.get().episodeMirror;
    const free = this.freeBytes();
    const used = this.usedBytes();
    const capLeft = maxGB === null ? Infinity : maxGB * 1e9 - used;
    const diskLeft = free === null ? Infinity : free - DISK_RESERVE_BYTES;
    if (capLeft <= 0) return { stop: 'cap', maxBytes: 0, binding: 'cap' };
    if (diskLeft <= 0) return { stop: 'disk', maxBytes: 0, binding: 'disk' };
    const binding: Stop = capLeft === Infinity && diskLeft === Infinity ? null : capLeft <= diskLeft ? 'cap' : 'disk';
    return { stop: null, maxBytes: Math.min(MAX_EPISODE_BYTES, capLeft, diskLeft), binding };
  }

  /** The newest episode of a subscribed podcast that still needs a copy and isn't waiting on backoff. */
  private nextCandidate(): Episode | null {
    const t = now();
    const mirrors = new Map(this.db.episodeMirrors.find().map((m) => [m.id, m]));
    let best: Episode | null = null;
    for (const p of this.subscribedPodcastIds()) {
      for (const e of this.db.episodes.find({ podcastId: p })) {
        if (e.deleted || !this.needsCopy(e, mirrors.get(e.id), t)) continue;
        if (!best || e.releasedAt > best.releasedAt) best = e;
      }
    }
    return best;
  }

  private needsCopy(e: Episode, m: EpisodeMirror | undefined, t: number): boolean {
    if (!m) return true;
    if (m.status === 'failed') return m.nextAttemptAt <= t;
    // ready: current unless the file vanished or the feed changed the audio URL
    return !(this.localAudio(e) && m.sourceUrl === e.audioUrl);
  }

  private async fetchOne(ep: Episode, maxBytes: number): Promise<'ok' | 'failed' | 'limit'> {
    const file = `${ep.id}.audio`;
    const dest = path.join(this.dir, `${file}.part`);
    mkdirSync(this.dir, { recursive: true });
    try {
      const bytes = await safeDownloadToFile(ep.audioUrl, dest, {
        maxBytes,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        signal: this.abort.signal,
        allowPrivate: this.config.allowPrivateNetworks,
      });
      renameSync(dest, path.join(this.dir, file));
      this.record(ep, { status: 'ready', file, bytes, attempts: 0, error: null, nextAttemptAt: 0 });
      this.lastError = null;
      return 'ok';
    } catch (e) {
      rmSync(dest, { force: true });
      if (this.abort.signal.aborted) return 'failed';
      const msg = e instanceof Error ? e.message : 'download failed';
      if (/larger than/.test(msg) && maxBytes < MAX_EPISODE_BYTES) {
        // Doesn't fit in the space left under the cap or the disk reserve; not this episode's fault.
        return 'limit';
      }
      const attempts = (this.db.episodeMirrors.get(ep.id)?.attempts ?? 0) + 1;
      const error = /larger than/.test(msg) ? `Episode is larger than ${MAX_EPISODE_BYTES / 1024 ** 3} GB` : msg.slice(0, 300);
      const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
      this.record(ep, { status: 'failed', file: null, bytes: 0, attempts, error, nextAttemptAt: now() + backoff });
      this.lastError = `${ep.title}: ${error}`;
      this.log.warn({ episode: ep.id, error }, e instanceof SsrfError ? 'episode blocked by SSRF guard' : 'episode copy failed');
      return 'failed';
    }
  }

  private record(
    ep: Episode,
    patch: Pick<EpisodeMirror, 'status' | 'file' | 'bytes' | 'attempts' | 'error' | 'nextAttemptAt'>,
  ): void {
    const rec: EpisodeMirror = {
      id: ep.id,
      episodeId: ep.id,
      mimeType: ep.mimeType,
      sourceUrl: ep.audioUrl,
      at: now(),
      ...patch,
    };
    if (this.db.episodeMirrors.get(ep.id)) this.db.episodeMirrors.saveQuiet(Object.assign(this.db.episodeMirrors.get(ep.id)!, rec));
    else this.db.episodeMirrors.insert(rec);
  }

  // ---- housekeeping ---------------------------------------------------------------------------

  /** Remove copies that no longer belong to a subscribed episode, and records whose file is gone. */
  sweep(): number {
    let removed = 0;
    const subscribed = new Set(this.subscribedPodcastIds());
    for (const m of this.db.episodeMirrors.find()) {
      const ep = this.db.episodes.get(m.episodeId);
      const gone = !ep || ep.deleted || !subscribed.has(ep.podcastId);
      const missingFile = m.status === 'ready' && (!m.file || !existsSync(path.join(this.dir, m.file)));
      const staleUrl = !!ep && m.status === 'ready' && m.sourceUrl !== ep.audioUrl;
      if (gone || staleUrl || missingFile) {
        this.removeCopy(m);
        removed++;
      }
    }
    return removed;
  }

  /** Delete every hosted copy. Callers must check hosting is off. */
  deleteAll(): number {
    let n = 0;
    for (const m of this.db.episodeMirrors.find()) {
      this.removeCopy(m);
      n++;
    }
    rmSync(this.dir, { recursive: true, force: true });
    return n;
  }

  private removeCopy(m: EpisodeMirror): void {
    if (m.file) rmSync(path.join(this.dir, m.file), { force: true });
    this.db.episodeMirrors.remove(m);
  }

  // ---- reporting ------------------------------------------------------------------------------

  status(): EpisodeMirrorStatus {
    const t = now();
    const mirrors = new Map(this.db.episodeMirrors.find().map((m) => [m.id, m]));
    let pending = 0;
    for (const p of this.subscribedPodcastIds()) {
      for (const e of this.db.episodes.find({ podcastId: p })) {
        if (!e.deleted && this.needsCopy(e, mirrors.get(e.id), t)) pending++;
      }
    }
    const all = [...mirrors.values()];
    const stoppedReason = this.enabled() ? this.stoppedReason : null;
    return {
      hosted: all.filter((m) => m.status === 'ready').length,
      pending,
      failed: all.filter((m) => m.status === 'failed').length,
      bytes: this.usedBytes(),
      freeBytes: this.freeBytes(),
      lastError: this.lastError ?? all.find((m) => m.status === 'failed')?.error ?? null,
      stoppedReason,
    };
  }

  usedBytes(): number {
    return this.db.episodeMirrors.find().filter((m) => m.status === 'ready').reduce((a, m) => a + m.bytes, 0);
  }

  private freeBytes(): number | null {
    try {
      const s = statfsSync(this.config.dataDir);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }

  private subscribedPodcastIds(): string[] {
    const subs = new Set(this.db.subscriptions.find().filter((s) => !s.deleted).map((s) => s.podcastId));
    return [...subs].filter((id) => {
      const p = this.db.podcasts.get(id);
      return !!p && !p.deleted;
    });
  }
}
