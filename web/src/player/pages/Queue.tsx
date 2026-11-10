import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { evaluateSmartPlaylist } from '@homecast/shared';
import { useApp } from '../AppData';
import { Art } from '../components/Art';
import { EpisodeRow } from '../components/Episodes';
import { ChevronRight, Close, Plus } from '../components/picons';
import { EmptyState, outlineBtn, Page, primaryBtn, Segment } from '../components/page';
import { btnGhost, btnPrimary, fieldCls, Sheet } from '../components/Sheet';
import { Sortable } from '../components/Sortable';
import type { EpisodeRec, PodcastRec } from '../lib/db';
import { lengthText, minutesLeft, plural, totalText } from '../lib/format';
import { useDownloadedSet, useEpisodes, usePlaylists, usePodcastMap, useQueueIds, useStates } from '../lib/hooks';
import { buildEpisodeViews } from '../lib/views';
import { toast } from '../lib/ui';

type Tab = 'queue' | 'playlists' | 'smart';

function QueueRow({ ep, podcast, handle, onRemove, onPlay }: { ep: EpisodeRec; podcast?: PodcastRec; handle: React.ReactNode; onRemove: () => void; onPlay: () => void }) {
  const downloaded = useDownloadedSet().has(ep.id);
  return (
    <div className="flex min-h-[68px] items-center gap-3 py-1">
      <button onClick={onPlay} className="flex min-w-0 flex-1 items-center gap-3 border-0 bg-transparent p-0 text-left text-p-text" aria-label={`Play ${ep.title}`}>
        <Art podcast={podcast} size={48} radius={10} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 block text-[15px] leading-5 font-medium break-words">{ep.title}</span>
          <span className="mt-0.5 block truncate text-[13px] text-p-muted">{podcast?.title}{ep.durationSec ? ` · ${lengthText(ep.durationSec)}` : ''}{downloaded ? ' · downloaded' : ''}</span>
        </span>
      </button>
      <button aria-label={`Remove ${ep.title} from Up Next`} onClick={onRemove} className="flex h-11 w-9 items-center justify-center border-0 bg-transparent text-p-muted"><Close size={20} /></button>
      {handle}
    </div>
  );
}

function UpNext() {
  const { data, player } = useApp();
  const ids = useQueueIds();
  const eps = useEpisodes(ids);
  const pods = usePodcastMap();
  const current = player.state.use((s) => s.episodeId);
  const playing = player.state.use((s) => s.playing);
  const pos = player.state.use((s) => s.positionMs);
  const dur = player.state.use((s) => s.durationMs);
  const items = ids.filter((i) => eps.has(i)).map((id) => ({ id }));
  const first = items[0] && items[0].id === current ? items[0] : null;
  const rest = first ? items.slice(1) : items;
  const playingEp = useEpisodes(current ? [current] : []).get(current ?? '');
  const restDur = rest.reduce((a, i) => a + (eps.get(i.id)?.durationSec ?? 0), 0);
  const cur = first ? eps.get(first.id) : playingEp;
  if (!items.length && !cur) return <EmptyState title="Your queue is empty">Use “Play next” or “Play last” on any episode to build your Up Next.</EmptyState>;
  return (
    <>
      {cur && (
        <div className="-mx-3 mt-4 flex h-[72px] items-center gap-3 rounded-[14px] bg-p-surface px-3">
          <Art podcast={pods.get(cur.podcastId)} size={48} radius={10} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{cur.title}</div>
            <div className="mt-0.5 text-[13px] text-p-accent">{playing ? 'Playing' : 'Paused'} · {dur ? minutesLeft(dur, pos) : lengthText(cur.durationSec)}</div>
          </div>
        </div>
      )}
      <div className="mt-4 h-5 text-xs font-semibold tracking-[0.06em] text-p-muted uppercase">Next · {plural(rest.length, 'episode')}{restDur ? ` · ${totalText(restDur)}` : ''}</div>
      <Sortable items={rest} label="Reorder queue" onMove={(from, to) => void data.moveInQueue(from + (first ? 1 : 0), to + (first ? 1 : 0))}>
        {(item, _i, handle) => {
          const ep = eps.get(item.id)!;
          return <QueueRow ep={ep} podcast={pods.get(ep.podcastId)} handle={handle} onRemove={() => void data.dequeue(ep.id)} onPlay={() => void player.play(ep.id, { label: 'Up Next' })} />;
        }}
      </Sortable>
    </>
  );
}

