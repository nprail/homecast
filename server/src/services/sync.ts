import { SYNC_USER_COLLECTIONS, type SyncRequest, type SyncResponse, type SyncedRecord, type SyncUserCollection } from '@homecast/shared';
import type { Database } from '../db/index.js';
import type { Episode, Podcast, User } from '../db/types.js';
import { clean, now } from '../util/misc.js';

const PAGE_LIMIT = 500;
type Rejected = SyncResponse['rejected'];

interface Candidate {
  collection: keyof SyncResponse['changes'];
  rec: SyncedRecord;
  rev: number;
}

export class SyncService {
  constructor(private db: Database) {}

  sync(user: User, req: SyncRequest): SyncResponse {
    const rejected: Rejected = [];
    this.applyChanges(user, req.changes, rejected);

    let cursor = req.cursor;
    let fullResync = false;
    if (cursor > 0 && cursor < this.db.horizon) {
      cursor = 0;
      fullResync = true;
    }
    const candidates = this.collect(user, cursor);
    candidates.sort((a, b) => a.rev - b.rev);

    // Page on whole rev groups so the numeric cursor never splits records that share a rev.
    let end = 0;
    while (end < candidates.length) {
      let groupEnd = end;
      while (groupEnd < candidates.length && candidates[groupEnd]!.rev === candidates[end]!.rev) groupEnd++;
      end = groupEnd;
      if (end >= PAGE_LIMIT) break;
    }
    const page = candidates.slice(0, end);
    const hasMore = end < candidates.length;
    const changes: SyncResponse['changes'] = { podcasts: [], episodes: [], episodeStates: [], bookmarks: [], playlists: [], smartPlaylists: [], settings: [], subscriptions: [] };
    for (const c of page) changes[c.collection].push(c.rec);
    const newCursor = hasMore ? page[page.length - 1]!.rev : Math.max(this.db.currentRev, cursor);
    return { cursor: newCursor, hasMore, fullResync, rejected, changes };
  }

  // ---- reading ------------------------------------------------------------------------------

  private collect(user: User, cursor: number): Candidate[] {
    const out: Candidate[] = [];
    const push = (collection: Candidate['collection'], doc: object, rev: number) => {
      const rec = (collection === 'podcasts' ? this.podcastView(doc as Podcast) : collection === 'episodes' ? this.episodeView(doc as Episode) : clean(doc)) as unknown as SyncedRecord;
      rec.deleted = !!rec.deleted;
      out.push({ collection, rec, rev });
    };
    const userRepos = {
      episodeStates: this.db.episodeStates,
      bookmarks: this.db.bookmarks,
      playlists: this.db.playlists,
      smartPlaylists: this.db.smartPlaylists,
      settings: this.db.userSettings,
      subscriptions: this.db.subscriptions,
    } as const;
    for (const name of SYNC_USER_COLLECTIONS) {
      const repo = userRepos[name] as { find: (q: object) => { rev?: number; userId: string }[] };
      for (const d of repo.find({ userId: user.id })) if ((d.rev ?? 0) > cursor) push(name, d, d.rev ?? 0);
    }

    // Shared records for subscribed feeds. A subscription newer than the cursor backfills the
    // whole feed, with the subscription's rev as the records' effective rev.
    const subRev = new Map<string, number>();
    for (const s of this.db.subscriptions.find({ userId: user.id })) if (!s.deleted) subRev.set(s.podcastId, s.rev ?? 0);
    for (const [podcastId, sRev] of subRev) {
      const backfill = sRev > cursor;
      const p = this.db.podcasts.get(podcastId);
      if (p && !p.deleted) {
        const eff = Math.max(p.rev ?? 0, backfill ? sRev : 0);
        if (backfill || (p.rev ?? 0) > cursor) push('podcasts', p, eff);
      }
      for (const e of this.db.episodes.find({ podcastId })) {
        const eff = Math.max(e.rev ?? 0, backfill ? sRev : 0);
        if (backfill ? !e.deleted || (e.rev ?? 0) > cursor : (e.rev ?? 0) > cursor) push('episodes', e, eff);
      }
    }
    return out;
  }

