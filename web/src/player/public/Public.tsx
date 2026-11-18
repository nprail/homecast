import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, matchPath, useLocation, useParams, useSearchParams } from 'react-router';
import type { Chapter, DiscoverItem, PublicConfig, PublicEpisode, PublicPodcast, TranscriptSegment } from '@homecast/shared';
import { Art } from '../components/Art';
import { EmptyState, Page, Pills, outlineBtn, primaryBtn } from '../components/page';
import { clock, lengthText, plural, shortDate } from '../lib/format';
import { safeHtml, showNotesHtml } from '../lib/sanitize';

/**
 * The public, view-only pages (admin setting "Public directory"). Nothing here needs a login or writes
 * anything; every action sends you to sign in and then back to the same page.
 */

async function pget<T>(path: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 404 ? 'This page is not available.' : 'Could not load this page.');
  return (await res.json()) as T;
}

/** Hook: load once, re-run when `key` changes. */
function useLoad<T>(load: () => Promise<T>, key: string): { data: T | null; error: string | null } {
  const [state, set] = useState<{ key: string; data: T | null; error: string | null }>({ key, data: null, error: null });
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && set({ key, data, error: null }),
      (e: unknown) => live && set({ key, data: null, error: e instanceof Error ? e.message : 'Could not load this page.' }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? { data: state.data, error: state.error } : { data: null, error: null };
}

const PUBLIC_PATHS = ['/discover', '/podcast/:id', '/episode/:id'];

/** What a signed-out visitor gets for /discover, /podcast/:id and /episode/:id: the public pages if the server has them on, else sign-in. */
export function PublicFallback() {
  const loc = useLocation();
  const next = encodeURIComponent(loc.pathname + loc.search);
  const wanted = PUBLIC_PATHS.some((p) => matchPath(p, loc.pathname));
  const cfg = useLoad(() => (wanted ? pget<PublicConfig>('/public/config') : Promise.resolve(null)), wanted ? 'cfg' : 'none');
  if (!wanted || cfg.error || (cfg.data && !cfg.data.enabled)) return <Navigate to={`/login?next=${next}`} replace />;
  if (!cfg.data) return <div className="flex h-dvh items-center justify-center bg-p-bg text-p-muted">Loading…</div>;
  return (
    <Shell>
      <Routes>
        <Route path="discover" element={<PublicDiscover config={cfg.data} />} />
        <Route path="podcast/:id" element={<PublicPodcastPage config={cfg.data} />} />
        <Route path="episode/:id" element={<PublicEpisodePage config={cfg.data} />} />
      </Routes>
    </Shell>
  );
}

function useLoginHref(): string {
  const loc = useLocation();
  return `/login?next=${encodeURIComponent(loc.pathname + loc.search)}`;
}

function Shell({ children }: { children: ReactNode }) {
  const login = useLoginHref();
  return (
    <div className="min-h-dvh bg-p-bg text-p-text">
      <header className="flex items-center justify-between gap-3 border-b border-p-line bg-p-side px-5 py-3 md:px-10">
        <Link to="/discover" className="font-display text-lg font-bold tracking-[-0.02em] text-p-text no-underline">Homecast</Link>
        <nav className="flex items-center gap-2" aria-label="Account">
          <Link to={login} className={outlineBtn}>Sign in</Link>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}

function SignInPrompt({ what }: { what: string }) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 rounded-[14px] bg-p-accent-soft p-3.5 text-sm">
      <span className="min-w-0 flex-1">Sign in to {what}.</span>
      <Link to={useLoginHref()} className={primaryBtn}>Sign in</Link>
    </div>
  );
}

const asArt = (p: { id: string; title: string; imageUrl: string | null }) => p as Parameters<typeof Art>[0]['podcast'];

type Sort = 'subscribers' | 'recent' | 'az';

