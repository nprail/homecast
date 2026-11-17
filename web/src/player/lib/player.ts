import { resolveSpeed } from '@homecast/shared';
import type { DownloadManager } from './downloads';
import type { LocalData } from './data';
import type { EpisodeRec, PodcastRec } from './db';
import { artUrl } from './art';
import { Store } from './store';
import { signedStreamUrl } from './stream';

export interface PlayContext {
  /** Shown as "Playing from". */
  label: string;
  /** When set, playback advances through these ids before falling back to Up Next. */
  ids?: string[];
}

export type SleepMode = { kind: 'off' } | { kind: 'timer'; endsAt: number } | { kind: 'episode' };

export interface PlayerState {
  episodeId: string | null;
  episode: EpisodeRec | null;
  podcast: PodcastRec | null;
  playing: boolean;
  buffering: boolean;
  positionMs: number;
  durationMs: number;
  speed: number;
  /** True when the podcast has its own speed override. */
  speedIsOverride: boolean;
  sleep: SleepMode;
  fading: boolean;
  context: PlayContext;
  error: string | null;
  offlineSource: boolean;
  cast: CastState;
}

/**
 * Casting uses the browser's Remote Playback API: Chromecast in Chrome and Edge, AirPlay in Safari. The page keeps
 * playing the same <audio> element; the browser hands it to the device and mirrors its state back.
 */
export interface CastState {
  /** The browser can cast at all (the button is shown). */
  supported: boolean;
  /** A device was found nearby. Some browsers cannot say until the picker opens, so this stays true there. */
  available: boolean;
  status: 'idle' | 'connecting' | 'connected';
}
const NO_CAST: CastState = { supported: false, available: false, status: 'idle' };

type WebkitAudio = HTMLAudioElement & { webkitShowPlaybackTargetPicker?: () => void };

const SKIP_BACK = 15;
const SKIP_FWD = 30;
const FADE_MS = 10_000;

/**
 * The audio engine (spec §3.1, §3.3, §3.4): one `<audio>` element, position persisted locally every
 * 5 s and pushed to the server on pause / episode change / every 30 s, Media Session integration,
 * speed resolution (podcast override, then global default) and the sleep timer.
 */
export class Player {
  readonly state = new Store<PlayerState>({
    episodeId: null, episode: null, podcast: null, playing: false, buffering: false, positionMs: 0, durationMs: 0, speed: 1, speedIsOverride: false,
    sleep: { kind: 'off' }, fading: false, context: { label: 'Up Next' }, error: null, offlineSource: false, cast: NO_CAST,
  });
  readonly audio = new Audio();
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private sleepTimer: ReturnType<typeof setInterval> | null = null;
  private loadToken = 0;
  private pendingSeekMs: number | null = null;
  /** True while the audio element plays a signed server URL (so it can be renewed if it expires). */
  private signed = false;
  private recovering = false;
  private recoveries = 0;
  private disposers: (() => void)[] = [];

  constructor(
    private data: LocalData,
    private downloads: DownloadManager,
  ) {
    const a = this.audio;
    a.preload = 'metadata';
    (a as HTMLAudioElement & { preservesPitch: boolean }).preservesPitch = true;
    const on = <K extends keyof HTMLMediaElementEventMap>(ev: K, fn: () => void) => {
      a.addEventListener(ev, fn);
      this.disposers.push(() => a.removeEventListener(ev, fn));
    };
    on('timeupdate', () => this.state.set({ positionMs: Math.round(a.currentTime * 1000) }));
    on('durationchange', () => this.onDuration());
    on('loadedmetadata', () => {
      if (this.pendingSeekMs !== null) {
        a.currentTime = this.pendingSeekMs / 1000;
        this.pendingSeekMs = null;
      }
      this.onDuration();
    });
    on('play', () => this.onPlayState(true));
    on('pause', () => this.onPlayState(false));
    on('waiting', () => this.state.set({ buffering: true }));
    on('playing', () => this.state.set({ buffering: false }));
    on('canplay', () => this.state.set({ buffering: false }));
    on('ended', () => void this.onEnded());
    on('error', () => {
      // A signed link can expire mid-listen: renew it and carry on from the same place.
      if (this.signed) return void this.recover();
      if (this.state.get().episodeId) this.state.set({ error: 'Could not play this episode. Check your connection.', buffering: false, playing: false });
    });
    this.setupMediaSession();
    this.setupCast();
    this.sleepTimer = setInterval(() => this.tickSleep(), 500);
    // Persist before the tab goes away.
    const flush = () => void this.persist(true);
    window.addEventListener('pagehide', flush);
    this.disposers.push(() => window.removeEventListener('pagehide', flush));
    this.setupShake();
  }