function NewPlaylistSheet({ onClose }: { onClose: () => void }) {
  const { data } = useApp();
  const nav = useNavigate();
  const [name, setName] = useState('');
  return (
    <Sheet title="New playlist" onClose={onClose}>
      <form onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; const id = await data.createPlaylist(name); onClose(); nav(`/playlist/${id}`); }}>
        <label htmlFor="pl-name" className="mt-4 block text-[13px] font-medium text-p-muted">Name</label>
        <input id="pl-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={`${fieldCls} h-12`} />
        <div className="mt-5 flex gap-2.5"><button type="button" className={btnGhost} onClick={onClose}>Cancel</button><button type="submit" className={btnPrimary} disabled={!name.trim()}>Create</button></div>
      </form>
    </Sheet>
  );
}

export function QueuePage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'queue';
  const { db, data } = useApp();
  const playlists = usePlaylists();
  const smart = useLiveQuery(async () => (await db.smartPlaylists.toArray()).filter((p) => !p.deleted).sort((a, b) => a.name.localeCompare(b.name)), [db]) ?? [];
  const [creating, setCreating] = useState(false);
  const ids = useQueueIds();
  return (
    <Page title={tab === 'queue' ? 'Up Next' : tab === 'playlists' ? 'Playlists' : 'Smart playlists'} right={
      tab === 'queue' ? (ids.length > 0 && <button onClick={async () => { if (window.confirm('Clear Up Next?')) await data.setQueue([]); }} className="h-9 rounded-full border border-p-line bg-transparent px-3.5 text-sm font-medium text-p-text">Clear</button>)
      : tab === 'playlists' ? <button onClick={() => setCreating(true)} className={primaryBtn}><Plus size={18} />New</button>
      : <Link to="/smart/new" className={primaryBtn}><Plus size={18} />New</Link>
    }>
      <div className="mt-3"><Segment<Tab> label="Library section" value={tab} onChange={(t) => setParams(t === 'queue' ? {} : { tab: t })} options={[{ value: 'queue', label: 'Up Next' }, { value: 'playlists', label: 'Playlists' }, { value: 'smart', label: 'Smart' }]} /></div>
      {tab === 'queue' && <UpNext />}
      {tab === 'playlists' && (
        <div className="mt-4">
          {playlists.map((p) => (
            <Link key={p.id} to={`/playlist/${p.id}`} className="flex h-16 items-center gap-3 border-b border-p-raised text-p-text no-underline">
              <div className="min-w-0 flex-1"><div className="truncate text-[15px] font-medium">{p.name}</div><div className="text-[13px] text-p-muted">{plural(p.episodeIds.length, 'episode')}</div></div>
              <span className="text-p-muted"><ChevronRight /></span>
            </Link>
          ))}
          {!playlists.length && <EmptyState title="No playlists yet">Playlists are ordered lists of episodes you can play through.</EmptyState>}
        </div>
      )}
      {tab === 'smart' && (
        <div className="mt-4">
          {smart.map((p) => (
            <Link key={p.id} to={`/smart/${p.id}`} className="flex h-16 items-center gap-3 border-b border-p-raised text-p-text no-underline">
              <div className="min-w-0 flex-1"><div className="truncate text-[15px] font-medium">{p.name}</div><div className="text-[13px] text-p-muted">{plural(p.definition.rules.length, 'rule')} · match {p.definition.match}</div></div>
              <span className="h-5 rounded-[10px] bg-p-accent-soft px-2 text-[11px] leading-5 font-semibold text-p-accent">Smart</span>
              <span className="text-p-muted"><ChevronRight /></span>
            </Link>
          ))}
          {!smart.length && <EmptyState title="No smart playlists yet">Smart playlists collect episodes by rules, like “unplayed, last 7 days”, and work offline.</EmptyState>}
        </div>
      )}
      {creating && <NewPlaylistSheet onClose={() => setCreating(false)} />}
    </Page>
  );
}

