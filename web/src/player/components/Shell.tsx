import { useLiveQuery } from 'dexie-react-hooks';
import { useLayoutEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigationType } from 'react-router';
import { useAuth } from '../../lib/auth';
import { BrandMark } from '../../components/icons';
import { useApp, useSyncStatus } from '../AppData';
import { relTime } from '../../lib/format';
import { clock, remaining, speedText } from '../lib/format';
import { useDesktop, useOnline, usePlaylists } from '../lib/hooks';
import { ui } from '../lib/ui';
import { Art } from './Art';
import { EpisodeMenu, PlaylistPicker } from './Episodes';
import { NowPlaying, PlayButton } from './NowPlaying';
import { Bookmark, Compass, CloudOff, Download, Lines, Mic, Moon, Queue, Shield, Skip, User } from './picons';
import { ProgressBar } from './ProgressBar';
import { PlayerSheets } from './Sheets';

const navCls = (active: boolean, size: 'lg' | 'sm' = 'lg') =>
  `flex items-center gap-3 rounded-[10px] px-3 no-underline ${size === 'lg' ? 'h-11 text-[15px]' : 'h-10 text-sm'} ${active ? 'bg-p-raised font-semibold text-p-text' : 'text-p-muted hover:bg-p-surface'}`;

export function SyncLabel() {
  const s = useSyncStatus();
  const online = useOnline();
  if (!online || s.state === 'offline') return <>Offline · using local data</>;
  if (s.state === 'syncing') return <>Syncing…</>;
  if (s.state === 'error') return <span title={s.error}>Sync problem. Retrying</span>;
  return <>{s.lastSyncAt ? `Synced ${relTime(s.lastSyncAt).toLowerCase()}` : 'Not synced yet'}</>;
}

function Sidebar() {
  const { user } = useAuth();
  const playlists = usePlaylists();
  const { db } = useApp();
  const smart = useLiveQuery(async () => (await db.smartPlaylists.toArray()).filter((p) => !p.deleted).sort((a, b) => a.name.localeCompare(b.name)), [db]) ?? [];
  return (
    <nav aria-label="Main" className="box-border flex w-[260px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-p-line bg-p-side px-4 py-6">
      <div className="flex items-center gap-2.5 px-3 pb-4">
        <BrandMark size={34} on="dark" />
        <div className="font-display text-lg font-bold tracking-[-0.02em]">Homecast</div>
      </div>
      <NavLink to="/" end className={({ isActive }) => navCls(isActive)}><Mic />Podcasts</NavLink>
      <NavLink to="/queue" className={({ isActive }) => navCls(isActive)}><Queue />Up Next</NavLink>
      <NavLink to="/discover" className={({ isActive }) => navCls(isActive)}><Compass />Discover</NavLink>
      <NavLink to="/bookmarks" className={({ isActive }) => navCls(isActive)}><Bookmark />Bookmarks</NavLink>
      <NavLink to="/downloads" className={({ isActive }) => navCls(isActive)}><Download />Downloads</NavLink>
      <div className="mt-5 flex h-6 items-center justify-between px-3 text-xs font-semibold tracking-[0.06em] text-p-muted uppercase">
        Playlists
        <NavLink to="/queue?tab=playlists" aria-label="Manage playlists" className="text-p-accent no-underline">Manage</NavLink>
      </div>
      {playlists.map((p) => (<NavLink key={p.id} to={`/playlist/${p.id}`} className={({ isActive }) => navCls(isActive, 'sm')}><span className="truncate">{p.name}</span></NavLink>))}
      {smart.map((p) => (
        <NavLink key={p.id} to={`/smart/${p.id}`} className={({ isActive }) => `${navCls(isActive, 'sm')} justify-between`}>
          <span className="truncate">{p.name}</span>
          <span className="h-5 rounded-[10px] bg-p-accent-soft px-2 text-[11px] leading-5 font-semibold text-p-accent">Smart</span>
        </NavLink>
      ))}
      <div className="flex-1" />
      {user?.role === 'admin' && <NavLink to="/admin" className={({ isActive }) => navCls(isActive)}><Shield />Admin</NavLink>}
      <NavLink to="/profile" className="flex items-center gap-3 border-t border-p-line p-3 no-underline">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#2E3F6B] text-sm font-semibold text-p-text">{user?.username[0]?.toUpperCase()}</div>
        <div className="min-w-0 flex-1"><div className="text-sm font-medium text-p-text">{user?.username}</div><div className="text-xs text-p-muted"><SyncLabel /></div></div>
      </NavLink>
    </nav>
  );
}

