import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router';
import { useApp } from '../AppData';
import type { EpisodeRec, EpisodeStateRec, PodcastRec } from '../lib/db';
import { ago, lengthText, minutesLeft, plural } from '../lib/format';
import { useDownloadedSet, usePlaylists, usePodcastMap, useStates } from '../lib/hooks';
import type { PlayContext } from '../lib/player';
import { toast, ui } from '../lib/ui';
import { Art } from './Art';
import { CheckCircle, Download, MoreV, PauseIcon, PlayIcon, StarFilled } from './picons';
import { btnGhost, Sheet } from './Sheet';

/** Circular progress ring for an active download. */
function Ring({ value }: { value: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" className={value < 0 ? 'animate-spin' : ''}>
      <circle cx="12" cy="12" r={r} fill="none" stroke="#2A2F3A" strokeWidth="2.5" />
      <circle cx="12" cy="12" r={r} fill="none" stroke="#4FD1C5" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - (value < 0 ? 0.25 : value))} transform="rotate(-90 12 12)" />
    </svg>
  );
}

export function DownloadButton({ episodeId }: { episodeId: string }) {
  const { downloads } = useApp();
  const have = useDownloadedSet().has(episodeId);
  const progress = downloads.state.use((s) => s.active[episodeId]);
  const err = downloads.state.use((s) => s.errors[episodeId]);
  if (have) return <button aria-label="Downloaded. Remove download" onClick={() => void downloads.remove(episodeId).then(() => toast('Download removed'))} className="flex h-11 w-11 shrink-0 items-center justify-center border-0 bg-transparent text-p-accent"><CheckCircle size={22} /></button>;
  if (progress !== undefined) return <button aria-label="Cancel download" onClick={() => downloads.cancel(episodeId)} className="flex h-11 w-11 shrink-0 items-center justify-center border-0 bg-transparent"><Ring value={progress} /></button>;
  return (
    <button aria-label={err ? `Download failed: ${err}. Retry` : 'Download'} title={err} onClick={() => downloads.enqueue(episodeId)} className={`flex h-11 w-11 shrink-0 items-center justify-center border-0 bg-transparent ${err ? 'text-p-danger' : 'text-p-muted'}`}><Download size={22} /></button>
  );
}

export function PlayToggle({ episodeId, context, size = 44 }: { episodeId: string; context: PlayContext; size?: number }) {
  const { player } = useApp();
  const current = player.state.use((s) => s.episodeId === episodeId);
  const playing = player.state.use((s) => s.playing && s.episodeId === episodeId);
  return (
    <button
      aria-label={playing ? 'Pause' : 'Play'}
      onClick={() => (current ? player.toggle() : void player.play(episodeId, context))}
      className={`flex shrink-0 items-center justify-center ${current ? 'border-0 bg-p-accent text-p-ink' : 'border border-p-line bg-transparent text-p-text'}`}
      style={{ width: size, height: size, borderRadius: size / 2 }}
    >
      {playing ? <PauseIcon size={size * 0.45} /> : <PlayIcon size={size * 0.45} />}
    </button>
  );
}

/** One episode row. */
export function EpisodeRow({ episode, state, context, showArt, podcast, bookmarks = 0, hasTranscript, onOpen }: { episode: EpisodeRec; state?: EpisodeStateRec; context: PlayContext; showArt?: boolean; podcast?: PodcastRec; bookmarks?: number; hasTranscript?: boolean; onOpen?: () => void }) {
  const { player } = useApp();
  const nav = useNavigate();
  const isCurrent = player.state.use((s) => s.episodeId === episode.id);
  const playing = player.state.use((s) => s.playing && s.episodeId === episode.id);
  const pos = player.state.use((s) => (s.episodeId === episode.id ? s.positionMs : -1));
  const status = state?.status ?? 'unplayed';
  const posMs = pos >= 0 ? pos : (state?.positionMs ?? 0);
  const durMs = episode.durationSec * 1000;
  const meta: string[] = [];
  if (isCurrent && durMs) meta.push(`${playing ? 'Playing' : 'Paused'} · ${minutesLeft(durMs, posMs)}`);
  else if (status === 'inProgress' && durMs) meta.push(minutesLeft(durMs, posMs));
  else if (status === 'played') meta.push('Played');
  else if (episode.durationSec) meta.push(lengthText(episode.durationSec));
  if (!isCurrent && bookmarks) meta.push(plural(bookmarks, 'bookmark'));
  if (!isCurrent && hasTranscript) meta.push('transcript ready');
  const open = () => (onOpen ? onOpen() : nav(`/episode/${episode.id}`));
  return (
    <div className={`-mx-4 flex min-h-[68px] items-center gap-3 rounded-[14px] px-4 py-3 sm:gap-4 ${isCurrent ? 'bg-p-surface' : 'border-b border-p-raised'}`}>
      <PlayToggle episodeId={episode.id} context={context} />
      {showArt && <Art podcast={podcast} size={44} radius={10} className="hidden sm:block" />}
      <button onClick={open} className="min-w-0 flex-1 border-0 bg-transparent p-0 text-left text-p-text">
        <div className={`line-clamp-2 text-[15px] leading-5 break-words sm:text-base sm:leading-6 ${isCurrent ? 'font-semibold' : status === 'played' ? 'font-medium text-p-muted' : 'font-medium'}`}>{episode.title}</div>
        <div className={`mt-0.5 flex items-center gap-1.5 truncate text-[13px] ${isCurrent ? 'text-p-accent' : 'text-p-muted'}`}>
          {state?.starred && <span className="text-p-amber"><StarFilled size={13} /></span>}
          <span className="truncate">{[showArt && podcast ? podcast.title : null, ...meta].filter(Boolean).join(' · ')}</span>
        </div>
      </button>
      <div className="hidden w-24 text-right text-[13px] text-p-muted sm:block">{ago(episode.releasedAt)}</div>
      <DownloadButton episodeId={episode.id} />
      <button aria-label={`More options for ${episode.title}`} onClick={() => ui.set({ menuEpisodeId: episode.id })} className="-mr-2 flex h-11 w-9 shrink-0 items-center justify-center border-0 bg-transparent text-p-muted"><MoreV size={20} /></button>
    </div>
  );
}