export function PlaylistPage() {
  const { id = '' } = useParams();
  const { db, data, player } = useApp();
  const nav = useNavigate();
  const pl = useLiveQuery(() => db.playlists.get(id), [db, id]);
  const eps = useEpisodes(pl?.episodeIds ?? []);
  const pods = usePodcastMap();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  if (pl === undefined) return <Page><p className="text-p-muted">Loading…</p></Page>;
  if (!pl || pl.deleted) return <Page><EmptyState title="Playlist not found"><Link to="/queue?tab=playlists" className="text-p-accent">Back to playlists</Link></EmptyState></Page>;
  const items = pl.episodeIds.filter((e) => eps.has(e)).map((e) => ({ id: e }));
  const ids = items.map((i) => i.id);
  return (
    <Page title={pl.name} right={<button onClick={() => { setName(pl.name); setRenaming(true); }} className="h-9 rounded-full border border-p-line bg-transparent px-3.5 text-sm text-p-text">Rename</button>}>
      <div className="mt-3 flex flex-wrap gap-2.5">
        <button disabled={!ids.length} onClick={() => void player.play(ids[0]!, { label: pl.name, ids })} className={primaryBtn}>Play all</button>
        <button className={outlineBtn} onClick={async () => { for (const i of ids) await data.enqueue(i, 'last'); toast('Added to Up Next'); }} disabled={!ids.length}>Add to Up Next</button>
        <button className={outlineBtn} onClick={async () => { if (window.confirm(`Delete “${pl.name}”?`)) { await data.deletePlaylist(id); nav('/queue?tab=playlists'); } }}>Delete</button>
      </div>
      <div className="mt-4">
        {!items.length && <EmptyState title="This playlist is empty">Use “Add to playlist” from an episode's menu.</EmptyState>}
        <Sortable items={items} label="Reorder playlist" onMove={(from, to) => void data.updatePlaylist(id, (p) => { const a = [...p.episodeIds]; const [x] = a.splice(from, 1); a.splice(to, 0, x!); return { episodeIds: a }; })}>
          {(item, _i, handle) => {
            const ep = eps.get(item.id)!;
            return <QueueRow ep={ep} podcast={pods.get(ep.podcastId)} handle={handle} onRemove={() => void data.updatePlaylist(id, (p) => ({ episodeIds: p.episodeIds.filter((x) => x !== ep.id) }))} onPlay={() => void player.play(ep.id, { label: pl.name, ids })} />;
          }}
        </Sortable>
      </div>
      {renaming && (
        <Sheet title="Rename playlist" onClose={() => setRenaming(false)}>
          <form onSubmit={async (e) => { e.preventDefault(); if (name.trim()) await data.updatePlaylist(id, () => ({ name: name.trim() })); setRenaming(false); }}>
            <input aria-label="Playlist name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={`${fieldCls} mt-4 h-12`} />
            <div className="mt-5 flex gap-2.5"><button type="button" className={btnGhost} onClick={() => setRenaming(false)}>Cancel</button><button type="submit" className={btnPrimary}>Save</button></div>
          </form>
        </Sheet>
      )}
    </Page>
  );
}

export function SmartPlaylistPage() {
  const { id = '' } = useParams();
  const { db, data, player } = useApp();
  const nav = useNavigate();
  const pl = useLiveQuery(() => db.smartPlaylists.get(id), [db, id]);
  const states = useStates();
  const downloaded = useDownloadedSet();
  const pods = usePodcastMap();
  const result = useLiveQuery(async () => {
    if (!pl) return [];
    const views = await buildEpisodeViews(db);
    const matched = evaluateSmartPlaylist(pl.definition, views, Date.now());
    const eps = await db.episodes.bulkGet(matched);
    return eps.filter((e): e is EpisodeRec => !!e);
  }, [db, pl, states, downloaded]);
  if (pl === undefined) return <Page><p className="text-p-muted">Loading…</p></Page>;
  if (!pl || pl.deleted) return <Page><EmptyState title="Smart playlist not found"><Link to="/queue?tab=smart" className="text-p-accent">Back</Link></EmptyState></Page>;
  const ids = (result ?? []).map((e) => e.id);
  return (
    <Page title={pl.name} right={<span className="h-6 rounded-xl bg-p-accent-soft px-2.5 text-xs leading-6 font-semibold text-p-accent">Smart</span>}>
      <p className="mt-1 mb-0 text-[13px] text-p-muted">{plural(ids.length, 'episode')} match · Works offline</p>
      <div className="mt-3 flex flex-wrap gap-2.5">
        <button disabled={!ids.length} onClick={() => void player.play(ids[0]!, { label: pl.name, ids })} className={primaryBtn}>Play all</button>
        <Link to={`/smart/${id}/edit`} className={outlineBtn}>Edit rules</Link>
        <button className={outlineBtn} onClick={async () => { if (window.confirm(`Delete “${pl.name}”?`)) { await data.deleteSmartPlaylist(id); nav('/queue?tab=smart'); } }}>Delete</button>
      </div>
      <div className="mt-4 px-4">
        {(result ?? []).map((e) => (<EpisodeRow key={e.id} episode={e} state={states.get(e.id)} podcast={pods.get(e.podcastId)} showArt context={{ label: pl.name, ids }} />))}
        {result && !result.length && <EmptyState title="Nothing matches right now">Matches update as new episodes arrive and as you play them.</EmptyState>}
      </div>
    </Page>
  );
}
