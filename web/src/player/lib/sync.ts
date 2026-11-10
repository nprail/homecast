import { SYNC_USER_COLLECTIONS, type SyncResponse, type SyncedRecord, type SyncUserCollection } from '@homecast/shared';
import { NetworkError, post } from '../../lib/api';
import { newId, type PodDB } from './db';

const TABLE: Record<SyncUserCollection, keyof PodDB> = {
  episodeStates: 'episodeStates',
  bookmarks: 'bookmarks',
  playlists: 'playlists',
  smartPlaylists: 'smartPlaylists',
  settings: 'settings',
  subscriptions: 'subscriptions',
};

/** Fields a record may carry to the server; everything else is local or server-assigned. */
const SEND_FIELDS: Record<SyncUserCollection, string[]> = {
  episodeStates: ['id', 'episodeId', 'status', 'positionMs', 'positionUpdatedAt', 'playedAt', 'starred', 'clientUpdatedAt', 'deleted'],
  bookmarks: ['id', 'episodeId', 'positionMs', 'title', 'note', 'createdAt', 'clientUpdatedAt', 'deleted'],
  playlists: ['id', 'name', 'episodeIds', 'clientUpdatedAt', 'deleted'],
  smartPlaylists: ['id', 'name', 'definition', 'clientUpdatedAt', 'deleted'],
  settings: ['id', 'defaultSpeed', 'podcastSpeeds', 'prefs', 'clientUpdatedAt', 'deleted'],
  subscriptions: ['id', 'podcastId', 'autoDownload', 'newEpisodeNotify', 'clientUpdatedAt', 'deleted'],
};

type Row = Record<string, unknown> & { id: string; clientUpdatedAt?: number; dirty?: 0 | 1; deleted?: boolean };

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'offline' | 'error';
  lastSyncAt: number | null;
  error?: string;
}

/**
 * Delta sync (spec §5): push dirty records, pull everything after `cursor`, repeat while `hasMore`.
 * Conflict resolution happens on the server (last-write-wins); locally a pending (dirty) change that
 * is newer than an incoming record is kept and pushed on the next round.
 */
export class SyncEngine {
  status: SyncStatus = { state: 'idle', lastSyncAt: null };
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private backoff = 0;
  /** Fired after new data has been merged (the downloads manager hooks in here). */
  onMerged: (() => void) | null = null;

  constructor(private db: PodDB) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.status;
  private set(s: Partial<SyncStatus>) {
    this.status = { ...this.status, ...s };
    this.listeners.forEach((l) => l());
  }

