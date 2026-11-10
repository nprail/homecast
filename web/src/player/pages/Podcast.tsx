import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApp } from '../AppData';
import { Art } from '../components/Art';
import { EpisodeRow } from '../components/Episodes';
import { Check, Plus } from '../components/picons';
import { EmptyState, Page, Pills } from '../components/page';
import { btnGhost, btnPrimary, Sheet } from '../components/Sheet';
import { post } from '../../lib/api';
import { plural, speedText } from '../lib/format';
import { useDownloadedSet, useSettings, useStates } from '../lib/hooks';
import { toast } from '../lib/ui';
import type { AutoDownload } from '../lib/db';

type Filter = 'unplayed' | 'all' | 'downloaded';
const PAGE = 80;

const adLabel = (a: AutoDownload | undefined) => (!a || a.mode === 'off' ? 'Off' : a.mode === 'all' ? 'all new' : `latest ${a.count ?? 3}`);

function PodcastSettings({ podcastId, onClose }: { podcastId: string; onClose: () => void }) {
  const { data } = useApp();
  const settings = useSettings();
  const sub = useLiveQuery(() => data.subscription(podcastId), [data, podcastId]);
  const speed = settings.podcastSpeeds[podcastId];
  const cleanup = settings.prefs.cleanupDays?.[podcastId] ?? 0;
  const ad = sub?.autoDownload ?? { mode: 'off' as const };
  const adKey = ad.mode === 'latest' ? `latest:${ad.count ?? 3}` : ad.mode;
  return (
    <Sheet title="Podcast settings" onClose={onClose}>
      <div className="mt-4 text-[13px] font-medium text-p-muted">Speed override</div>
      <div className="mt-1.5 flex items-center gap-3">
        <button aria-label="Decrease speed" onClick={() => void data.setPodcastSpeed(podcastId, Math.max(0.5, Math.round(((speed ?? settings.defaultSpeed) - 0.1) * 10) / 10))} className="h-11 w-11 rounded-xl border border-p-line bg-p-bg text-xl text-p-text">−</button>
        <div className="min-w-20 text-center font-display text-xl font-bold text-p-accent" aria-live="polite">{speed ? speedText(speed) : 'Default'}</div>
        <button aria-label="Increase speed" onClick={() => void data.setPodcastSpeed(podcastId, Math.min(3, Math.round(((speed ?? settings.defaultSpeed) + 0.1) * 10) / 10))} className="h-11 w-11 rounded-xl border border-p-line bg-p-bg text-xl text-p-text">+</button>
        {speed && <button onClick={() => void data.setPodcastSpeed(podcastId, null)} className="border-0 bg-transparent text-sm font-semibold text-p-accent underline">Clear</button>}
      </div>
      <label htmlFor="ad" className="mt-5 block text-[13px] font-medium text-p-muted">Auto-download</label>
      <select id="ad" value={adKey} onChange={(e) => { const [m, c] = e.target.value.split(':'); void data.setAutoDownload(podcastId, { mode: m as AutoDownload['mode'], ...(c ? { count: Number(c) } : {}) }); }} className="mt-1.5 h-12 w-full rounded-xl border border-p-line bg-p-surface px-3.5 text-[15px] text-p-text">
        <option value="off">Off</option>
        {[1, 3, 5, 10].map((n) => (<option key={n} value={`latest:${n}`}>Latest {n}</option>))}
        <option value="all">All new episodes</option>
      </select>
      <label htmlFor="cl" className="mt-4 block text-[13px] font-medium text-p-muted">Delete played downloads</label>
      <select id="cl" value={cleanup} onChange={(e) => void data.setCleanupDays(podcastId, Number(e.target.value) || null)} className="mt-1.5 h-12 w-full rounded-xl border border-p-line bg-p-surface px-3.5 text-[15px] text-p-text">
        <option value={0}>Never</option>
        {[1, 3, 7, 14, 30].map((d) => (<option key={d} value={d}>After {d} day{d === 1 ? '' : 's'}</option>))}
      </select>
      <div className="mt-6 flex gap-2.5"><button className={btnPrimary} onClick={onClose}>Done</button></div>
    </Sheet>
  );
}

