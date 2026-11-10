import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../AppData';
import { Art } from '../components/Art';
import { EmptyState, Page } from '../components/page';
import { Trash } from '../components/picons';
import { fmtBytes } from '../../lib/format';
import { lengthText } from '../lib/format';
import { usePodcastMap } from '../lib/hooks';
import { toast } from '../lib/ui';

export function DownloadsPage() {
  const { db, downloads, player } = useApp();
  const pods = usePodcastMap();
  const rows = useLiveQuery(async () => {
    const ds = (await db.downloads.toArray()).sort((a, b) => b.at - a.at);
    const eps = await db.episodes.bulkGet(ds.map((d) => d.episodeId));
    return ds.map((d, i) => ({ d, ep: eps[i] }));
  }, [db]);
  const active = downloads.state.use((s) => s.active);
  const total = (rows ?? []).reduce((a, r) => a + r.d.bytes, 0);
  const activeIds = Object.keys(active);
  const activeEps = useLiveQuery(async () => (await db.episodes.bulkGet(activeIds)).filter((e) => !!e), [db, activeIds.join(',')]) ?? [];
  const est = useLiveQuery(async () => (navigator.storage?.estimate ? navigator.storage.estimate() : null), [rows?.length]);
  return (
    <Page title="Downloads" right={<span className="text-[13px] text-p-muted tnum">{fmtBytes(total)} used</span>}>
      {est?.quota && <p className="mt-1 mb-0 text-[13px] text-p-muted">Browser storage: {fmtBytes(est.usage ?? 0)} of about {fmtBytes(est.quota, 0)}. Safari may evict stored audio when space is low.</p>}
      {activeEps.length > 0 && (
        <>
          <h2 className="mt-5 mb-1 text-xs font-semibold tracking-[0.06em] text-p-muted uppercase">Downloading</h2>
          {activeEps.map((e) => (
            <div key={e!.id} className="flex h-16 items-center gap-3 border-b border-p-raised">
              <div className="min-w-0 flex-1"><div className="truncate text-[15px] font-medium">{e!.title}</div>
                <div className="mt-1 h-1.5 rounded bg-p-line"><div className="h-1.5 rounded bg-p-accent transition-[width]" style={{ width: `${Math.max(3, (active[e!.id] ?? 0) * 100)}%` }} /></div></div>
              <button onClick={() => downloads.cancel(e!.id)} className="h-9 rounded-full border border-p-line bg-transparent px-3 text-sm text-p-text">Cancel</button>
            </div>
          ))}
        </>
      )}
      {rows && rows.length === 0 && activeEps.length === 0 && <EmptyState title="Nothing downloaded">Download episodes to listen offline. Use the download button on any episode, or turn on auto-download for a podcast.</EmptyState>}
      <div className="mt-3">
        {rows?.map(({ d, ep }) => (
          <div key={d.episodeId} className="flex h-[68px] items-center gap-3 border-b border-p-raised">
            <button disabled={!ep} onClick={() => void player.play(d.episodeId, { label: 'Downloads' })} className="flex min-w-0 flex-1 items-center gap-3 border-0 bg-transparent p-0 text-left text-p-text">
              <Art podcast={ep ? pods.get(ep.podcastId) : undefined} size={48} radius={10} />
              <span className="min-w-0 flex-1"><span className="block truncate text-[15px] font-medium">{ep?.title ?? 'Unknown episode'}</span>
                <span className="block truncate text-[13px] text-p-muted">{ep ? pods.get(ep.podcastId)?.title : ''} · {fmtBytes(d.bytes)}{ep?.durationSec ? ` · ${lengthText(ep.durationSec)}` : ''}</span></span>
            </button>
            <button aria-label={`Remove download of ${ep?.title ?? 'episode'}`} onClick={async () => { await downloads.remove(d.episodeId); toast('Download removed'); }} className="flex h-11 w-11 items-center justify-center border-0 bg-transparent text-p-muted"><Trash size={20} /></button>
          </div>
        ))}
      </div>
    </Page>
  );
}