  dispose() {
    this.audio.pause();
    this.disposers.forEach((d) => d());
    [this.saveTimer, this.syncTimer, this.sleepTimer].forEach((t) => t && clearInterval(t));
  }

  /** Restore the last episode (paused) so the mini player shows after a reload. */
  async restore() {
    const id = await this.data.db.getKV<string | null>('player.episodeId', null);
    if (!id) return;
    await this.load(id, { autoplay: false, context: await this.data.db.getKV<PlayContext>('player.context', { label: 'Up Next' }) });
  }

  // ---- loading ---------------------------------------------------------------------------------
  async play(episodeId: string, context?: PlayContext) {
    if (context?.label === 'Up Next') await this.data.enqueue(episodeId, 'front');
    await this.load(episodeId, { autoplay: true, context });
  }

  private async load(episodeId: string, opts: { autoplay: boolean; context?: PlayContext }) {
    const token = ++this.loadToken;
    await this.persist(true);
    const ep = await this.data.db.episodes.get(episodeId);
    if (!ep) return;
    const podcast = (await this.data.db.podcasts.get(ep.podcastId)) ?? null;
    const st = await this.data.getState(episodeId);
    const settings = await this.data.getSettings();
    // A device that is casting cannot read a copy saved in this browser, so it gets the server's or the podcast's URL.
    const local = this.state.get().cast.status === 'idle' ? await this.downloads.localUrl(episodeId) : null;
    if (token !== this.loadToken) return;
    // Otherwise stream from the server's hosted copy when there is one, through a signed URL.
    const hosted = local ? null : await signedStreamUrl(episodeId);
    if (token !== this.loadToken) return;
    const speed = resolveSpeed(settings, ep.podcastId);
    const resumeMs = st.status === 'played' ? 0 : st.positionMs;
    const context = opts.context ?? this.state.get().context;
    this.state.set({
      episodeId, episode: ep, podcast, positionMs: resumeMs, durationMs: ep.durationSec * 1000, speed, speedIsOverride: ep.podcastId in settings.podcastSpeeds,
      context, error: null, buffering: true, offlineSource: !!local,
    });
    void this.data.db.setKV('player.episodeId', episodeId);
    void this.data.db.setKV('player.context', context);
    const a = this.audio;
    a.src = local ?? hosted ?? ep.audioUrl;
    this.signed = !local && !!hosted;
    this.recoveries = 0;
    a.playbackRate = speed;
    a.volume = 1;
    this.pendingSeekMs = resumeMs > 0 ? resumeMs : null;
    this.updateMediaSession();
    if (opts.autoplay) {
      try {
        await a.play();
        if (st.status === 'unplayed' || st.status === 'played') void this.data.patchState(episodeId, { status: 'inProgress', positionMs: resumeMs }, { syncSoon: false });
      } catch (e) {
        if ((e as Error).name !== 'AbortError') this.state.set({ error: 'Playback was blocked. Press play to start.', playing: false });
      }
    }
  }

  /** Replace an expired or failed signed URL with a fresh one, resuming where playback stopped. */
  private async recover() {
    const { episodeId, episode } = this.state.get();
    if (!episodeId || !episode || this.recovering) return;
    this.recovering = true;
    try {
      const wasPlaying = !this.audio.paused;
      const at = Math.round(this.audio.currentTime * 1000);
      // After two failed renewals give up on the server's copy and use the podcast's own URL.
      this.recoveries += 1;
      const fresh = this.recoveries <= 2 ? await signedStreamUrl(episodeId) : null;
      this.signed = !!fresh;
      this.pendingSeekMs = at;
      this.audio.src = fresh ?? episode.audioUrl;
      this.audio.load();
      if (wasPlaying) await this.audio.play().catch(() => undefined);
    } finally {
      this.recovering = false;
    }
  }

  private onDuration() {
    const d = this.audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const ms = Math.round(d * 1000);
    const { episode } = this.state.get();
    this.state.set({ durationMs: ms });
    // Feeds without durations get the real value locally once the metadata loads.
    if (episode && Math.abs(episode.durationSec - d) > 2) {
      const updated = { ...episode, durationSec: Math.round(d) };
      this.state.set({ episode: updated });
      void this.data.db.episodes.update(episode.id, { durationSec: Math.round(d) });
    }
  }

  private onPlayState(playing: boolean) {
    this.state.set({ playing });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (playing) {
      this.saveTimer ??= setInterval(() => void this.persist(false), 5000);
      this.syncTimer ??= setInterval(() => void this.data.sync.sync(), 30_000);
    } else {
      [this.saveTimer, this.syncTimer].forEach((t) => t && clearInterval(t));
      this.saveTimer = this.syncTimer = null;
      void this.persist(true).then(() => this.data.sync.schedule(300)); // push on pause
    }
  }

