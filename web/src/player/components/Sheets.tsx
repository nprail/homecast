import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useApp } from '../AppData';
import { clock, speedText } from '../lib/format';
import { useSettings } from '../lib/hooks';
import { toast, ui } from '../lib/ui';
import { activeSegment } from '../lib/transcripts';
import { Moon } from './picons';
import { btnGhost, btnPrimary, fieldCls, Sheet } from './Sheet';

const SPEED_PRESETS = [0.8, 1, 1.2, 1.4, 1.5, 1.8, 2, 2.5];

export function SpeedSheet({ onClose }: { onClose: () => void }) {
  const { player } = useApp();
  const speed = player.state.use((s) => s.speed);
  const isOverride = player.state.use((s) => s.speedIsOverride);
  const podcast = player.state.use((s) => s.podcast);
  const settings = useSettings();
  const [scope, setScope] = useState<'podcast' | 'default'>(podcast ? 'podcast' : 'default');
  const apply = (v: number) => void player.setSpeed(v, scope);
  const step = (d: number) => apply(Math.round((speed + d) * 10) / 10);
  return (
    <Sheet title="Playback speed" subtitle={podcast ? `Default ${speedText(settings.defaultSpeed)}${isOverride ? ` · ${podcast.title} override ${speedText(speed)}` : ''}` : undefined} onClose={onClose}>
      <div className="mt-5 flex items-center justify-center gap-4">
        <button aria-label="Slower" disabled={speed <= 0.5} onClick={() => step(-0.1)} className="h-11 w-11 rounded-xl border border-p-line bg-p-bg text-xl text-p-text">−</button>
        <div className="min-w-24 text-center font-display text-4xl font-bold text-p-accent" aria-live="polite">{speedText(speed)}</div>
        <button aria-label="Faster" disabled={speed >= 3} onClick={() => step(0.1)} className="h-11 w-11 rounded-xl border border-p-line bg-p-bg text-xl text-p-text">+</button>
      </div>
      <input type="range" min={0.5} max={3} step={0.1} value={speed} aria-label="Playback speed" onChange={(e) => apply(Number(e.target.value))} className="mt-4 w-full accent-[#4FD1C5]" />
      <div className="mt-3 flex flex-wrap gap-2">
        {SPEED_PRESETS.map((p) => (
          <button key={p} onClick={() => apply(p)} aria-pressed={p === speed} className={`h-9 rounded-full px-3.5 text-sm font-medium ${p === speed ? 'border-0 bg-p-accent text-p-ink' : 'border border-p-line bg-transparent text-p-text'}`}>{speedText(p)}</button>
        ))}
      </div>
      <div className="mt-5 text-[13px] font-medium text-p-muted">Apply to</div>
      <div role="group" aria-label="Apply speed to" className="mt-1.5 flex rounded-xl bg-p-surface p-1">
        {([['podcast', podcast ? 'This podcast' : 'This podcast'], ['default', 'All podcasts']] as const).map(([v, l]) => (
          <button key={v} aria-pressed={scope === v} disabled={v === 'podcast' && !podcast} onClick={() => { setScope(v); }} className={`h-9 flex-1 rounded-lg border-0 text-sm ${scope === v ? 'bg-p-line font-semibold text-p-text' : 'bg-transparent font-medium text-p-muted'}`}>{l}</button>
        ))}
      </div>
      <p className="mt-2 mb-0 text-xs text-p-muted">Speed resolves from the podcast override first, then the global default. Pitch is corrected.</p>
      <div className="mt-5 flex gap-2.5">
        {isOverride && <button className={btnGhost} onClick={() => void player.clearSpeedOverride()}>Clear override</button>}
        <button className={btnPrimary} data-autofocus onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}

const SLEEP_PRESETS = [5, 15, 30, 45, 60];

export function SleepSheet({ onClose }: { onClose: () => void }) {
  const { player } = useApp();
  const sleep = player.state.use((s) => s.sleep);
  const [custom, setCustom] = useState('');
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const pick = (m: Parameters<typeof player.setSleep>[0], msg: string) => {
    player.setSleep(m);
    toast(msg);
    onClose();
  };
  const left = sleep.kind === 'timer' ? Math.max(0, sleep.endsAt - Date.now()) : 0;
  return (
    <Sheet title="Sleep timer" subtitle={sleep.kind === 'timer' ? `Pausing in ${clock(left)}` : sleep.kind === 'episode' ? 'Pausing at the end of this episode' : 'Fades out over the last 10 seconds'} badge={<span className="text-p-amber"><Moon /></span>} onClose={onClose}>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {SLEEP_PRESETS.map((m) => (
          <button key={m} onClick={() => pick({ kind: 'timer', endsAt: Date.now() + m * 60_000 }, `Sleep timer: ${m} min`)} className="h-12 rounded-xl border border-p-line bg-p-surface text-[15px] font-medium text-p-text">{m} min</button>
        ))}
        <button onClick={() => pick({ kind: 'episode' }, 'Sleep timer: end of episode')} className="col-span-1 h-12 rounded-xl border border-p-line bg-p-surface text-[15px] font-medium text-p-text">End of ep.</button>
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const m = Math.round(Number(custom));
          if (m >= 1 && m <= 600) pick({ kind: 'timer', endsAt: Date.now() + m * 60_000 }, `Sleep timer: ${m} min`);
        }}
      >
        <input inputMode="numeric" aria-label="Custom minutes" placeholder="Custom (minutes)" value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 3))} className={`${fieldCls} !mt-0 h-12 flex-1`} />
        <button type="submit" disabled={!custom} className="h-12 rounded-xl border-0 bg-p-accent px-5 text-[15px] font-semibold text-p-ink">Set</button>
      </form>
      {sleep.kind !== 'off' && (
        <div className="mt-3 flex gap-2.5">
          <button className={btnGhost} onClick={() => { player.extendSleep(5); toast('Added 5 minutes'); }}>+5 min</button>
          <button className={btnGhost} onClick={() => pick({ kind: 'off' }, 'Sleep timer off')}>Turn off</button>
        </div>
      )}
    </Sheet>
  );
}

