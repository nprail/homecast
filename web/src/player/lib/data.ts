import type { SmartPlaylistDefinition } from '@homecast/shared';
import {
  defaultSettings, newId, settingsId, stateId, subId, upNextId, UP_NEXT_NAME,
  type AutoDownload, type BookmarkRec, type EpisodeStateRec, type PlaylistRec, type PodDB, type Prefs, type SettingsRec, type SmartPlaylistRec, type SubscriptionRec,
} from './db';
import type { SyncEngine } from './sync';

/**
 * All local writes go through here: each one stamps `clientUpdatedAt`, marks the row dirty, and
 * schedules a sync. Reads happen with `useLiveQuery` straight against the DB.
 */
export class LocalData {
  constructor(
    readonly db: PodDB,
    readonly sync: SyncEngine,
  ) {}
  get userId() {
    return this.db.userId;
  }
  private touch<T extends { clientUpdatedAt?: number; dirty?: 0 | 1 }>(r: T): T {
    return { ...r, clientUpdatedAt: Date.now(), dirty: 1 };
  }

  // ---- episode state ---------------------------------------------------------------------------
  async getState(episodeId: string): Promise<EpisodeStateRec> {
    return (
      (await this.db.episodeStates.where('episodeId').equals(episodeId).first()) ?? {
        id: stateId(this.userId, episodeId), episodeId, status: 'unplayed', positionMs: 0, starred: false, clientUpdatedAt: 0, dirty: 0,
      }
    );
  }
  async patchState(episodeId: string, patch: Partial<Pick<EpisodeStateRec, 'status' | 'positionMs' | 'playedAt' | 'starred'>>, opts: { syncSoon?: boolean } = {}) {
    const cur = await this.getState(episodeId);
    const now = Date.now();
    const next = this.touch({ ...cur, ...patch, deleted: false });
    if (patch.positionMs !== undefined) next.positionUpdatedAt = now;
    await this.db.episodeStates.put(next);
    if (opts.syncSoon !== false) this.sync.schedule();
  }
  markPlayed(episodeId: string) {
    return this.patchState(episodeId, { status: 'played', playedAt: Date.now() });
  }
  markUnplayed(episodeId: string) {
    return this.patchState(episodeId, { status: 'unplayed', positionMs: 0, playedAt: null });
  }
  toggleStar(episodeId: string, starred: boolean) {
    return this.patchState(episodeId, { starred });
  }
  /** Position write from the player: local only; the player schedules syncs itself. */
  savePosition(episodeId: string, positionMs: number, durationMs: number) {
    const nearEnd = durationMs > 0 && positionMs >= durationMs - 5000;
    return this.patchState(episodeId, { positionMs, status: nearEnd ? 'played' : positionMs > 1000 ? 'inProgress' : 'unplayed', ...(nearEnd ? { playedAt: Date.now() } : {}) }, { syncSoon: false });
  }

  // ---- subscriptions ---------------------------------------------------------------------------
  async subscription(podcastId: string): Promise<SubscriptionRec | undefined> {
    const s = await this.db.subscriptions.where('podcastId').equals(podcastId).first();
    return s && !s.deleted ? s : undefined;
  }
  async setAutoDownload(podcastId: string, autoDownload: AutoDownload) {
    const s = await this.subscription(podcastId);
    if (!s) return;
    await this.db.subscriptions.put(this.touch({ ...s, autoDownload }));
    this.sync.schedule();
  }
  async unsubscribe(podcastId: string) {
    const s = await this.subscription(podcastId);
    if (!s) return;
    await this.db.subscriptions.put(this.touch({ ...s, deleted: true }));
    this.sync.schedule(300);
  }
  async ensureSubscriptionLocal(podcastId: string) {
    const existing = await this.db.subscriptions.where('podcastId').equals(podcastId).first();
    if (existing && !existing.deleted) return;
    await this.db.subscriptions.put(this.touch({ id: existing?.id ?? subId(this.userId, podcastId), podcastId, autoDownload: { mode: 'off' as const }, newEpisodeNotify: true, clientUpdatedAt: 0, deleted: false }));
  }

  // ---- settings --------------------------------------------------------------------------------
  async getSettings(): Promise<SettingsRec> {
    return (await this.db.settings.get(settingsId(this.userId))) ?? defaultSettings(this.userId);
  }
  async updateSettings(fn: (s: SettingsRec) => Partial<Pick<SettingsRec, 'defaultSpeed' | 'podcastSpeeds' | 'prefs'>>) {
    const cur = await this.getSettings();
    await this.db.settings.put(this.touch({ ...cur, ...fn(cur), deleted: false }));
    this.sync.schedule();
  }
  setDefaultSpeed(speed: number) {
    return this.updateSettings(() => ({ defaultSpeed: speed }));
  }
  /** `null` clears the override (spec §3.3). */
  setPodcastSpeed(podcastId: string, speed: number | null) {
    return this.updateSettings((s) => {
      const podcastSpeeds = { ...s.podcastSpeeds };
      if (speed === null) delete podcastSpeeds[podcastId];
      else podcastSpeeds[podcastId] = speed;
      return { podcastSpeeds };
    });
  }
  setCleanupDays(podcastId: string, days: number | null) {
    return this.updateSettings((s) => {
      const cleanupDays = { ...(s.prefs.cleanupDays ?? {}) };
      if (days === null) delete cleanupDays[podcastId];
      else cleanupDays[podcastId] = days;
      return { prefs: { ...s.prefs, cleanupDays } as Prefs };
    });
  }