function TabBar() {
  const tab = (to: string, label: string, icon: React.ReactNode, end = false) => (
    <NavLink to={to} end={end} className={({ isActive }) => `flex flex-1 flex-col items-center justify-center gap-1 px-1 pt-2 pb-1.5 text-xs no-underline ${isActive ? 'font-semibold text-p-accent' : 'text-p-muted'}`}>{icon}{label}</NavLink>
  );
  return (
    <nav aria-label="Main" className="flex min-h-[68px] shrink-0 border-t border-p-line bg-p-bg pb-[env(safe-area-inset-bottom)]">
      {tab('/', 'Podcasts', <Mic />, true)}
      {tab('/queue', 'Up Next', <Queue />)}
      {tab('/discover', 'Discover', <Compass />)}
      {tab('/profile', 'Profile', <User />)}
    </nav>
  );
}

function MiniPlayer() {
  const { player } = useApp();
  const episode = player.state.use((s) => s.episode);
  const podcast = player.state.use((s) => s.podcast);
  const pos = player.state.use((s) => s.positionMs);
  const dur = player.state.use((s) => s.durationMs);
  if (!episode) return null;
  return (
    <div className="relative flex h-16 shrink-0 items-center gap-3 border-t border-p-line bg-p-surface px-4">
      <div className="absolute -top-px left-0 h-0.5 bg-p-accent" style={{ width: `${dur ? Math.min(100, (pos / dur) * 100) : 0}%` }} />
      <button onClick={() => ui.set({ nowPlaying: true })} aria-label={`Open player: ${episode.title}`} className="flex min-w-0 flex-1 items-center gap-3 border-0 bg-transparent p-0 text-left text-p-text">
        <Art podcast={podcast} size={40} radius={8} />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{episode.title}</span><span className="block truncate text-xs text-p-muted">{podcast?.title}</span></span>
      </button>
      <PlayButton size={44} />
    </div>
  );
}

