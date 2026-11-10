import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useApp } from '../AppData';
import { EmptyState, Page, Pills } from '../components/page';
import { Bookmark, MoreV } from '../components/picons';
import { btnGhost, btnPrimary, fieldCls, Sheet } from '../components/Sheet';
import type { BookmarkRec } from '../lib/db';
import { clock } from '../lib/format';
import { usePodcastMap } from '../lib/hooks';
import { activeSegment } from '../lib/transcripts';
import { toast } from '../lib/ui';

type Scope = 'all' | 'episode';

/** Bookmarks list: grouped by episode, tap to seek, edit, delete. */
export function BookmarksPage() {
  const { db, data, player } = useApp();
  const current = player.state.use((s) => s.episodeId);
  const pods = usePodcastMap();
  const [scope, setScope] = useState<Scope>('all');
  const [edit, setEdit] = useState<BookmarkRec | null>(null);
  const [menu, setMenu] = useState<BookmarkRec | null>(null);
  const rows = useLiveQuery(async () => {
    const bs = (await db.bookmarks.toArray()).filter((b) => !b.deleted);
    const eps = new Map((await db.episodes.bulkGet([...new Set(bs.map((b) => b.episodeId))])).filter((e) => !!e).map((e) => [e!.id, e!]));
    const trs = new Map((await db.transcripts.toArray()).map((t) => [t.episodeId, t]));
    return bs.map((b) => {
      const t = trs.get(b.episodeId);
      const i = t ? activeSegment(t.segments, b.positionMs) : -1;
      return { b, ep: eps.get(b.episodeId), quote: i >= 0 ? t!.segments[i]!.text : null };
    });
  }, [db]);
  const shown = (rows ?? []).filter((r) => (scope === 'all' ? true : r.b.episodeId === current)).sort((a, b) => (a.b.episodeId === b.b.episodeId ? a.b.positionMs - b.b.positionMs : b.b.createdAt - a.b.createdAt));
  const groups: { id: string; items: typeof shown }[] = [];
  for (const r of shown) {
    const g = groups.find((x) => x.id === r.b.episodeId);
    if (g) g.items.push(r);
    else groups.push({ id: r.b.episodeId, items: [r] });
  }
  return (
    <Page title="Bookmarks" right={<span className="text-[13px] text-p-muted">{(rows ?? []).length} saved</span>}>
      <div className="mt-3"><Pills<Scope> label="Show" value={scope} onChange={setScope} options={[{ value: 'all', label: 'All' }, { value: 'episode', label: 'This episode' }]} /></div>
      {rows && groups.length === 0 && <EmptyState title={scope === 'episode' ? 'No bookmarks in this episode' : 'No bookmarks yet'}>Tap the bookmark button in the player to save a moment, with an optional title and note.</EmptyState>}
      {groups.map((g) => {
        const ep = g.items[0]!.ep;
        return (
          <section key={g.id} className="mt-5">
            <h2 className="m-0 text-xs leading-5 font-semibold tracking-[0.06em] text-p-muted uppercase">{ep ? `${pods.get(ep.podcastId)?.title ?? ''} · ${ep.title}` : 'Unknown episode'}</h2>
            {g.items.map(({ b, quote }) => (
              <div key={b.id} className="mt-2 rounded-[14px] bg-p-surface p-3.5">
                <div className="flex items-center justify-between">
                  <button disabled={!ep} onClick={() => void player.play(b.episodeId, { label: 'Bookmarks' }).then(() => player.seekTo(b.positionMs))} aria-label={`Play from ${clock(b.positionMs)}`} className="inline-flex h-7 items-center gap-1.5 rounded-full border-0 bg-p-amber-soft px-2.5 text-[13px] font-semibold text-p-amber tnum"><Bookmark size={14} />{clock(b.positionMs)}</button>
                  <button aria-label="Bookmark options" onClick={() => setMenu(b)} className="-my-2 -mr-2.5 flex h-11 w-11 items-center justify-center border-0 bg-transparent text-p-muted"><MoreV size={20} /></button>
                </div>
                {b.title && <div className="mt-2 text-base font-semibold">{b.title}</div>}
                {b.note && <div className="mt-1 text-sm leading-5">{b.note}</div>}
                {quote && <div className="mt-2 text-[13px] leading-[19px] text-p-muted italic">“{quote}”</div>}
              </div>
            ))}
          </section>
        );
      })}
      {menu && (
        <Sheet title="Bookmark" subtitle={clock(menu.positionMs)} onClose={() => setMenu(null)}>
          <div className="mt-3 flex flex-col">
            <button onClick={() => { setEdit(menu); setMenu(null); }} className="h-12 border-0 border-b border-p-line bg-transparent text-left text-[15px] text-p-text">Edit</button>
            <button onClick={async () => { await data.deleteBookmark(menu.id); setMenu(null); toast('Bookmark deleted'); }} className="h-12 border-0 bg-transparent text-left text-[15px] text-p-danger">Delete</button>
          </div>
        </Sheet>
      )}
      {edit && <EditBookmark b={edit} onClose={() => setEdit(null)} />}
    </Page>
  );
}

function EditBookmark({ b, onClose }: { b: BookmarkRec; onClose: () => void }) {
  const { data } = useApp();
  const [title, setTitle] = useState(b.title ?? '');
  const [note, setNote] = useState(b.note ?? '');
  return (
    <Sheet title="Edit bookmark" subtitle={`At ${clock(b.positionMs)}`} onClose={onClose}>
      <form onSubmit={async (e) => { e.preventDefault(); await data.updateBookmark(b.id, { title, note }); onClose(); }}>
        <label htmlFor="eb-title" className="mt-4 block text-[13px] font-medium text-p-muted">Title (optional)</label>
        <input id="eb-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={`${fieldCls} h-11`} />
        <label htmlFor="eb-note" className="mt-3 block text-[13px] font-medium text-p-muted">Note (optional)</label>
        <textarea id="eb-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className={`${fieldCls} resize-none py-3`} />
        <div className="mt-4 flex gap-2.5"><button type="button" className={btnGhost} onClick={onClose}>Cancel</button><button type="submit" className={btnPrimary}>Save</button></div>
      </form>
    </Sheet>
  );
}