  /** Only fields clients need: no fetch bookkeeping or owner ids. */
  private podcastView(p: Podcast) {
    return { id: p.id, rev: p.rev, deleted: !!p.deleted, feedUrl: p.feedUrl, isPrivate: p.isPrivate, title: p.title, author: p.author, imageUrl: p.imageUrl, description: p.description };
  }
  private episodeView(e: Episode) {
    return {
      id: e.id, rev: e.rev, deleted: !!e.deleted, podcastId: e.podcastId, guid: e.guid, title: e.title, description: e.description, audioUrl: e.audioUrl,
      mimeType: e.mimeType, durationSec: e.durationSec, releasedAt: e.releasedAt, hasPublisherTranscript: !!e.transcriptUrl,
    };
  }

  // ---- writing ------------------------------------------------------------------------------

  private applyChanges(user: User, changes: SyncRequest['changes'], rejected: Rejected): void {
    const t = now();
    const clamp = (ts: number) => Math.min(ts, t);
    const reject = (collection: SyncUserCollection, id: string, reason: string) => rejected.push({ collection, id, reason });

    for (const c of changes.settings) {
      const existing = this.db.userSettings.find({ userId: user.id })[0];
      if (!existing) {
        if (this.db.userSettings.get(c.id)) {
          reject('settings', c.id, 'forbidden');
          continue;
        }
        this.db.userSettings.insert({ id: c.id, userId: user.id, defaultSpeed: c.defaultSpeed, podcastSpeeds: c.podcastSpeeds, prefs: c.prefs, clientUpdatedAt: clamp(c.clientUpdatedAt), deleted: false });
      } else if (clamp(c.clientUpdatedAt) >= existing.clientUpdatedAt) {
        Object.assign(existing, { defaultSpeed: c.defaultSpeed, podcastSpeeds: c.podcastSpeeds, prefs: c.prefs, clientUpdatedAt: clamp(c.clientUpdatedAt), deleted: false });
        this.db.userSettings.save(existing);
      }
    }

    for (const c of changes.subscriptions) {
      const byId = this.db.subscriptions.get(c.id);
      if (byId && byId.userId !== user.id) {
        reject('subscriptions', c.id, 'forbidden');
        continue;
      }
      const existing = byId ?? this.db.subscriptions.find({ userId: user.id, podcastId: c.podcastId })[0];
      const ts = clamp(c.clientUpdatedAt);
      if (!existing) {
        const podcast = this.db.podcasts.get(c.podcastId);
        // Private feeds can only be added with their feed URL (POST /podcasts), never by id.
        if (!podcast || podcast.deleted || podcast.isPrivate) {
          reject('subscriptions', c.id, 'unknown_podcast');
          continue;
        }
        if (!c.deleted) this.db.subscriptions.insert({ id: c.id, userId: user.id, podcastId: c.podcastId, autoDownload: c.autoDownload, newEpisodeNotify: c.newEpisodeNotify, clientUpdatedAt: ts, deleted: false });
      } else if (ts >= existing.clientUpdatedAt) {
        Object.assign(existing, { autoDownload: c.autoDownload, newEpisodeNotify: c.newEpisodeNotify, clientUpdatedAt: ts, deleted: !!c.deleted });
        existing.deletedAt = c.deleted ? t : undefined;
        this.db.subscriptions.save(existing);
      }
    }

    for (const c of changes.playlists) {
      const existing = this.db.playlists.get(c.id);
      if (existing && existing.userId !== user.id) {
        reject('playlists', c.id, 'forbidden');
        continue;
      }
      const ts = clamp(c.clientUpdatedAt);
      if (!existing) {
        this.db.playlists.insert({ id: c.id, userId: user.id, name: c.name, episodeIds: c.episodeIds, clientUpdatedAt: ts, deleted: !!c.deleted, deletedAt: c.deleted ? t : undefined });
      } else if (ts >= existing.clientUpdatedAt) {
        // Playlists are replaced whole (LWW).
        Object.assign(existing, { name: c.name, episodeIds: c.episodeIds, clientUpdatedAt: ts, deleted: !!c.deleted, deletedAt: c.deleted ? t : undefined });
        this.db.playlists.save(existing);
      }
    }

    for (const c of changes.smartPlaylists) {
      const existing = this.db.smartPlaylists.get(c.id);
      if (existing && existing.userId !== user.id) {
        reject('smartPlaylists', c.id, 'forbidden');
        continue;
      }
      const ts = clamp(c.clientUpdatedAt);
      if (!existing) {
        this.db.smartPlaylists.insert({ id: c.id, userId: user.id, name: c.name, definition: c.definition, clientUpdatedAt: ts, deleted: !!c.deleted, deletedAt: c.deleted ? t : undefined });
      } else if (ts >= existing.clientUpdatedAt) {
        Object.assign(existing, { name: c.name, definition: c.definition, clientUpdatedAt: ts, deleted: !!c.deleted, deletedAt: c.deleted ? t : undefined });
        this.db.smartPlaylists.save(existing);
      }
    }

    for (const c of changes.bookmarks) {
      const existing = this.db.bookmarks.get(c.id);
      if (existing && existing.userId !== user.id) {
        reject('bookmarks', c.id, 'forbidden');
        continue;
      }
      const ts = clamp(c.clientUpdatedAt);
      if (!existing) {
        if (!this.db.episodes.get(c.episodeId)) {
          reject('bookmarks', c.id, 'unknown_episode');
          continue;
        }
        this.db.bookmarks.insert({ id: c.id, userId: user.id, episodeId: c.episodeId, positionMs: c.positionMs, title: c.title ?? null, note: c.note ?? null, createdAt: Math.min(c.createdAt, t), clientUpdatedAt: ts, deleted: !!c.deleted, deletedAt: c.deleted ? t : undefined });
      } else if (ts >= existing.clientUpdatedAt) {
        Object.assign(existing, { positionMs: c.positionMs, title: c.title ?? null, note: c.note ?? null, clientUpdatedAt: ts, deleted: !!c.deleted, deletedAt: c.deleted ? t : undefined });
        this.db.bookmarks.save(existing);
      }
    }

    for (const c of changes.episodeStates) {
      const byId = this.db.episodeStates.get(c.id);
      if (byId && byId.userId !== user.id) {
        reject('episodeStates', c.id, 'forbidden');
        continue;
      }
      const existing = byId ?? this.db.episodeStates.find({ userId: user.id, episodeId: c.episodeId })[0];
      const ts = clamp(c.clientUpdatedAt);
      const posTs = clamp(c.positionUpdatedAt ?? c.clientUpdatedAt);
      if (!existing) {
        if (!this.db.episodes.get(c.episodeId)) {
          reject('episodeStates', c.id, 'unknown_episode');
          continue;
        }
        this.db.episodeStates.insert({ id: c.id, userId: user.id, episodeId: c.episodeId, status: c.status, positionMs: c.positionMs, positionUpdatedAt: posTs, playedAt: c.playedAt ?? null, starred: c.starred, clientUpdatedAt: ts, deleted: !!c.deleted });
        continue;
      }
      let changed = false;
      // positionMs takes the most recent play event, independent of other fields.
      if (posTs > existing.positionUpdatedAt) {
        existing.positionMs = c.positionMs;
        existing.positionUpdatedAt = posTs;
        changed = true;
      }
      if (ts >= existing.clientUpdatedAt) {
        // Newer write wins for status, starred and tombstone.
        Object.assign(existing, { status: c.status, starred: c.starred, playedAt: c.playedAt ?? existing.playedAt, clientUpdatedAt: ts, deleted: !!c.deleted });
        changed = true;
      } else if (c.status === 'played' && existing.status === 'inProgress') {
        // Older "played" still wins over a newer mere progress update (but not over an explicit unplayed).
        existing.status = 'played';
        existing.playedAt = c.playedAt ?? existing.playedAt;
        changed = true;
      }
      if (changed) this.db.episodeStates.save(existing);
    }
  }

  /** Remove tombstones older than 90 days and raise the resync horizon. */
  purgeTombstones(): number {
    const cutoff = now() - 90 * 86_400_000;
    let removed = 0;
    let maxRev = 0;
    const repos = [this.db.episodeStates, this.db.bookmarks, this.db.playlists, this.db.smartPlaylists, this.db.userSettings, this.db.subscriptions, this.db.episodes, this.db.podcasts] as const;
    for (const repo of repos) {
      const r = repo as unknown as { where: (fn: (d: { deleted?: boolean; deletedAt?: number; rev?: number }) => boolean) => { rev?: number }[]; remove: (d: never) => void };
      for (const d of r.where((x) => !!x.deleted && (x.deletedAt ?? 0) > 0 && (x.deletedAt ?? 0) < cutoff)) {
        maxRev = Math.max(maxRev, d.rev ?? 0);
        r.remove(d as never);
        removed++;
      }
    }
    if (removed) this.db.raiseHorizon(maxRev);
    return removed;
  }
}
