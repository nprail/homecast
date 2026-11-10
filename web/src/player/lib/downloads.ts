import { evaluateSmartPlaylist } from '@homecast/shared';
import { raw } from '../../lib/api';
import { Store } from './store';
import type { LocalData } from './data';
import { buildEpisodeViews } from './views';

const CACHE = 'homecast-audio';
const key = (episodeId: string) => `/offline/${episodeId}`;

export interface DeviceSettings {
  wifiOnly: boolean;
  storageCapMB: number; // 0 = unlimited
}
const SETTINGS_KEY = 'homecast.device';
export function readDeviceSettings(): DeviceSettings {
  try {
    return { wifiOnly: false, storageCapMB: 0, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<DeviceSettings>) };
  } catch {
    return { wifiOnly: false, storageCapMB: 0 };
  }
}
export function writeDeviceSettings(s: DeviceSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

interface Progress {
  /** episodeId -> 0..1 (or -1 while queued). */
  active: Record<string, number>;
  errors: Record<string, string>;
}

/**
 * Offline audio (spec §3.5). The PWA can't cache cross-origin audio, so downloads go through the
 * authenticated proxy and are stored in the Cache API. Playback of a downloaded episode uses a blob URL.
 */
export class DownloadManager {
  state = new Store<Progress>({ active: {}, errors: {} });
  private queue: string[] = [];
  private running = false;
  private aborts = new Map<string, AbortController>();
  private blobUrls = new Map<string, string>();

  constructor(private data: LocalData) {}

  private get db() {
    return this.data.db;
  }

  async isDownloaded(episodeId: string): Promise<boolean> {
    return !!(await this.db.downloads.get(episodeId));
  }

  /** Blob URL for a downloaded episode, or null. */
  async localUrl(episodeId: string): Promise<string | null> {
    const existing = this.blobUrls.get(episodeId);
    if (existing) return existing;
    if (!('caches' in window)) return null;
    const res = await (await caches.open(CACHE)).match(key(episodeId));
    if (!res) return null;
    const url = URL.createObjectURL(await res.blob());
    this.blobUrls.set(episodeId, url);
    return url;
  }

  private networkAllowed(): boolean {
    const c = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
    if (readDeviceSettings().wifiOnly && c && (c.type === 'cellular' || c.saveData)) return false;
    return true;
  }

  enqueue(episodeId: string) {
    if (this.queue.includes(episodeId) || episodeId in this.state.get().active) return;
    this.queue.push(episodeId);
    this.state.set({ active: { ...this.state.get().active, [episodeId]: -1 }, errors: omit(this.state.get().errors, episodeId) });
    void this.pump();
  }

  cancel(episodeId: string) {
    this.queue = this.queue.filter((x) => x !== episodeId);
    this.aborts.get(episodeId)?.abort();
    this.state.set({ active: omit(this.state.get().active, episodeId) });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        try {
          await this.download(id);
        } catch (e) {
          if ((e as Error).name !== 'AbortError') this.state.set({ errors: { ...this.state.get().errors, [id]: e instanceof Error ? e.message : 'Download failed' } });
        }
        this.state.set({ active: omit(this.state.get().active, id) });
      }
    } finally {
      this.running = false;
    }
  }

  private async download(episodeId: string) {
    const ep = await this.db.episodes.get(episodeId);
    if (!ep) throw new Error('Episode not found');
    if (!('caches' in window)) throw new Error('Offline downloads need HTTPS (or localhost)');
    if (!this.networkAllowed()) throw new Error('Waiting for Wi-Fi');
    if (await this.isDownloaded(episodeId)) return;
    await this.enforceCap(0);
    const ctl = new AbortController();
    this.aborts.set(episodeId, ctl);
    try {
      this.state.set({ active: { ...this.state.get().active, [episodeId]: 0 } });
      const res = await raw('GET', `/proxy/audio?url=${encodeURIComponent(ep.audioUrl)}`);
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let got = 0;
      for (;;) {
        if (ctl.signal.aborted) throw new DOMException('aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array<ArrayBuffer>);
        got += value.length;
        if (total) this.state.set({ active: { ...this.state.get().active, [episodeId]: got / total } });
      }
      const blob = new Blob(chunks, { type: res.headers.get('content-type') ?? ep.mimeType });
      await this.enforceCap(blob.size);
      await (await caches.open(CACHE)).put(key(episodeId), new Response(blob, { headers: { 'content-type': blob.type } }));
      await this.db.downloads.put({ episodeId, podcastId: ep.podcastId, bytes: blob.size, at: Date.now() });
    } finally {
      this.aborts.delete(episodeId);
    }
  }

  async remove(episodeId: string) {
    this.cancel(episodeId);
    const url = this.blobUrls.get(episodeId);
    if (url) URL.revokeObjectURL(url);
    this.blobUrls.delete(episodeId);
    if ('caches' in window) await (await caches.open(CACHE)).delete(key(episodeId));
    await this.db.downloads.delete(episodeId);
  }

  async totalBytes(): Promise<number> {
    return (await this.db.downloads.toArray()).reduce((a, d) => a + d.bytes, 0);
  }

  /** Global storage cap: evict the oldest played downloads, then the oldest of all, to make room. */
  private async enforceCap(incoming: number) {
    const capMB = readDeviceSettings().storageCapMB;
    if (!capMB) return;
    const cap = capMB * 1_000_000;
    let total = await this.totalBytes();
    if (total + incoming <= cap) return;
    const rows = (await this.db.downloads.toArray()).sort((a, b) => a.at - b.at);
    const states = new Map((await this.db.episodeStates.toArray()).map((s) => [s.episodeId, s.status]));
    const order = [...rows.filter((r) => states.get(r.episodeId) === 'played'), ...rows.filter((r) => states.get(r.episodeId) !== 'played')];
    for (const r of order) {
      if (total + incoming <= cap) break;
      await this.remove(r.episodeId);
      total -= r.bytes;
    }
    if (total + incoming > cap) throw new Error('Storage cap reached');
  }

  /** Per-podcast "delete played after N days" (spec §3.5). */
  async cleanup() {
    const s = await this.data.getSettings();
    const rules = s.prefs.cleanupDays ?? {};
    const rows = await this.db.downloads.toArray();
    for (const r of rows) {
      const days = rules[r.podcastId];
      if (!days) continue;
      const st = await this.data.getState(r.episodeId);
      if (st.status === 'played' && st.playedAt && Date.now() - st.playedAt > days * 86_400_000) await this.remove(r.episodeId);
    }
  }

  /** Auto-download rules (latest N / all new) and smart playlists flagged "auto-download results". */
  async runAutoDownloads() {
    if (!this.networkAllowed()) return;
    const wanted = new Set<string>();
    const subs = (await this.db.subscriptions.toArray()).filter((s) => !s.deleted && s.autoDownload.mode !== 'off');
    const states = new Map((await this.db.episodeStates.toArray()).map((s) => [s.episodeId, s]));
    for (const s of subs) {
      const eps = (await this.db.episodes.where('podcastId').equals(s.podcastId).toArray()).sort((a, b) => b.releasedAt - a.releasedAt);
      if (s.autoDownload.mode === 'latest') eps.slice(0, s.autoDownload.count ?? 3).forEach((e) => states.get(e.id)?.status !== 'played' && wanted.add(e.id));
      else {
        // "all new": episodes released since the subscription was created.
        const since = s.clientUpdatedAt;
        eps.filter((e) => e.releasedAt >= since && states.get(e.id)?.status !== 'played').slice(0, 20).forEach((e) => wanted.add(e.id));
      }
    }
    const smart = (await this.db.smartPlaylists.toArray()).filter((p) => !p.deleted && p.definition.autoDownload);
    if (smart.length) {
      const views = await buildEpisodeViews(this.db);
      for (const p of smart) evaluateSmartPlaylist(p.definition, views, Date.now()).slice(0, 25).forEach((id) => wanted.add(id));
    }
    const have = new Set((await this.db.downloads.toArray()).map((d) => d.episodeId));
    for (const id of wanted) if (!have.has(id)) this.enqueue(id);
  }
}

function omit<T>(o: Record<string, T>, k: string): Record<string, T> {
  const { [k]: _, ...rest } = o;
  return rest;
}