function PublicDiscover({ config }: { config: PublicConfig }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [limit, setLimit] = useState(60);
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const key = `${debounced}|${sort}|${limit}`;
  const r = useLoad(() => pget<{ total: number; items: DiscoverItem[] }>(`/public/discover?sort=${sort}&limit=${limit}${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`), key);
  const options: { value: Sort; label: string }[] = [
    ...(config.subscriberCounts ? [{ value: 'subscribers' as const, label: 'Most followed' }] : []),
    { value: 'recent', label: 'Recently added' },
    { value: 'az', label: 'A to Z' },
  ];
  return (
    <Page title="Discover">
      <p className="mt-1 mb-0 text-[13px] text-p-muted">Podcasts people on this server follow.</p>
      <div className="mt-4 flex h-12 items-center rounded-xl border border-p-line bg-p-surface px-3.5">
        <label htmlFor="pdq" className="sr-only">Search by title or author</label>
        <input id="pdq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title or author" className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-p-text outline-none placeholder:text-p-muted/60" />
      </div>
      <div className="mt-3"><Pills<Sort> label="Sort" value={sort} onChange={setSort} options={options} /></div>
      {r.error && <div role="alert" className="mt-3 text-sm text-p-danger">{r.error}</div>}
      <div className="mt-3">
        {r.data?.items.map((i) => (
          <Link key={i.id} to={`/podcast/${i.id}`} className="flex items-center gap-3 border-b border-p-raised py-3 text-p-text no-underline">
            <Art podcast={i as never} size={56} radius={12} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold">{i.title}</span>
              <span className="block truncate text-[13px] text-p-muted">{[i.author, config.subscriberCounts ? plural(i.subscriberCount, 'subscriber') : ''].filter(Boolean).join(' · ')}</span>
            </span>
          </Link>
        ))}
        {r.data && !r.data.items.length && <EmptyState title={debounced ? 'No matches' : 'Nothing here yet'}>{debounced ? 'Try a different search.' : 'Podcasts appear here once people on this server follow them.'}</EmptyState>}
        {r.data && r.data.total > r.data.items.length && <button className={`${outlineBtn} mt-4 w-full`} onClick={() => setLimit(limit + 60)}>Show more</button>}
        {!r.data && !r.error && <p className="py-10 text-center text-sm text-p-muted">Loading…</p>}
      </div>
      <SignInPrompt what="follow podcasts and keep your place across devices" />
    </Page>
  );
}

function PublicPodcastPage({ config }: { config: PublicConfig }) {
  const { id = '' } = useParams();
  const [limit, setLimit] = useState(30);
  const r = useLoad(() => pget<PublicPodcast>(`/public/podcasts/${id}?limit=${limit}`), `${id}|${limit}`);
  const [kept, setKept] = useState<PublicPodcast | null>(null);
  useEffect(() => {
    if (r.data) setKept(r.data);
  }, [r.data]);
  const p = r.data ?? (kept?.id === id ? kept : null);
  if (r.error) return <Page><EmptyState title="Not available">{r.error}</EmptyState></Page>;
  if (!p) return <Page><p className="text-p-muted">Loading…</p></Page>;
  return (
    <Page>
      <div className="flex items-start gap-4">
        <Art podcast={asArt(p)} size={96} radius={14} />
        <div className="min-w-0 flex-1">
          <h1 className="m-0 font-display text-2xl leading-[30px] font-bold">{p.title}</h1>
          {p.author && <div className="mt-1 text-[13px] text-p-muted">{p.author}</div>}
          {config.subscriberCounts && p.subscriberCount !== undefined && <div className="mt-1 text-[13px] text-p-muted">{plural(p.subscriberCount, 'subscriber')}</div>}
        </div>
      </div>
      {p.description && <div className="mt-5 text-[15px] leading-6 text-p-text/90 [&_a]:text-p-accent [&_p]:my-3" dangerouslySetInnerHTML={{ __html: safeHtml(p.description) }} />}
      <SignInPrompt what={`follow ${p.title}`} />
      <h2 className="mt-8 mb-2 text-xs font-semibold tracking-[0.06em] text-p-muted uppercase">Episodes</h2>
      {p.episodes.map((e) => (
        <Link key={e.id} to={`/episode/${e.id}`} className="block border-b border-p-raised py-3 text-p-text no-underline">
          <span className="block text-[15px] font-semibold">{e.title}</span>
          <span className="block text-[13px] text-p-muted">{shortDate(e.releasedAt)}{e.durationSec ? ` · ${lengthText(e.durationSec)}` : ''}</span>
        </Link>
      ))}
      {p.total > p.episodes.length && <button className={`${outlineBtn} mt-4 w-full`} onClick={() => setLimit(limit + 30)}>Show more episodes</button>}
    </Page>
  );
}