export function PodcastPage() {
  const { id = '' } = useParams();
  const { db, data, sync } = useApp();
  const nav = useNavigate();
  const podcast = useLiveQuery(() => db.podcasts.get(id), [db, id]);
  const sub = useLiveQuery(() => data.subscription(id), [data, id]);
  const episodes = useLiveQuery(() => db.episodes.where('podcastId').equals(id).toArray(), [db, id]);
  const states = useStates();
  const downloaded = useDownloadedSet();
  const settings = useSettings();
  const bookmarkCounts = useLiveQuery(async () => {
    const m = new Map<string, number>();
    for (const b of await db.bookmarks.toArray()) if (!b.deleted) m.set(b.episodeId, (m.get(b.episodeId) ?? 0) + 1);
    return m;
  }, [db]);
  const transcripts = useLiveQuery(async () => new Set((await db.transcripts.toCollection().primaryKeys()) as string[]), [db]);
  const [filter, setFilter] = useState<Filter>('unplayed');
  const [newest, setNewest] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const all = episodes ?? [];
  const unplayedCount = all.filter((e) => states.get(e.id)?.status !== 'played').length;
  const list = useMemo(() => {
    const f = all.filter((e) => (filter === 'unplayed' ? states.get(e.id)?.status !== 'played' : filter === 'downloaded' ? downloaded.has(e.id) : true));
    return f.sort((a, b) => (newest ? b.releasedAt - a.releasedAt : a.releasedAt - b.releasedAt));
  }, [all, filter, newest, states, downloaded]);

  if (podcast === undefined || episodes === undefined) return <Page><p className="text-p-muted">Loading…</p></Page>;
  if (!podcast) return <Page><EmptyState title="Podcast not found"><Link to="/" className="text-p-accent">Back to your library</Link></EmptyState></Page>;
  const speed = settings.podcastSpeeds[id];

  const subscribe = async () => {
    setBusy(true);
    try {
      if (podcast.isPrivate) throw new Error('Private feeds can only be added with their feed URL.');
      await post('/subscriptions', { podcastId: id });
      await sync.sync();
      toast('Subscribed');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not subscribe');
    } finally {
      setBusy(false);
    }
  };
  const chip = 'inline-flex h-10 items-center gap-2 rounded-full border border-p-line bg-p-surface px-4 text-sm font-medium text-p-text';
  return (
    <Page wide>
      <div className="flex flex-wrap items-end gap-7">
        <Art podcast={podcast} size={168} radius={18} />
        <div className="min-w-0 flex-[1_1_360px]">
          <div className="text-xs font-semibold tracking-[0.06em] text-p-muted uppercase">Podcast · {plural(all.length, 'episode')} · {unplayedCount} unplayed</div>
          <h1 className="mt-1.5 mb-0 font-display text-[40px] leading-[44px] font-bold">{podcast.title}</h1>
          {podcast.author && <div className="mt-1 text-sm text-p-muted">{podcast.author}</div>}
          {podcast.description && <p className="mt-2 mb-0 line-clamp-3 max-w-[620px] text-[15px] leading-[22px] text-p-muted">{podcast.description}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            {sub ? (
              <button onClick={async () => { if (window.confirm(`Unsubscribe from ${podcast.title}?`)) { await data.unsubscribe(id); toast('Unsubscribed'); nav('/', { replace: true }); } }} className="inline-flex h-10 items-center gap-2 rounded-full border border-p-accent bg-transparent px-4 text-sm font-semibold text-p-accent"><Check size={18} />Subscribed</button>
            ) : (
              <button onClick={() => void subscribe()} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-full border-0 bg-p-accent px-4 text-sm font-semibold text-p-ink"><Plus size={18} />Subscribe</button>
            )}
            {sub && (
              <>
                <button onClick={() => setSettingsOpen(true)} className={chip}>Speed override <span className="font-display font-bold text-p-accent">{speed ? speedText(speed) : 'Off'}</span></button>
                <button onClick={() => setSettingsOpen(true)} className={chip}>Auto-download: {adLabel(sub.autoDownload)}</button>
              </>
            )}
            {sub && <button aria-label="Refresh" onClick={async () => { await sync.sync(); toast('Up to date'); }} className={`${chip} !px-3`}>Refresh</button>}
          </div>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <Pills<Filter> label="Filter episodes" value={filter} onChange={(f) => { setFilter(f); setLimit(PAGE); }} options={[{ value: 'unplayed', label: 'Unplayed' }, { value: 'all', label: 'All' }, { value: 'downloaded', label: 'Downloaded' }]} />
        <button onClick={() => setNewest(!newest)} className="border-0 bg-transparent text-[13px] text-p-muted">{newest ? 'Newest first' : 'Oldest first'}</button>
      </div>

      <div className="mt-2 px-4">
        {list.slice(0, limit).map((e) => (
          <EpisodeRow key={e.id} episode={e} state={states.get(e.id)} context={{ label: podcast.title, ids: list.map((x) => x.id) }} bookmarks={bookmarkCounts?.get(e.id)} hasTranscript={transcripts?.has(e.id)} />
        ))}
        {list.length === 0 && <EmptyState title={filter === 'downloaded' ? 'Nothing downloaded' : filter === 'unplayed' ? 'All caught up' : 'No episodes yet'}>{all.length === 0 ? 'Episodes appear after the server fetches this feed and your device syncs.' : undefined}</EmptyState>}
      </div>
      {list.length > limit && <div className="mt-4 text-center"><button className={`${btnGhost} !flex-none px-6`} onClick={() => setLimit(limit + PAGE)}>Show more ({list.length - limit})</button></div>}
      {settingsOpen && <PodcastSettings podcastId={id} onClose={() => setSettingsOpen(false)} />}
    </Page>
  );
}