export function BookmarkSheet({ onClose }: { onClose: () => void }) {
  const { player, data, db } = useApp();
  const episode = player.state.use((s) => s.episode);
  // Capture the position when the sheet opens (the audio keeps playing while typing).
  const [pos] = useState(() => player.state.get().positionMs);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const preview = useLiveQuery(async () => {
    if (!episode) return null;
    const t = await db.transcripts.get(episode.id);
    if (!t) return null;
    const i = activeSegment(t.segments, pos);
    return i >= 0 ? t.segments[i]!.text : null;
  }, [db, episode?.id, pos]);
  if (!episode) return null;
  return (
    <Sheet
      title="New bookmark"
      subtitle={episode.title}
      badge={<span className="inline-flex h-7 items-center rounded-full bg-p-amber-soft px-2.5 text-[13px] font-semibold text-p-amber tnum">At {clock(pos)}</span>}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await data.addBookmark(episode.id, pos, title, note);
          toast(`Bookmarked at ${clock(pos)}`);
          onClose();
        }}
      >
        <label htmlFor="bm-title" className="mt-4 block text-[13px] font-medium text-p-muted">Title (optional)</label>
        <input id="bm-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={`${fieldCls} h-11`} />
        <label htmlFor="bm-note" className="mt-3 block text-[13px] font-medium text-p-muted">Note (optional)</label>
        <textarea id="bm-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className={`${fieldCls} resize-none py-3`} />
        {preview && <div className="mt-3 text-[13px] leading-[19px] text-p-muted italic">“{preview}”</div>}
        <div className="mt-4 flex gap-2.5">
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
          <button type="submit" className={btnPrimary}>Save bookmark</button>
        </div>
      </form>
    </Sheet>
  );
}

export function PlayerSheets() {
  const sheet = ui.use((s) => s.sheet);
  const close = () => ui.set({ sheet: null });
  if (sheet === 'speed') return <SpeedSheet onClose={close} />;
  if (sheet === 'sleep') return <SleepSheet onClose={close} />;
  if (sheet === 'bookmark') return <BookmarkSheet onClose={close} />;
  return null;
}