function PublicEpisodePage({ config }: { config: PublicConfig }) {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const t = Math.max(0, Math.floor(Number(params.get('t')) || 0));
  const r = useLoad(() => pget<PublicEpisode>(`/public/episodes/${id}`), id);
  const audio = useRef<HTMLAudioElement>(null);
  const e = r.data;
  const seek = (ms: number) => {
    const a = audio.current;
    if (!a) return;
    a.currentTime = ms / 1000;
    void a.play().catch(() => undefined);
    a.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  if (r.error) return <Page><EmptyState title="Not available">{r.error}</EmptyState></Page>;
  if (!e) return <Page><p className="text-p-muted">Loading…</p></Page>;
  const listening = !!e.audioUrl;
  const onNotesClick = (ev: React.MouseEvent) => {
    const a = (ev.target as HTMLElement).closest('a[data-t]');
    if (!a) return;
    ev.preventDefault();
    seek(Number(a.getAttribute('data-t')));
  };
  return (
    <Page>
      <div className="flex items-start gap-4">
        <Art podcast={asArt(e.podcast)} size={96} radius={14} />
        <div className="min-w-0 flex-1">
          <Link to={`/podcast/${e.podcast.id}`} className="text-[13px] font-medium text-p-accent no-underline">{e.podcast.title}</Link>
          <h1 className="mt-1 mb-0 font-display text-2xl leading-[30px] font-bold">{e.title}</h1>
          <div className="mt-1.5 text-[13px] text-p-muted">{new Date(e.releasedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}{e.durationSec ? ` · ${lengthText(e.durationSec)}` : ''}</div>
        </div>
      </div>
      {t > 0 && (
        <div className="mt-5 flex items-center gap-3 rounded-[14px] bg-p-accent-soft p-3.5">
          <span className="min-w-0 flex-1 text-sm">A shared moment at <b className="tnum">{clock(t * 1000)}</b></span>
          {listening && <button className={outlineBtn} onClick={() => seek(t * 1000)}>Play from {clock(t * 1000)}</button>}
        </div>
      )}
      {listening && (
        <audio
          ref={audio}
          src={e.audioUrl ?? undefined}
          controls
          preload="metadata"
          className="mt-5 w-full"
          onLoadedMetadata={(ev) => {
            if (t > 0 && ev.currentTarget.currentTime === 0) ev.currentTarget.currentTime = t;
          }}
        />
      )}
      <SignInPrompt what="follow this podcast, queue episodes, download and keep your place" />
      {e.description && (
        <div
          className="mt-6 text-[15px] leading-6 text-p-text/90 [&_a]:text-p-accent [&_a[data-t]]:font-semibold [&_a[data-t]]:no-underline [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5"
          onClick={onNotesClick}
          dangerouslySetInnerHTML={{ __html: showNotesHtml(e.description, e.durationSec * 1000, { times: listening }) }}
        />
      )}
      {e.chapters.length > 0 && <Chapters chapters={e.chapters} onSeek={listening ? seek : null} />}
      {e.hasTranscript && config.transcripts && <Transcript id={e.id} onSeek={listening ? seek : null} />}
    </Page>
  );
}

function Chapters({ chapters, onSeek }: { chapters: Chapter[]; onSeek: ((ms: number) => void) | null }) {
  return (
    <>
      <h2 className="mt-8 mb-2 text-xs font-semibold tracking-[0.06em] text-p-muted uppercase">Chapters</h2>
      {chapters.map((c, i) => {
        const inner = (
          <>
            <span className="w-14 shrink-0 text-[13px] font-semibold text-p-accent tnum">{clock(c.startMs)}</span>
            <span className="min-w-0 flex-1 text-sm leading-5">{c.title}</span>
          </>
        );
        const cls = 'mb-1.5 flex w-full items-center gap-3 rounded-[14px] border-0 bg-p-surface px-3.5 py-3 text-left text-p-text';
        return onSeek ? <button key={i} className={cls} onClick={() => onSeek(c.startMs)}>{inner}</button> : <div key={i} className={cls}>{inner}</div>;
      })}
    </>
  );
}

function Transcript({ id, onSeek }: { id: string; onSeek: ((ms: number) => void) | null }) {
  const [open, setOpen] = useState(false);
  const r = useLoad(() => (open ? pget<{ segments: TranscriptSegment[] }>(`/public/episodes/${id}/transcript`) : Promise.resolve(null)), `${id}|${open}`);
  return (
    <>
      <h2 className="mt-8 mb-2 text-xs font-semibold tracking-[0.06em] text-p-muted uppercase">Transcript</h2>
      {!open ? (
        <button className={outlineBtn} onClick={() => setOpen(true)}>Show transcript</button>
      ) : r.error ? (
        <p role="alert" className="text-sm text-p-danger">{r.error}</p>
      ) : !r.data ? (
        <p className="text-sm text-p-muted">Loading…</p>
      ) : (
        r.data.segments.map((s, i) => {
          const inner = (
            <>
              <span className="w-14 shrink-0 text-[13px] font-semibold text-p-accent tnum">{clock(s.startMs)}</span>
              <span className="min-w-0 flex-1 text-[15px] leading-6">{s.text}</span>
            </>
          );
          const cls = 'flex w-full gap-3 border-0 bg-transparent py-1.5 text-left text-p-text';
          return onSeek ? <button key={i} className={cls} onClick={() => onSeek(s.startMs)}>{inner}</button> : <div key={i} className={cls}>{inner}</div>;
        })
      )}
    </>
  );
}
