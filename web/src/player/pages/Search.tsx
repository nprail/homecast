import type { TranscriptSearchItem, TranscriptSearchResponse } from '@homecast/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { get } from '../../lib/api';
import { useApp } from '../AppData';
import { EmptyState, Page } from '../components/page';
import { Search } from '../components/picons';
import { clock } from '../lib/format';
import { useOnline } from '../lib/hooks';
import { ui } from '../lib/ui';

/** Jump a little before the matched line so the sentence is heard from its start. */
const LEAD_MS = 1500;
const MIN_CHARS = 2;

/** Wrap the matched words in <mark>. Quoted phrases are kept whole, like the server does. */
function Highlight({ text, q }: { text: string; q: string }) {
  const terms = [...q.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter(Boolean);
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i} className="rounded-sm bg-p-amber-soft px-0.5 text-p-amber">{part}</mark> : part))}</>;
}

/** Search the transcripts of every podcast you follow. Needs the server, since transcripts are not all stored on the device. */
export function SearchPage() {
  const { player } = useApp();
  const online = useOnline();
  const [q, setQ] = useState('');
  const [result, setResult] = useState<{ q: string; data: TranscriptSearchResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needle = q.trim();

  useEffect(() => {
    if (needle.length < MIN_CHARS) {
      setResult(null);
      setError(null);
      return;
    }
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      get<TranscriptSearchResponse>(`/search/transcripts?q=${encodeURIComponent(needle)}&limit=30`)
        .then((data) => live && (setResult({ q: needle, data }), setError(null)))
        .catch((e: unknown) => live && setError(e instanceof TypeError ? 'You need a connection to search transcripts.' : e instanceof Error ? e.message : 'Search failed'))
        .finally(() => live && setBusy(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [needle]);

  const open = async (item: TranscriptSearchItem, startMs: number) => {
    await player.play(item.episodeId, { label: 'Search' });
    player.seekTo(Math.max(0, startMs - LEAD_MS));
    ui.set({ nowPlaying: true, transcript: true });
  };

  return (
    <Page title="Search transcripts">
      <div className="mt-3 flex h-12 items-center gap-2.5 rounded-xl border border-p-line bg-p-surface px-3.5">
        <span className="text-p-muted"><Search size={18} /></span>
        <label htmlFor="tsearch-all" className="sr-only">Search transcripts</label>
        <input id="tsearch-all" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search what was said, e.g. "slow fermentation"' autoComplete="off" className="min-w-0 flex-1 border-0 bg-transparent text-base text-p-text outline-none placeholder:text-p-muted/60" />
      </div>
      <p className="mt-2 mb-0 text-xs text-p-muted">Searches the transcripts of your podcasts. Use quotes to match an exact phrase.</p>
      {!online && <p role="status" className="mt-4 text-sm text-p-muted">You're offline. Search needs a connection to the server.</p>}
      {error && <p role="alert" className="mt-4 text-sm text-p-danger">{error}</p>}
      {needle.length < MIN_CHARS && !error && <EmptyState title="Find a moment in any episode">Only episodes that have a transcript are searched. Open an episode's transcript to generate one.</EmptyState>}
      {result && needle.length >= MIN_CHARS && (
        <div aria-busy={busy} className={busy ? 'opacity-60 transition-opacity' : ''}>
          <p className="mt-5 mb-1 text-[13px] text-p-muted" role="status">{result.data.total === 0 ? 'No matches' : `${result.data.total} episode${result.data.total === 1 ? '' : 's'}`}</p>
          {result.data.items.map((item) => (
            <section key={item.episodeId} className="mt-3 rounded-[14px] bg-p-surface p-3.5">
              <Link to={`/episode/${item.episodeId}`} className="block text-[15px] font-semibold text-p-text no-underline">{item.episodeTitle}</Link>
              <div className="text-[13px] text-p-muted">{item.podcastTitle} · {item.matches} {item.matches === 1 ? 'match' : 'matches'}</div>
              {item.hits.map((h) => (
                <button key={h.startMs} onClick={() => void open(item, h.startMs)} className="mt-2 flex w-full gap-3 rounded-xl border-0 bg-p-bg px-3 py-2.5 text-left text-p-text">
                  <span className="w-12 shrink-0 text-[13px] leading-5 font-semibold text-p-accent tnum">{clock(h.startMs)}</span>
                  <span className="min-w-0 flex-1 text-sm leading-5"><Highlight text={h.text} q={result.q} /></span>
                </button>
              ))}
              {item.matches > item.hits.length && <div className="mt-2 text-xs text-p-muted">+{item.matches - item.hits.length} more in the transcript</div>}
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}