function DesktopBar() {
  const { player, db } = useApp();
  const episode = player.state.use((s) => s.episode);
  const podcast = player.state.use((s) => s.podcast);
  const pos = player.state.use((s) => s.positionMs);
  const dur = player.state.use((s) => s.durationMs);
  const speed = player.state.use((s) => s.speed);
  const sleep = player.state.use((s) => s.sleep);
  const markers = useLiveQuery(async () => (episode ? (await db.bookmarks.where('episodeId').equals(episode.id).toArray()).filter((b) => !b.deleted).map((b) => b.positionMs) : []), [db, episode?.id]) ?? [];
  if (!episode) return <div className="flex h-[92px] shrink-0 items-center border-t border-p-line bg-p-surface px-6 text-sm text-p-muted">Nothing playing. Pick an episode to start.</div>;
  const iconBtn = 'flex h-11 w-11 items-center justify-center border-0 bg-transparent';
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 border-t border-p-line bg-p-surface px-6 py-3.5">
      <button onClick={() => ui.set({ nowPlaying: true })} className="flex min-w-0 flex-[1_1_260px] items-center gap-3 border-0 bg-transparent p-0 text-left text-p-text" aria-label="Open player">
        <Art podcast={podcast} size={56} radius={10} />
        <span className="min-w-0"><span className="block truncate text-sm font-semibold">{episode.title}</span><span className="block truncate text-xs text-p-muted">{podcast?.title}</span></span>
      </button>
      <div className="flex min-w-[300px] flex-[2_1_340px] flex-col gap-1.5">
        <div className="flex items-center justify-center gap-3">
          <button aria-label="Back 15 seconds" onClick={() => player.back()} className={`${iconBtn} text-p-text`}><Skip dir="back" secs={15} size={30} /></button>
          <PlayButton size={48} />
          <button aria-label="Forward 30 seconds" onClick={() => player.forward()} className={`${iconBtn} text-p-text`}><Skip dir="fwd" secs={30} size={30} /></button>
        </div>
        <div className="flex items-center gap-2.5 text-xs text-p-muted tnum">
          <span>{clock(pos)}</span>
          <div className="flex-1"><ProgressBar compact positionMs={pos} durationMs={dur} markers={markers} onSeek={(ms) => player.seekTo(ms)} /></div>
          <span>{dur ? remaining(pos, dur) : '--:--'}</span>
        </div>
      </div>
      <div className="flex flex-[1_1_260px] items-center justify-end gap-1">
        <button onClick={() => ui.set({ sheet: 'speed' })} aria-label={`Playback speed ${speedText(speed)}`} className="h-11 border-0 bg-transparent px-3 font-display text-base font-bold text-p-accent">{speedText(speed)}</button>
        <button aria-label="Sleep timer" onClick={() => ui.set({ sheet: 'sleep' })} className={`${iconBtn} ${sleep.kind !== 'off' ? 'text-p-accent' : 'text-p-text'}`}><Moon /></button>
        <button aria-label="Add bookmark" onClick={() => ui.set({ sheet: 'bookmark' })} className={`${iconBtn} text-p-amber`}><Bookmark /></button>
        <button aria-label="Open transcript" onClick={() => ui.set({ nowPlaying: true, transcript: true })} className={`${iconBtn} text-p-text`}><Lines /></button>
      </div>
    </div>
  );
}

function Toast() {
  const t = ui.use((s) => s.toast);
  if (!t) return null;
  return <div role="status" className="pointer-events-none fixed bottom-24 left-1/2 z-[80] max-w-[90vw] -translate-x-1/2 rounded-full bg-p-raised px-4 py-2.5 text-sm text-p-text shadow-lg">{t}</div>;
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return <div role="status" className="flex items-center justify-center gap-2 bg-p-amber-soft px-4 py-1.5 text-xs text-p-amber"><CloudOff size={14} />You're offline. Downloaded episodes and your library still work; changes sync when you reconnect.</div>;
}

/**
 * The page scrolls inside <main>, so the router's built-in scroll handling doesn't apply: remember each
 * history entry's scroll position, restore it on Back/Forward and start at the top for new pages.
 */
function useScrollRestoration(ref: React.RefObject<HTMLElement | null>) {
  const loc = useLocation();
  const navType = useNavigationType();
  const positions = useRef(new Map<string, number>());
  const keyRef = useRef(loc.key);
  keyRef.current = loc.key;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = navType === 'POP' ? (positions.current.get(loc.key) ?? 0) : 0;
    el.scrollTop = target;
    if (!target) return;
    // Lists render from the local database a moment later, so keep trying briefly.
    let frames = 0;
    let raf = 0;
    const retry = () => {
      if (Math.abs(el.scrollTop - target) > 2 && frames++ < 40) {
        el.scrollTop = target;
        raf = requestAnimationFrame(retry);
      }
    };
    raf = requestAnimationFrame(retry);
    return () => cancelAnimationFrame(raf);
  }, [loc.key, navType, ref]);
  return (e: React.UIEvent<HTMLElement>) => positions.current.set(keyRef.current, e.currentTarget.scrollTop);
}

export function PlayerShell() {
  const desktop = useDesktop();
  const mainRef = useRef<HTMLElement>(null);
  const onScroll = useScrollRestoration(mainRef);
  return (
    <div className="flex h-dvh bg-p-bg text-p-text">
      {desktop && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineBanner />
        <main id="main" ref={mainRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto"><Outlet /></main>
        {desktop ? <DesktopBar /> : (<><MiniPlayer /><TabBar /></>)}
      </div>
      <NowPlaying />
      <PlayerSheets />
      <EpisodeMenu />
      <PlaylistPicker />
      <Toast />
    </div>
  );
}