  // ---- bookmarks -------------------------------------------------------------------------------
  async addBookmark(episodeId: string, positionMs: number, title: string | null, note: string | null): Promise<BookmarkRec> {
    const rec: BookmarkRec = this.touch({ id: newId(), episodeId, positionMs, title: title?.trim() || null, note: note?.trim() || null, createdAt: Date.now(), clientUpdatedAt: 0, deleted: false });
    await this.db.bookmarks.put(rec);
    this.sync.schedule();
    return rec;
  }
  async updateBookmark(id: string, patch: { title?: string | null; note?: string | null }) {
    const b = await this.db.bookmarks.get(id);
    if (!b) return;
    await this.db.bookmarks.put(this.touch({ ...b, title: patch.title === undefined ? b.title : patch.title?.trim() || null, note: patch.note === undefined ? b.note : patch.note?.trim() || null }));
    this.sync.schedule();
  }
  async deleteBookmark(id: string) {
    const b = await this.db.bookmarks.get(id);
    if (!b) return;
    await this.db.bookmarks.put(this.touch({ ...b, deleted: true }));
    this.sync.schedule();
  }

  // ---- playlists -------------------------------------------------------------------------------
  async createPlaylist(name: string, episodeIds: string[] = []): Promise<string> {
    const id = newId();
    await this.db.playlists.put(this.touch({ id, name: name.trim() || 'Untitled', episodeIds, clientUpdatedAt: 0, deleted: false }));
    this.sync.schedule();
    return id;
  }
  async updatePlaylist(id: string, fn: (p: PlaylistRec) => Partial<PlaylistRec>) {
    const p = await this.db.playlists.get(id);
    if (!p) return;
    await this.db.playlists.put(this.touch({ ...p, ...fn(p) }));
    this.sync.schedule();
  }
  deletePlaylist(id: string) {
    return this.updatePlaylist(id, () => ({ deleted: true }));
  }
  async addToPlaylist(id: string, episodeId: string) {
    await this.updatePlaylist(id, (p) => ({ episodeIds: p.episodeIds.includes(episodeId) ? p.episodeIds : [...p.episodeIds, episodeId] }));
  }

  // ---- Up Next: the built-in playlist (spec §3.6) -------------------------------------------------
  async queue(): Promise<string[]> {
    const q = await this.db.playlists.get(upNextId(this.userId));
    return q && !q.deleted ? q.episodeIds : [];
  }
  async setQueue(ids: string[]) {
    const id = upNextId(this.userId);
    const cur = await this.db.playlists.get(id);
    await this.db.playlists.put(this.touch({ ...(cur ?? { id, name: UP_NEXT_NAME, clientUpdatedAt: 0 }), name: UP_NEXT_NAME, episodeIds: dedupe(ids), deleted: false }));
    this.sync.schedule();
  }
  /** `next` goes right after the episode that is playing (pass its id), `front` plays-now ordering. */
  async enqueue(episodeId: string, where: 'next' | 'last' | 'front', currentId?: string | null) {
    const q = (await this.queue()).filter((x) => x !== episodeId);
    if (where === 'front') q.unshift(episodeId);
    else if (where === 'next') q.splice(q[0] !== undefined && q[0] === currentId ? 1 : 0, 0, episodeId);
    else q.push(episodeId);
    await this.setQueue(q);
  }
  async dequeue(episodeId: string) {
    await this.setQueue((await this.queue()).filter((x) => x !== episodeId));
  }
  async moveInQueue(from: number, to: number) {
    const q = await this.queue();
    if (from === to || from < 0 || from >= q.length) return;
    const [x] = q.splice(from, 1);
    q.splice(Math.max(0, Math.min(to, q.length)), 0, x!);
    await this.setQueue(q);
  }

  // ---- smart playlists -------------------------------------------------------------------------
  async saveSmartPlaylist(id: string | null, definition: SmartPlaylistDefinition): Promise<string> {
    const rid = id ?? newId();
    const cur = id ? await this.db.smartPlaylists.get(id) : undefined;
    await this.db.smartPlaylists.put(this.touch({ ...(cur ?? { id: rid, clientUpdatedAt: 0 }), name: definition.name, definition, deleted: false } as SmartPlaylistRec));
    this.sync.schedule();
    return rid;
  }
  async deleteSmartPlaylist(id: string) {
    const p = await this.db.smartPlaylists.get(id);
    if (!p) return;
    await this.db.smartPlaylists.put(this.touch({ ...p, deleted: true }));
    this.sync.schedule();
  }
}

const dedupe = (ids: string[]) => [...new Set(ids)];
