import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../AppData';
import { activeSegment, loadTranscript, modelLabel, requestTranscript, type TranscriptStatus } from '../lib/transcripts';
import { clock, minutesLeft, remaining, speedText } from '../lib/format';
import { useDesktop, useDownloadedSet, useEpisodes, useQueueIds, usePodcastMap } from '../lib/hooks';
import { openApp } from '../lib/appRef';
import { useLayer } from '../lib/backStack';
import { toast, ui } from '../lib/ui';
import { Art } from './Art';
import { Bookmark, CheckCircle, ChevronDown, ChevronLeft, Lines, MoreH, Moon, PauseIcon, PlayIcon, Search, Skip } from './picons';
import { ProgressBar } from './ProgressBar';

/** How far ahead of the audio clock the current line is chosen (compensates for late Whisper timestamps). */
const TRANSCRIPT_LEAD_MS = 1500;

function usePlayer() {
  const { player } = useApp();
  return {
    player,
    episode: player.state.use((s) => s.episode),
    podcast: player.state.use((s) => s.podcast),
    playing: player.state.use((s) => s.playing),
    buffering: player.state.use((s) => s.buffering),
    pos: player.state.use((s) => s.positionMs),
    dur: player.state.use((s) => s.durationMs),
    speed: player.state.use((s) => s.speed),
    isOverride: player.state.use((s) => s.speedIsOverride),
    sleep: player.state.use((s) => s.sleep),
    fading: player.state.use((s) => s.fading),
    context: player.state.use((s) => s.context),
    error: player.state.use((s) => s.error),
  };
}

function useMarkers(episodeId: string | undefined): number[] {
  const { db } = useApp();
  return useLiveQuery(async () => (episodeId ? (await db.bookmarks.where('episodeId').equals(episodeId).toArray()).filter((b) => !b.deleted).map((b) => b.positionMs) : []), [db, episodeId]) ?? [];
}

export function PlayButton({ size, className = '' }: { size: number; className?: string }) {
  const { player, playing, buffering } = usePlayer();
  return (
    <button aria-label={playing ? 'Pause' : 'Play'} onClick={() => player.toggle()} className={`flex shrink-0 items-center justify-center border-0 bg-p-accent text-p-ink ${className}`} style={{ width: size, height: size, borderRadius: size / 2 }}>
      {buffering && playing ? <span className="h-1/3 w-1/3 animate-spin rounded-full border-2 border-p-ink/30 border-t-p-ink" /> : playing ? <PauseIcon size={size * 0.47} /> : <PlayIcon size={size * 0.47} />}
    </button>
  );
}

/** Full Now Playing panel (mobile: full screen; desktop: right-hand drawer). Mirrors Main.dc.html. */
export function NowPlaying() {
  const open = ui.use((s) => s.nowPlaying);
  const transcript = ui.use((s) => s.transcript);
  const desktop = useDesktop();
  const ref = useRef<HTMLDivElement>(null);
  // Back closes the transcript first, then the player.
  useLayer(open, () => ui.set({ nowPlaying: false, transcript: false }));
  useLayer(open && transcript, () => ui.set({ transcript: false }));
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) transcript ? ui.set({ transcript: false }) : ui.set({ nowPlaying: false, transcript: false });
    };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, transcript]);
  if (!open) return null;
  return (
    <div ref={ref} tabIndex={-1} role="region" aria-label={transcript ? 'Transcript' : 'Now playing'} className={`fixed z-40 flex flex-col overflow-hidden bg-p-bg text-p-text outline-none ${desktop ? 'top-0 right-0 bottom-0 w-[440px] border-l border-p-line' : 'inset-0'}`}>
      {transcript ? <TranscriptPanel /> : <PlayerPanel />}
    </div>
  );
}

