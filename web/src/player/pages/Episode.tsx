import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useParams } from 'react-router';
import { useApp } from '../AppData';
import { Art } from '../components/Art';
import { DownloadButton, PlayToggle } from '../components/Episodes';
import { Bookmark } from '../components/picons';
import { EmptyState, outlineBtn, Page } from '../components/page';
import { clock, lengthText } from '../lib/format';
import { useGoBack, useStates } from '../lib/hooks';
import { safeHtml } from '../lib/sanitize';
import { toast, ui } from '../lib/ui';

export function EpisodePage() {
  const { id = '' } = useParams();
  const { db, data, player } = useApp();
  const goBack = useGoBack('/');
  const ep = useLiveQuery(() => db.episodes.get(id), [db, id]);
  const podcast = useLiveQuery(async () => (ep ? db.podcasts.get(ep.podcastId) : undefined), [db, ep?.podcastId]);
  const state = useStates().get(id);
  const bookmarks = useLiveQuery(async () => (await db.bookmarks.where('episodeId').equals(id).toArray()).filter((b) => !b.deleted).sort((a, b) => a.positionMs - b.positionMs), [db, id]) ?? [];
  if (ep === undefined) return <Page><p className="text-p-muted">Loading…</p></Page>;
  if (!ep) return <Page><EmptyState title="Episode not found"><Link to="/" className="text-p-accent">Back to your library</Link></EmptyState></Page>;
  const date = new Date(ep.releasedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return (
    <Page>
      <div className="flex items-start gap-4">
        <Art podcast={podcast} size={96} radius={14} />
        <div className="min-w-0 flex-1">
          <Link to={`/podcast/${ep.podcastId}`} className="text-[13px] font-medium text-p-accent no-underline">{podcast?.title}</Link>
          <h1 className="mt-1 mb-0 font-display text-2xl leading-[30px] font-bold">{ep.title}</h1>
          <div className="mt-1.5 text-[13px] text-p-muted">{date}{ep.durationSec ? ` · ${lengthText(ep.durationSec)}` : ''}</div>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <PlayToggle episodeId={id} context={{ label: podcast?.title ?? 'Episode' }} size={48} />
        <button className={outlineBtn} onClick={async () => { await data.enqueue(id, 'next', player.state.get().episodeId); toast('Added to play next'); }}>Play next</button>
        <button className={outlineBtn} onClick={async () => { await data.enqueue(id, 'last'); toast('Added to the end of Up Next'); }}>Play last</button>
        <DownloadButton episodeId={id} />
        <button className={outlineBtn} onClick={() => (state?.status === 'played' ? data.markUnplayed(id) : data.markPlayed(id))}>{state?.status === 'played' ? 'Mark unplayed' : 'Mark played'}</button>
        <button className={outlineBtn} aria-pressed={!!state?.starred} onClick={() => data.toggleStar(id, !state?.starred)}>{state?.starred ? 'Starred' : 'Star'}</button>
        <button className={outlineBtn} onClick={async () => { await player.play(id, { label: podcast?.title ?? 'Episode' }); ui.set({ nowPlaying: true, transcript: true }); }}>Transcript</button>
        <button className={outlineBtn} aria-label="More actions" onClick={() => ui.set({ menuEpisodeId: id })}>More</button>
      </div>
      {ep.description ? (
        <div className="prose-p mt-6 text-[15px] leading-6 text-p-text/90 [&_a]:text-p-accent [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: safeHtml(ep.description) }} />
      ) : (
        <p className="mt-6 text-sm text-p-muted">This episode has no show notes.</p>
      )}
      <h2 className="mt-8 mb-2 text-xs font-semibold tracking-[0.06em] text-p-muted uppercase">Bookmarks</h2>
      {bookmarks.length === 0 ? <p className="m-0 text-sm text-p-muted">No bookmarks in this episode.</p> : bookmarks.map((b) => (
        <button key={b.id} onClick={() => void player.play(id, { label: podcast?.title ?? 'Episode' }).then(() => player.seekTo(b.positionMs))} className="mb-2 flex w-full items-center gap-3 rounded-[14px] border-0 bg-p-surface p-3.5 text-left text-p-text">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-p-amber-soft px-2.5 text-[13px] font-semibold text-p-amber tnum"><Bookmark size={14} />{clock(b.positionMs)}</span>
          <span className="min-w-0 flex-1 truncate text-sm">{b.title ?? b.note ?? 'Bookmark'}</span>
        </button>
      ))}
      <div className="mt-8"><button className="border-0 bg-transparent p-0 text-sm text-p-muted underline" onClick={goBack}>Back</button></div>
    </Page>
  );
}