/** Per-episode action sheet (opened from any row or the player's "more" button). */
export function EpisodeMenu() {
  const id = ui.use((s) => s.menuEpisodeId);
  const { db, data, player, downloads } = useApp();
  const nav = useNavigate();
  const ep = useLiveQuery(() => (id ? db.episodes.get(id) : undefined), [db, id]);
  const state = useStates().get(id ?? '');
  const downloaded = useDownloadedSet().has(id ?? '');
  const pods = usePodcastMap();
  if (!id || !ep) return null;
  const close = () => ui.set({ menuEpisodeId: null });
  const act = (fn: () => unknown, msg?: string) => async () => {
    close();
    await fn();
    if (msg) toast(msg);
  };
  const items: [string, () => void | Promise<unknown>, string?][] = [
    ['Play next', () => data.enqueue(id, 'next', player.state.get().episodeId), 'Added to play next'],
    ['Play last', () => data.enqueue(id, 'last'), 'Added to the end of Up Next'],
    ['Add to playlist…', () => ui.set({ playlistPickerFor: id })],
    [state?.status === 'played' ? 'Mark as unplayed' : 'Mark as played', () => (state?.status === 'played' ? data.markUnplayed(id) : data.markPlayed(id))],
    [state?.starred ? 'Remove star' : 'Star episode', () => data.toggleStar(id, !state?.starred)],
    [downloaded ? 'Remove download' : 'Download', () => (downloaded ? downloads.remove(id) : downloads.enqueue(id)), downloaded ? 'Download removed' : 'Downloading…'],
    ['Open episode', () => nav(`/episode/${id}`)],
    ['Go to podcast', () => nav(`/podcast/${ep.podcastId}`)],
  ];
  void player;
  return (
    <Sheet title={ep.title} subtitle={pods.get(ep.podcastId)?.title} onClose={close} z={70}>
      <div className="mt-3 flex flex-col">
        {items.map(([label, fn, msg]) => (
          <button key={label} onClick={act(fn, msg)} className="h-12 border-0 border-b border-p-line bg-transparent text-left text-[15px] text-p-text last:border-b-0">{label}</button>
        ))}
      </div>
    </Sheet>
  );
}

export function PlaylistPicker() {
  const id = ui.use((s) => s.playlistPickerFor);
  const { data } = useApp();
  const playlists = usePlaylists();
  if (!id) return null;
  const close = () => ui.set({ playlistPickerFor: null });
  return (
    <Sheet title="Add to playlist" onClose={close} z={75}>
      <div className="mt-3 flex flex-col">
        {playlists.map((p) => (
          <button key={p.id} onClick={async () => { await data.addToPlaylist(p.id, id); toast(`Added to ${p.name}`); close(); }} className="h-12 border-0 border-b border-p-line bg-transparent text-left text-[15px] text-p-text">
            {p.name}<span className="ml-2 text-xs text-p-muted">{plural(p.episodeIds.length, 'episode')}</span>
          </button>
        ))}
        {!playlists.length && <p className="m-0 py-3 text-sm text-p-muted">No playlists yet.</p>}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get('name') ?? '').trim();
          if (!name) return;
          await data.createPlaylist(name, [id]);
          toast(`Added to ${name}`);
          close();
        }}
      >
        <input name="name" placeholder="New playlist name" aria-label="New playlist name" maxLength={120} className="h-12 min-w-0 flex-1 rounded-xl border border-p-line bg-p-surface px-3.5 text-[15px] text-p-text" />
        <button type="submit" className={`${btnGhost} !flex-none px-4`}>Create</button>
      </form>
    </Sheet>
  );
}