  private async persist(syncSoon: boolean) {
    const { episodeId, durationMs } = this.state.get();
    if (!episodeId) return;
    const pos = Math.round(this.audio.currentTime * 1000);
    if (!Number.isFinite(pos)) return;
    await this.data.savePosition(episodeId, pos, durationMs);
    if (syncSoon) this.data.sync.schedule(1500);
  }

  // ---- casting ---------------------------------------------------------------------------------
  private setupCast() {
    const a = this.audio as WebkitAudio;
    const remote = a.remote;
    const safari = typeof a.webkitShowPlaybackTargetPicker === 'function';
    if (!remote && !safari) return;
    this.state.set({ cast: { supported: true, available: true, status: 'idle' } });
    const patch = (c: Partial<CastState>) => this.state.set({ cast: { ...this.state.get().cast, ...c } });
    if (remote) {
      const sync = () => patch({ status: remote.state === 'disconnected' ? 'idle' : remote.state });
      for (const ev of ['connecting', 'connect', 'disconnect'] as const) {
        remote.addEventListener(ev, sync);
        this.disposers.push(() => remote.removeEventListener(ev, sync));
      }
      // Chrome reports whether a device is nearby; Safari does not allow watching, so it keeps showing the button.
      remote.watchAvailability((available) => patch({ available })).catch(() => undefined);
    } else {
      const onTarget = (e: Event) => patch({ available: (e as Event & { availability?: string }).availability === 'available' });
      const onWireless = () => patch({ status: (a as HTMLAudioElement & { webkitCurrentPlaybackTargetIsWireless?: boolean }).webkitCurrentPlaybackTargetIsWireless ? 'connected' : 'idle' });
      a.addEventListener('webkitplaybacktargetavailabilitychanged', onTarget);
      a.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
      this.disposers.push(() => {
        a.removeEventListener('webkitplaybacktargetavailabilitychanged', onTarget);
        a.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
      });
    }
  }

  /** Open the browser's device picker. */
  async openCast(): Promise<void> {
    const a = this.audio as WebkitAudio;
    if (!this.state.get().cast.supported || !this.state.get().episodeId) return;
    // A downloaded copy lives only in this browser; the device needs an address it can fetch.
    if (this.state.get().offlineSource) await this.switchToStream();
    try {
      if (a.remote) await a.remote.prompt();
      else a.webkitShowPlaybackTargetPicker?.();
    } catch (e) {
      const name = (e as Error).name;
      // Closing the picker, or there being no device, is not an error worth showing.
      if (name !== 'NotAllowedError' && name !== 'AbortError' && name !== 'NotFoundError') this.state.set({ error: 'Could not start casting.' });
    }
  }

  /** Swap a downloaded copy for the server's hosted copy or the podcast's own URL, keeping position and play state. */
  private async switchToStream() {
    const { episodeId, episode } = this.state.get();
    if (!episodeId || !episode) return;
    const wasPlaying = !this.audio.paused;
    const at = Math.round(this.audio.currentTime * 1000);
    const hosted = await signedStreamUrl(episodeId);
    this.signed = !!hosted;
    this.pendingSeekMs = at;
    this.audio.src = hosted ?? episode.audioUrl;
    this.audio.load();
    this.state.set({ offlineSource: false });
    if (wasPlaying) await this.audio.play().catch(() => undefined);
  }

  // ---- controls --------------------------------------------------------------------------------
  toggle() {
    if (!this.state.get().episodeId) return;
    if (this.audio.paused) void this.audio.play().catch(() => undefined);
    else this.audio.pause();
  }
  pause() {
    this.audio.pause();
  }
  resume() {
    void this.audio.play().catch(() => undefined);
  }
  seekTo(ms: number) {
    const d = this.state.get().durationMs;
    const clamped = Math.max(0, d ? Math.min(ms, d) : ms);
    if (this.audio.readyState === 0) this.pendingSeekMs = clamped;
    else this.audio.currentTime = clamped / 1000;
    this.state.set({ positionMs: clamped });
  }
  skip(sec: number) {
    this.seekTo(this.audio.currentTime * 1000 + sec * 1000);
  }
  back() {
    this.skip(-SKIP_BACK);
  }
  forward() {
    this.skip(SKIP_FWD);
  }

  /** Apply a speed to this podcast (override) or as the global default. */
  async setSpeed(speed: number, scope: 'podcast' | 'default') {
    const s = Math.round(Math.min(3, Math.max(0.5, speed)) * 10) / 10;
    const { podcast } = this.state.get();
    if (scope === 'podcast' && podcast) await this.data.setPodcastSpeed(podcast.id, s);
    else await this.data.setDefaultSpeed(s);
    await this.refreshSpeed();
  }
  async clearSpeedOverride() {
    const { podcast } = this.state.get();
    if (podcast) await this.data.setPodcastSpeed(podcast.id, null);
    await this.refreshSpeed();
  }
  /** Re-resolve speed (also called when synced settings change). */
  async refreshSpeed() {
    const { episode } = this.state.get();
    if (!episode) return;
    const settings = await this.data.getSettings();
    const speed = resolveSpeed(settings, episode.podcastId);
    this.audio.playbackRate = speed;
    this.state.set({ speed, speedIsOverride: episode.podcastId in settings.podcastSpeeds });
  }