function PlayerPanel() {
  const { player, episode, podcast, playing, pos, dur, speed, isOverride, sleep, fading, context, error } = usePlayer();
  const { db } = useApp();
  const markers = useMarkers(episode?.id);
  const queue = useQueueIds();
  const downloaded = useDownloadedSet();
  const nextId = queue.find((q) => q !== episode?.id);
  const nextEp = useEpisodes(nextId ? [nextId] : []).get(nextId ?? '');
  const pods = usePodcastMap();
  const hasTranscript = useLiveQuery(async () => (episode ? !!(await db.transcripts.get(episode.id)) : false), [db, episode?.id]);
  if (!episode) return <Empty />;
  const sleepLabel = sleep.kind === 'episode' ? 'End of ep.' : sleep.kind === 'timer' ? `${Math.max(1, Math.ceil((sleep.endsAt - Date.now()) / 60000))} min` : 'Sleep';
  const nextPod = nextEp ? pods.get(nextEp.podcastId) : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-4 pb-6">
      <div className="flex h-10 shrink-0 items-center justify-between">
        <button aria-label="Close player" onClick={() => ui.set({ nowPlaying: false, transcript: false })} className="-ml-2.5 flex h-11 w-11 items-center justify-center border-0 bg-transparent text-p-text"><ChevronDown size={26} /></button>
        <div className="text-center text-xs leading-4 text-p-muted">
          <div className="font-semibold tracking-[0.06em] uppercase">Playing from</div>
          <div className="text-[13px] font-medium text-p-text">{context.label}</div>
        </div>
        <button aria-label="More options" onClick={() => ui.set({ menuEpisodeId: episode.id })} className="-mr-2.5 flex h-11 w-11 items-center justify-center border-0 bg-transparent text-p-text"><MoreH /></button>
      </div>

      <div className="mt-4 flex shrink-0 justify-center">
        <Art podcast={podcast} size={Math.min(300, Math.round(window.innerHeight * 0.34))} radius={20} />
      </div>

      <div className="mt-5 shrink-0">
        <div className="font-display text-[22px] leading-[27px] font-semibold">{episode.title}</div>
        <div className="mt-1.5 text-sm text-p-muted">{podcast?.title}</div>
        {error && <div role="alert" className="mt-2 text-[13px] text-p-danger">{error}</div>}
      </div>

      <div className="mt-3.5 shrink-0">
        <ProgressBar positionMs={pos} durationMs={dur} markers={markers} onSeek={(ms) => player.seekTo(ms)} />
        <div className="mt-1 flex justify-between text-[13px] text-p-muted tnum"><span>{clock(pos)}</span><span>{dur ? remaining(pos, dur) : '--:--'}</span></div>
      </div>

      <div className="mt-2.5 flex h-[76px] shrink-0 items-center justify-center gap-[30px]">
        <button aria-label="Back 15 seconds" onClick={() => player.back()} className="flex h-14 w-14 items-center justify-center border-0 bg-transparent text-p-text"><Skip dir="back" secs={15} /></button>
        <PlayButton size={76} />
        <button aria-label="Forward 30 seconds" onClick={() => player.forward()} className="flex h-14 w-14 items-center justify-center border-0 bg-transparent text-p-text"><Skip dir="fwd" secs={30} /></button>
      </div>

      <div className="mt-4 flex h-[68px] shrink-0 gap-2">
        <button onClick={() => ui.set({ sheet: 'speed' })} className="flex flex-1 flex-col items-center justify-center gap-1 rounded-[14px] border-0 bg-p-surface text-p-text">
          <span className="font-display text-lg leading-6 font-bold text-p-accent">{speedText(speed)}</span><span className="text-xs text-p-muted">Speed</span>
        </button>
        <button onClick={() => ui.set({ sheet: 'sleep' })} aria-label={`Sleep timer: ${sleepLabel}`} className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-[14px] border-0 bg-p-surface ${sleep.kind !== 'off' ? 'text-p-accent' : 'text-p-text'}`}>
          <Moon /><span className="text-xs text-p-muted">{sleepLabel}</span>
        </button>
        <button onClick={() => ui.set({ sheet: 'bookmark' })} className="flex flex-1 flex-col items-center justify-center gap-1 rounded-[14px] border-0 bg-p-surface text-p-amber">
          <Bookmark /><span className="text-xs text-p-muted">Bookmark</span>
        </button>
        <button onClick={() => ui.set({ transcript: true })} className="flex flex-1 flex-col items-center justify-center gap-1 rounded-[14px] border-0 bg-p-surface text-p-text">
          <Lines /><span className="text-xs text-p-muted">{hasTranscript ? 'Transcript' : 'Transcript'}</span>
        </button>
      </div>

      {fading && (
        <button onClick={() => { player.extendSleep(5); toast('Added 5 minutes'); }} className="mt-3 h-10 shrink-0 rounded-xl border border-p-amber bg-transparent text-sm font-semibold text-p-amber">Sleep timer ending. Tap to add 5 minutes</button>
      )}
      {isOverride && podcast && (
        <div className="mt-2.5 flex h-5 shrink-0 items-center justify-center gap-2 text-xs text-p-muted">
          <span>{speedText(speed)} is set for {podcast.title}</span>
          <button onClick={() => void player.clearSpeedOverride()} className="border-0 bg-transparent p-0 text-xs font-semibold text-p-accent underline">Clear override</button>
        </div>
      )}

      <div className="mt-3 shrink-0">
        {nextEp ? (
          <button onClick={() => { void player.next(); }} className="flex h-14 w-full items-center gap-3 rounded-[14px] border-0 bg-p-surface px-3 text-left text-p-text">
            <Art podcast={nextPod} size={36} radius={8} />
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-semibold tracking-[0.06em] text-p-muted uppercase">Up next</span>
              <span className="block truncate text-sm font-medium">{nextEp.title}</span>
            </span>
            {downloaded.has(nextEp.id) && <span className="text-p-accent"><CheckCircle size={20} /></span>}
          </button>
        ) : (
          <div className="flex h-14 items-center rounded-[14px] bg-p-surface px-4 text-sm text-p-muted">Nothing queued after this episode</div>
        )}
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center text-p-muted">
      <p className="m-0">Nothing is playing.</p>
      <button onClick={() => ui.set({ nowPlaying: false, transcript: false })} className="h-11 rounded-xl border border-p-line bg-transparent px-5 text-p-text">Close</button>
    </div>
  );
}

/** Transcript screen: tap-to-seek, current-line highlight, search. */
function TranscriptPanel() {
  const { player, episode, podcast, playing, pos, dur, speed } = usePlayer();
  const { db } = useApp();
  const [status, setStatus] = useState<TranscriptStatus | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(0);

  useEffect(() => {
    if (!episode) return;
    let live = true;
    setStatus(null);
    void loadTranscript(db, episode.id).then((s) => live && setStatus(s)).catch((e) => live && setErr(String(e.message ?? e)));
    return () => void (live = false);
  }, [db, episode?.id]);

  // While generating, poll until the transcript is ready.
  useEffect(() => {
    if (!episode || status?.state !== 'pending') return;
    const t = setInterval(() => void loadTranscript(db, episode.id).then(setStatus).catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, [db, episode?.id, status?.state]);

  const segs = status?.state === 'ready' ? status.rec.segments : [];
  // Follow the audio clock every frame (`timeupdate` only fires ~4x/s) and look slightly ahead:
  // Whisper reports segment starts a little after the speech actually begins.
  const [livePos, setLivePos] = useState(pos);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setLivePos((cur) => {
        const t = Math.round(player.audio.currentTime * 1000);
        return Math.abs(t - cur) >= 100 ? t : cur;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [player]);
  const active = activeSegment(segs, livePos + TRANSCRIPT_LEAD_MS);
  const needle = q.trim().toLowerCase();
  const rows = needle ? segs.map((s, i) => ({ s, i })).filter(({ s }) => s.text.toLowerCase().includes(needle)) : segs.map((s, i) => ({ s, i }));

  useEffect(() => {
    if (needle || Date.now() - userScrolled.current < 4000) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active, needle]);

  if (!episode) return <Empty />;

  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      setStatus(await requestTranscript(db, episode.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not request a transcript');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex h-[64px] shrink-0 items-center gap-2 px-2 pt-4 pr-3">
        <button aria-label="Back to player" onClick={() => ui.set({ transcript: false })} className="flex h-11 w-11 items-center justify-center border-0 bg-transparent text-p-text"><ChevronLeft size={24} /></button>
        <h1 className="m-0 flex-1 font-display text-xl font-semibold">Transcript</h1>
        {status?.state === 'ready' && (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-p-surface px-2.5 text-xs text-p-muted"><Lines size={14} />{modelLabel(status.rec)}</span>
        )}
      </div>
      <div className="shrink-0 px-5 pt-2">
        <div className="truncate text-sm leading-5 font-medium">{episode.title}</div>
        <div className="text-[13px] leading-[18px] text-p-muted">{podcast?.title}</div>
      </div>
      <div className="mx-5 mt-3 flex h-11 shrink-0 items-center gap-2.5 rounded-xl border border-p-line bg-p-surface px-3.5">
        <span className="text-p-muted"><Search size={18} /></span>
        <label htmlFor="tsearch" className="sr-only">Search this transcript</label>
        <input id="tsearch" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this transcript" disabled={status?.state !== 'ready'} className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-p-text outline-none placeholder:text-p-muted/60" />
        {needle && <span className="text-xs text-p-muted tnum">{rows.length}</span>}
      </div>

      <div ref={listRef} onWheel={() => (userScrolled.current = Date.now())} onTouchMove={() => (userScrolled.current = Date.now())} className="mt-3 min-h-0 flex-1 overflow-y-auto px-3">
        {status === null && !err && <p className="px-3 py-10 text-center text-sm text-p-muted">Loading transcript…</p>}
        {err && <p role="alert" className="px-3 py-4 text-center text-sm text-p-danger">{err}</p>}
        {status?.state === 'none' && (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <p className="m-0 text-[15px]">No transcript yet.</p>
            <p className="m-0 text-[13px] text-p-muted">The server uses the publisher's transcript when the feed has one, otherwise it generates one with Whisper. Transcripts are shared, so each episode is processed once.</p>
            <button disabled={busy} onClick={() => void generate()} className="h-11 rounded-xl border-0 bg-p-accent px-5 text-[15px] font-semibold text-p-ink">{busy ? 'Requesting…' : 'Generate transcript'}</button>
          </div>
        )}
        {status?.state === 'offline' && <p className="px-6 py-12 text-center text-sm text-p-muted">You're offline and this transcript hasn't been saved on this device.</p>}
        {status?.state === 'pending' && (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center" role="status">
            <div className="h-2 w-48 rounded bg-p-line"><div className="h-2 rounded bg-p-accent transition-[width]" style={{ width: `${status.progress ?? 4}%` }} /></div>
            <p className="m-0 text-sm">{status.stage ?? (status.queuePosition ? `Queued · position ${status.queuePosition}` : 'Queued')}{status.progress ? ` · ${status.progress}%` : ''}</p>
            <p className="m-0 text-[13px] text-p-muted">You can leave this screen. It will be ready next time.</p>
          </div>
        )}
        {status?.state === 'ready' && rows.length === 0 && <p className="px-3 py-10 text-center text-sm text-p-muted">No matches.</p>}
        {rows.map(({ s, i }) => {
          const isActive = i === active && !needle;
          return (
            <div key={i} data-active={isActive} className={`flex gap-3 rounded-[14px] px-2 py-3 ${isActive ? 'bg-p-accent-soft' : ''}`}>
              <button onClick={() => player.seekTo(Math.max(0, s.startMs - TRANSCRIPT_LEAD_MS))} aria-label={`Jump to ${clock(s.startMs)}`} className={`w-11 shrink-0 border-0 bg-transparent p-0 text-left text-[13px] leading-[26px] tnum ${isActive ? 'font-semibold text-p-accent' : 'text-p-muted'}`}>{clock(s.startMs)}</button>
              <div className="min-w-0 flex-1">
                <p onClick={() => player.seekTo(Math.max(0, s.startMs - TRANSCRIPT_LEAD_MS))} className={`m-0 cursor-pointer text-[17px] leading-[26px] ${isActive ? 'font-medium text-p-text' : 'text-p-muted'}`}>{highlight(s.text, needle)}</p>
                {isActive && (
                  <button onClick={async () => { await bookmarkLine(episode.id, s.startMs, s.text); }} className="mt-2.5 inline-flex h-8 items-center gap-1.5 rounded-full border border-p-amber bg-transparent px-3 text-[13px] font-semibold text-p-amber"><Bookmark size={16} />Bookmark this line</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex h-[72px] shrink-0 items-center gap-2 border-t border-p-line bg-p-surface px-4">
        <button aria-label="Back 15 seconds" onClick={() => player.back()} className="flex h-11 w-11 items-center justify-center border-0 bg-transparent text-p-text"><Skip dir="back" secs={15} size={30} /></button>
        <PlayButton size={48} />
        <button aria-label="Forward 30 seconds" onClick={() => player.forward()} className="flex h-11 w-11 items-center justify-center border-0 bg-transparent text-p-text"><Skip dir="fwd" secs={30} size={30} /></button>
        <div className="flex-1 text-right text-[13px] text-p-muted tnum">{clock(pos)} / {clock(dur)}</div>
        <button onClick={() => ui.set({ sheet: 'speed' })} aria-label="Playback speed" className="border-0 bg-transparent font-display text-[15px] font-bold text-p-accent">{speedText(speed)}</button>
      </div>
      <span className="sr-only" aria-live="polite">{playing ? 'Playing' : 'Paused'}</span>
    </>
  );
}

async function bookmarkLine(episodeId: string, startMs: number, text: string) {
  // One-tap "Bookmark this line": saved at the line start with the line as the title.
  const app = openApp();
  if (!app) return;
  await app.data.addBookmark(episodeId, startMs, text.slice(0, 80), null);
  toast(`Bookmarked at ${clock(startMs)}`);
}

function highlight(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const i = text.toLowerCase().indexOf(needle);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-p-amber/30 text-inherit">{text.slice(i, i + needle.length)}</mark>
      {highlight(text.slice(i + needle.length), needle)}
    </>
  );
}
