import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { PodcastRec } from '../lib/db';
import { ApiError, get, post } from '../../lib/api';
import { useApp } from '../AppData';
import { Art } from '../components/Art';
import { DownloadButton, PlayToggle } from '../components/Episodes';
import { Bookmark } from '../components/picons';
import { EmptyState, outlineBtn, Page } from '../components/page';
import { clock, lengthText } from '../lib/format';
import { useGoBack, useStates } from '../lib/hooks';
import { useChapters } from '../lib/chapters';
import { parseMomentTime, shareMoment } from '../lib/share';
import { safeHtml } from '../lib/sanitize';
import { toast, ui } from '../lib/ui';

/** A link someone sent to an episode this person doesn't have yet: show what it is and offer to follow the podcast. */
function SharedEpisode({ id, t }: { id: string; t: number | null }) {
  const { sync, player } = useApp();
  const goBack = useGoBack('/');
  const [info, setInfo] = useState<{ episode: { title: string; durationSec: number }; podcast: { id: string; title: string; imageUrl: string | null; isPrivate: boolean } } | 'missing' | 'offline' | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    get<NonNullable<Exclude<typeof info, string>>>(`/episodes/${id}/share`)
      .then((r) => live && setInfo(r))
      .catch((e) => live && setInfo(e instanceof ApiError ? 'missing' : 'offline'));
    return () => void (live = false);
  }, [id]);
  if (info === null) return <Page><p className="text-p-muted">Loading…</p></Page>;
  if (info === 'offline') return <Page><EmptyState title="You're offline">Open this link again once you have a connection.</EmptyState></Page>;
  if (info === 'missing') return <Page><EmptyState title="Episode not found">The link may be wrong, or the podcast is private. Ask the person who sent it.<div className="mt-3"><Link to="/" className="text-p-accent">Back to your library</Link></div></EmptyState></Page>;
  const at = t ? ` at ${clock(t * 1000)}` : '';
  const follow = async () => {
    setBusy(true);
    try {
      await post('/subscriptions', { podcastId: info.podcast.id });
      await sync.sync();
      await player.play(id, { label: info.podcast.title });
      if (t) player.seekTo(t * 1000);
      ui.set({ nowPlaying: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not follow this podcast');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page>
      <div className="flex items-start gap-4">
        <Art podcast={{ id: info.podcast.id, title: info.podcast.title, imageUrl: info.podcast.imageUrl } as PodcastRec} size={96} radius={14} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-p-accent">{info.podcast.title}</div>
          <h1 className="mt-1 mb-0 font-display text-2xl leading-[30px] font-bold">{info.episode.title}</h1>
          <div className="mt-1.5 text-[13px] text-p-muted">Someone shared this with you{at}.</div>
        </div>
      </div>
      {info.podcast.isPrivate ? (
        <p className="mt-6 text-sm text-p-muted">This is a private podcast. Add its feed to your library to listen.</p>
      ) : (
        <div className="mt-6"><button className={outlineBtn} disabled={busy} onClick={() => void follow()}>{busy ? 'Opening…' : `Follow ${info.podcast.title} and play${at}`}</button></div>
      )}
      <div className="mt-8"><button className="border-0 bg-transparent p-0 text-sm text-p-muted underline" onClick={goBack}>Back</button></div>
    </Page>
  );
}

export function EpisodePage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const t = parseMomentTime(params.get('t'));
  const { db, data, player } = useApp();
  const goBack = useGoBack('/');
  // `null` while loading, `undefined` once we know this device doesn't have the episode.
  const ep = useLiveQuery(() => db.episodes.get(id), [db, id], null);
  const podcast = useLiveQuery(async () => (ep ? db.podcasts.get(ep.podcastId) : undefined), [db, ep?.podcastId]);
  const state = useStates().get(id);
  const bookmarks = useLiveQuery(async () => (await db.bookmarks.where('episodeId').equals(id).toArray()).filter((b) => !b.deleted).sort((a, b) => a.positionMs - b.positionMs), [db, id]) ?? [];
  const chapters = useChapters(id)?.chapters ?? [];
  if (ep === null) return <Page><p className="text-p-muted">Loading…</p></Page>;
  if (!ep) return <SharedEpisode id={id} t={t} />;
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
      {t !== null && (
        <div className="mt-5 flex items-center gap-3 rounded-[14px] bg-p-accent-soft p-3.5">
          <span className="min-w-0 flex-1 text-sm">A shared moment at <b className="tnum">{clock(t * 1000)}</b></span>
          <button className={outlineBtn} onClick={() => void player.play(id, { label: podcast?.title ?? 'Episode' }).then(() => player.seekTo(t * 1000))}>Play from {clock(t * 1000)}</button>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <PlayToggle episodeId={id} context={{ label: podcast?.title ?? 'Episode' }} size={48} />
        <button className={outlineBtn} onClick={async () => { await data.enqueue(id, 'next', player.state.get().episodeId); toast('Added to play next'); }}>Play next</button>
        <button className={outlineBtn} onClick={async () => { await data.enqueue(id, 'last'); toast('Added to the end of Up Next'); }}>Play last</button>
        <DownloadButton episodeId={id} />
        <button className={outlineBtn} onClick={() => (state?.status === 'played' ? data.markUnplayed(id) : data.markPlayed(id))}>{state?.status === 'played' ? 'Mark unplayed' : 'Mark played'}</button>
        <button className={outlineBtn} aria-pressed={!!state?.starred} onClick={() => data.toggleStar(id, !state?.starred)}>{state?.starred ? 'Starred' : 'Star'}</button>
        <button className={outlineBtn} onClick={async () => { await player.play(id, { label: podcast?.title ?? 'Episode' }); ui.set({ nowPlaying: true, transcript: true }); }}>Transcript</button>
        <button className={outlineBtn} onClick={() => void shareMoment({ episodeId: id, title: ep.title, podcastTitle: podcast?.title })}>Share</button>
        <button className={outlineBtn} aria-label="More actions" onClick={() => ui.set({ menuEpisodeId: id })}>More</button>
      </div>
      {ep.description ? (
        <div className="prose-p mt-6 text-[15px] leading-6 text-p-text/90 [&_a]:text-p-accent [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: safeHtml(ep.description) }} />
      ) : (
        <p className="mt-6 text-sm text-p-muted">This episode has no show notes.</p>
      )}
      {chapters.length > 0 && (
        <>
          <h2 className="mt-8 mb-2 text-xs font-semibold tracking-[0.06em] text-p-muted uppercase">Chapters</h2>
          {chapters.map((c, i) => (
            <button key={`${c.startMs}-${i}`} onClick={() => void player.play(id, { label: podcast?.title ?? 'Episode' }).then(() => player.seekTo(c.startMs))} className="mb-1.5 flex w-full items-center gap-3 rounded-[14px] border-0 bg-p-surface px-3.5 py-3 text-left text-p-text">
              <span className="w-14 shrink-0 text-[13px] font-semibold text-p-accent tnum">{clock(c.startMs)}</span>
              <span className="min-w-0 flex-1 text-sm leading-5">{c.title}</span>
            </button>
          ))}
        </>
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