  // ---- queue advancement -----------------------------------------------------------------------
  private async onEnded() {
    const { episodeId, context, sleep } = this.state.get();
    if (!episodeId) return;
    await this.data.markPlayed(episodeId);
    await this.data.dequeue(episodeId);
    this.data.sync.schedule(500);
    this.state.set({ positionMs: 0 });
    if (sleep.kind === 'episode') {
      this.state.set({ sleep: { kind: 'off' }, fading: false, playing: false });
      this.audio.volume = 1;
      return;
    }
    let next: string | undefined;
    if (context.ids) {
      const i = context.ids.indexOf(episodeId);
      next = context.ids.slice(i + 1).find(Boolean);
    }
    next ??= (await this.data.queue())[0];
    if (next) await this.load(next, { autoplay: true, context: context.ids && context.ids.includes(next) ? context : { label: 'Up Next' } });
    else this.state.set({ playing: false });
  }

  async next() {
    const { episodeId, context } = this.state.get();
    if (!episodeId) return;
    let next: string | undefined;
    if (context.ids) next = context.ids[context.ids.indexOf(episodeId) + 1];
    next ??= (await this.data.queue()).find((x) => x !== episodeId);
    if (!next) return;
    await this.data.dequeue(episodeId);
    await this.load(next, { autoplay: true, context: context.ids?.includes(next) ? context : { label: 'Up Next' } });
  }

  // ---- sleep timer (spec §3.4) -------------------------------------------------------------------
  setSleep(mode: SleepMode) {
    this.state.set({ sleep: mode, fading: false });
    this.audio.volume = 1;
  }
  extendSleep(minutes = 5) {
    const s = this.state.get().sleep;
    if (s.kind === 'timer') this.setSleep({ kind: 'timer', endsAt: Math.max(s.endsAt, Date.now()) + minutes * 60_000 });
    else if (s.kind === 'episode' || this.state.get().fading) this.setSleep({ kind: 'timer', endsAt: Date.now() + minutes * 60_000 });
  }
  private tickSleep() {
    const { sleep, playing, durationMs } = this.state.get();
    if (sleep.kind === 'off' || !playing) return;
    const remaining = sleep.kind === 'timer' ? sleep.endsAt - Date.now() : (durationMs - this.audio.currentTime * 1000) / this.audio.playbackRate;
    if (sleep.kind === 'episode' && !durationMs) return;
    if (remaining <= 0 && sleep.kind === 'timer') {
      this.audio.pause();
      this.audio.volume = 1;
      this.state.set({ sleep: { kind: 'off' }, fading: false });
    } else if (remaining <= FADE_MS) {
      this.audio.volume = Math.max(0, remaining / FADE_MS);
      if (!this.state.get().fading) this.state.set({ fading: true });
    } else if (this.state.get().fading) {
      this.audio.volume = 1;
      this.state.set({ fading: false });
    }
  }
  private setupShake() {
    // Mobile: shake extends the timer while it is fading out.
    let last = 0;
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || !this.state.get().fading) return;
      const g = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
      if (g > 28 && Date.now() - last > 1500) {
        last = Date.now();
        this.extendSleep(5);
      }
    };
    window.addEventListener('devicemotion', onMotion);
    this.disposers.push(() => window.removeEventListener('devicemotion', onMotion));
  }

  // ---- Media Session -----------------------------------------------------------------------------
  private setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(a, h);
      } catch {
        /* unsupported action */
      }
    };
    set('play', () => this.resume());
    set('pause', () => this.pause());
    set('seekbackward', (d) => this.skip(-(d.seekOffset ?? SKIP_BACK)));
    set('seekforward', (d) => this.skip(d.seekOffset ?? SKIP_FWD));
    set('previoustrack', () => this.back());
    set('nexttrack', () => void this.next());
    set('seekto', (d) => d.seekTime !== undefined && this.seekTo(d.seekTime * 1000));
  }
  private updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const { episode, podcast } = this.state.get();
    if (!episode) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: episode.title,
      artist: podcast?.title ?? '',
      album: podcast?.title ?? '',
      artwork: artUrl(podcast) ? [{ src: new URL(artUrl(podcast)!, location.origin).href, sizes: '512x512' }] : [],
    });
  }
}
