import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApp } from '../AppData';
import { post, postText } from '../../lib/api';
import { Art } from '../components/Art';
import { EpisodeRow } from '../components/Episodes';
import { Plus } from '../components/picons';
import { EmptyState, Page, primaryBtn } from '../components/page';
import { btnGhost, btnPrimary, fieldCls, Sheet } from '../components/Sheet';
import { useStates, useSubscribedPodcasts } from '../lib/hooks';
import { plural } from '../lib/format';
import { toast } from '../lib/ui';

export function AddPodcastSheet({ onClose }: { onClose: () => void }) {
  const { sync } = useApp();
  const nav = useNavigate();
  const [url, setUrl] = useState('');
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ podcast: { id: string; title: string } }>('/podcasts', { feedUrl: url.trim(), private: priv || undefined });
      await sync.sync();
      toast(`Subscribed to ${r.podcast.title}`);
      onClose();
      nav(`/podcast/${r.podcast.id}`);
    } catch (e) {
      setErr(e instanceof TypeError ? 'You need a connection to add a podcast.' : e instanceof Error ? e.message : 'Could not add this feed');
    } finally {
      setBusy(false);
    }
  };
  const importOpml = async (f: File) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await postText<{ imported: number; failed: unknown[] }>('/opml/import', await f.text(), 'text/x-opml');
      await sync.sync();
      toast(`Imported ${r.imported} podcast${r.imported === 1 ? '' : 's'}${r.failed.length ? `, ${r.failed.length} failed` : ''}`);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Add a podcast" subtitle="Paste a feed URL, or import an OPML file." onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label htmlFor="feed-url" className="mt-4 block text-[13px] font-medium text-p-muted">Feed URL</label>
        <input id="feed-url" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" className={`${fieldCls} h-12`} autoComplete="off" />
        <label className="mt-3 flex items-center gap-2.5 text-sm text-p-muted"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} className="h-4 w-4 accent-[#4FD1C5]" />This is a private feed (never shown in Discover)</label>
        {err && <div role="alert" className="mt-3 text-sm text-p-danger">{err}</div>}
        <div className="mt-4 flex gap-2.5">
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy || !url} className={btnPrimary}>{busy ? 'Adding…' : 'Add podcast'}</button>
        </div>
      </form>
      <div className="mt-4 border-t border-p-line pt-4">
        <input ref={file} type="file" accept=".opml,.xml,text/xml,text/x-opml" hidden onChange={(e) => e.target.files?.[0] && void importOpml(e.target.files[0])} />
        <button type="button" disabled={busy} onClick={() => file.current?.click()} className={`${btnGhost} w-full`}>Import OPML file</button>
      </div>
    </Sheet>
  );
}

export function LibraryPage() {
  const { db } = useApp();
  const pods = useSubscribedPodcasts();
  const states = useStates();
  const [adding, setAdding] = useState(false);
  const counts = useLiveQuery(async () => {
    const eps = await db.episodes.toArray();
    const m = new Map<string, number>();
    for (const e of eps) m.set(e.podcastId, (m.get(e.podcastId) ?? 0) + 1);
    return m;
  }, [db]);
  const latest = useLiveQuery(async () => {
    const subs = new Set((await db.subscriptions.toArray()).filter((s) => !s.deleted).map((s) => s.podcastId));
    return (await db.episodes.orderBy('releasedAt').reverse().filter((e) => subs.has(e.podcastId)).limit(60).toArray());
  }, [db]);
  const unplayedCounts = useLiveQuery(async () => {
    const eps = await db.episodes.toArray();
    const st = new Map((await db.episodeStates.toArray()).map((s) => [s.episodeId, s.status]));
    const m = new Map<string, number>();
    for (const e of eps) if (st.get(e.id) !== 'played') m.set(e.podcastId, (m.get(e.podcastId) ?? 0) + 1);
    return m;
  }, [db]);
  const podMap = new Map((pods ?? []).map((p) => [p.id, p]));
  const recent = (latest ?? []).filter((e) => states.get(e.id)?.status !== 'played').slice(0, 12);
  return (
    <Page title="Podcasts" wide right={<button onClick={() => setAdding(true)} className={primaryBtn}><Plus size={18} />Add</button>}>
      {pods && pods.length === 0 && (
        <EmptyState title="No podcasts yet">
          Add a feed URL or import an OPML file, or browse what others on this server listen to in <Link to="/discover" className="text-p-accent">Discover</Link>.
          <div className="mt-4"><button onClick={() => setAdding(true)} className={primaryBtn}>Add a podcast</button></div>
        </EmptyState>
      )}
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {pods?.map((p) => (
          <Link key={p.id} to={`/podcast/${p.id}`} className="group relative block min-w-0 text-p-text no-underline">
            <div className="relative aspect-square overflow-hidden rounded-2xl"><Art podcast={p} size={400} radius={16} className="!h-full !w-full" /></div>
            {(unplayedCounts?.get(p.id) ?? 0) > 0 && <span className="absolute top-2 right-2 rounded-full bg-p-accent px-2 py-0.5 text-xs font-semibold text-p-ink tnum">{unplayedCounts?.get(p.id)}</span>}
            <div className="mt-2 truncate text-[15px] font-semibold">{p.title}</div>
            <div className="truncate text-[13px] text-p-muted">{plural(counts?.get(p.id) ?? 0, 'episode')}</div>
          </Link>
        ))}
      </div>
      {recent.length > 0 && (
        <>
          <h2 className="mt-10 mb-2 text-xs font-semibold tracking-[0.06em] text-p-muted uppercase">Latest unplayed</h2>
          <div className="px-4">
            {recent.map((e) => (<EpisodeRow key={e.id} episode={e} state={states.get(e.id)} podcast={podMap.get(e.podcastId)} showArt context={{ label: 'Latest episodes', ids: recent.map((r) => r.id) }} />))}
          </div>
        </>
      )}
      {adding && <AddPodcastSheet onClose={() => setAdding(false)} />}
    </Page>
  );
}