  start() {
    const trigger = () => this.schedule(0);
    window.addEventListener('online', trigger);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && trigger());
    this.timers.push(setInterval(() => void this.sync(), 60_000));
    trigger();
    this.dispose = () => {
      window.removeEventListener('online', trigger);
      this.timers.forEach(clearInterval);
      if (this.debounce) clearTimeout(this.debounce);
    };
  }
  dispose: () => void = () => undefined;

  /** Debounced sync after local writes. */
  schedule(ms = 2000) {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.sync(), ms);
  }

  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.schedule(300);
      }
    });
    return this.running;
  }

  private async run(): Promise<void> {
    // navigator.onLine is unreliable (LAN-only Wi-Fi, VPNs), so always try; a failed request decides.
    this.set({ state: 'syncing' });
    try {
      let deviceId = await this.db.getKV<string>('deviceId', '');
      if (!deviceId) {
        deviceId = newId();
        await this.db.setKV('deviceId', deviceId);
      }
      for (let round = 0; round < 50; round++) {
        let cursor = await this.db.getKV<number>('cursor', 0);
        const sent = await this.collectDirty();
        const changes: Record<string, unknown[]> = {};
        for (const c of SYNC_USER_COLLECTIONS) changes[c] = sent[c].map((r) => pick(r, SEND_FIELDS[c]));
        const res = await post<SyncResponse>('/sync', { cursor, deviceId, changes });
        if (res.fullResync) {
          await this.resetSynced();
          cursor = 0;
        }
        await this.merge(res, sent);
        await this.db.setKV('cursor', res.cursor);
        const hasDirtyAgain = (await this.countDirty()) > 0;
        if (!res.hasMore && !res.fullResync && !hasDirtyAgain) break;
        if (!res.hasMore && !res.fullResync && hasDirtyAgain && round > 3) break;
      }
      this.backoff = 0;
      this.set({ state: 'idle', lastSyncAt: Date.now(), error: undefined });
      this.onMerged?.();
    } catch (e) {
      // Only a failed network request means "offline"; anything else is a real error worth showing.
      const offline = e instanceof NetworkError;
      this.set({ state: offline ? 'offline' : 'error', error: e instanceof Error ? e.message : String(e) });
      // exponential backoff retry
      this.backoff = Math.min(this.backoff ? this.backoff * 2 : 5000, 5 * 60_000);
      this.schedule(offline ? 15_000 : this.backoff);
    }
  }

  private async collectDirty(): Promise<Record<SyncUserCollection, Row[]>> {
    const out = {} as Record<SyncUserCollection, Row[]>;
    for (const c of SYNC_USER_COLLECTIONS) {
      out[c] = (await (this.db[TABLE[c]] as unknown as { where: (k: string) => { equals: (v: number) => { limit: (n: number) => { toArray: () => Promise<Row[]> } } } })
        .where('dirty').equals(1).limit(2000).toArray());
    }
    return out;
  }
  private async countDirty(): Promise<number> {
    let n = 0;
    for (const c of SYNC_USER_COLLECTIONS) n += await (this.db[TABLE[c]] as unknown as { where: (k: string) => { equals: (v: number) => { count: () => Promise<number> } } }).where('dirty').equals(1).count();
    return n;
  }

  private async resetSynced() {
    const dirtyKeep: Partial<Record<SyncUserCollection, Row[]>> = {};
    for (const c of SYNC_USER_COLLECTIONS) {
      const t = this.db[TABLE[c]] as unknown as { filter: (f: (r: Row) => boolean) => { toArray: () => Promise<Row[]> }; clear: () => Promise<void>; bulkPut: (r: Row[]) => Promise<unknown> };
      dirtyKeep[c] = await t.filter((r) => r.dirty === 1).toArray();
      await t.clear();
      await t.bulkPut(dirtyKeep[c]!);
    }
    await this.db.podcasts.clear();
    await this.db.episodes.clear();
  }

  private async merge(res: SyncResponse, sent: Record<SyncUserCollection, Row[]>) {
    const db = this.db;
    await db.transaction('rw', [db.podcasts, db.episodes, db.subscriptions, db.episodeStates, db.bookmarks, db.playlists, db.smartPlaylists, db.settings], async () => {
      for (const p of res.changes.podcasts) {
        if (p.deleted) await db.podcasts.delete(p.id);
        else await db.podcasts.put(p as never);
      }
      for (const e of res.changes.episodes) {
        if (e.deleted) await db.episodes.delete(e.id);
        else await db.episodes.put(e as never);
      }
      // Rejected records would be re-sent forever; drop their dirty flag (the server won't take them).
      const rejected = new Set(res.rejected.map((r) => `${r.collection}:${r.id}`));
      for (const c of SYNC_USER_COLLECTIONS) {
        const table = db[TABLE[c]] as unknown as { get: (id: string) => Promise<Row | undefined>; put: (r: Row) => Promise<unknown>; update: (id: string, ch: object) => Promise<unknown>; where: (k: string) => { equals: (v: string) => { toArray: () => Promise<Row[]> } }; delete: (id: string) => Promise<void> };
        for (const incoming of res.changes[c] as SyncedRecord[]) {
          const local = await table.get(incoming.id);
          if (local?.dirty === 1 && (local.clientUpdatedAt ?? 0) > ((incoming.clientUpdatedAt as number) ?? 0)) continue; // keep newer pending edit
          // A different local id for the same natural key means the server kept its own row: adopt it.
          const nat = naturalKey(c, incoming);
          if (nat) {
            for (const dup of await table.where(nat.field).equals(nat.value).toArray()) if (dup.id !== incoming.id && dup.dirty !== 1) await table.delete(dup.id);
          }
          await table.put({ ...(incoming as Row), dirty: 0 });
        }
        for (const r of sent[c]) {
          if (rejected.has(`${c}:${r.id}`)) {
            const cur = await table.get(r.id);
            if (cur?.dirty === 1) await table.update(r.id, { dirty: 0 });
          }
        }
      }
    });
  }
}

function naturalKey(c: SyncUserCollection, r: SyncedRecord): { field: string; value: string } | null {
  if (c === 'episodeStates') return { field: 'episodeId', value: String(r.episodeId) };
  if (c === 'subscriptions') return { field: 'podcastId', value: String(r.podcastId) };
  return null;
}

function pick(r: Row, fields: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const f of fields) if (r[f] !== undefined) o[f] = r[f];
  if (o.deleted === undefined) o.deleted = false;
  return o;
}
