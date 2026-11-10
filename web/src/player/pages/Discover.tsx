import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { DiscoverItem } from '@homecast/shared';
import { get, post } from '../../lib/api';
import { useApp } from '../AppData';
import { Art } from '../components/Art';
import { EmptyState, Page, Pills } from '../components/page';
import { Check } from '../components/picons';
import { plural } from '../lib/format';
import { useOnline } from '../lib/hooks';
import { toast } from '../lib/ui';

type Sort = 'subscribers' | 'recent' | 'az';

/** Podcasts other users on this server follow (spec §3.10): counts only, never who. Last list cached offline. */
export function DiscoverPage() {
  const { db, sync } = useApp();
  const online = useOnline();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('subscribers');
  const [items, setItems] = useState<DiscoverItem[] | null>(null);
  const [cached, setCached] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await get<{ items: DiscoverItem[] }>(`/discover?sort=${sort}&limit=100${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`);
        if (!live) return;
        setItems(r.items);
        setCached(false);
        setErr(null);
        if (!q.trim() && sort === 'subscribers') await db.setKV('discover.cache', r.items);
      } catch (e) {
        if (!live) return;
        const last = await db.getKV<DiscoverItem[] | null>('discover.cache', null);
        if (e instanceof TypeError) {
          const needle = q.trim().toLowerCase();
          setItems((last ?? []).filter((i) => !needle || i.title.toLowerCase().includes(needle) || i.author.toLowerCase().includes(needle)));
          setCached(true);
        } else setErr(e instanceof Error ? e.message : 'Could not load Discover');
      }
    }, q ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [db, q, sort, online]);

  const subscribe = async (i: DiscoverItem) => {
    try {
      await post('/subscriptions', { podcastId: i.id });
      setAdded((s) => new Set(s).add(i.id));
      await sync.sync();
      toast(`Subscribed to ${i.title}`);
    } catch (e) {
      toast(e instanceof TypeError ? 'You need a connection to subscribe.' : e instanceof Error ? e.message : 'Could not subscribe');
    }
  };
  return (
    <Page title="Discover">
      <p className="mt-1 mb-0 text-[13px] text-p-muted">Podcasts other people on this server follow. Only counts are shown.</p>
      <div className="mt-4 flex h-12 items-center rounded-xl border border-p-line bg-p-surface px-3.5">
        <label htmlFor="dq" className="sr-only">Search by title or author</label>
        <input id="dq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title or author" className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-p-text outline-none placeholder:text-p-muted/60" />
      </div>
      <div className="mt-3"><Pills<Sort> label="Sort" value={sort} onChange={setSort} options={[{ value: 'subscribers', label: 'Most followed' }, { value: 'recent', label: 'Recently added' }, { value: 'az', label: 'A to Z' }]} /></div>
      {cached && <div role="status" className="mt-3 rounded-xl bg-p-amber-soft px-3.5 py-2 text-[13px] text-p-amber">Offline: showing the last list saved on this device.</div>}
      {err && <div role="alert" className="mt-3 text-sm text-p-danger">{err}</div>}
      <div className="mt-3">
        {items?.map((i) => (
          <div key={i.id} className="flex items-center gap-3 border-b border-p-raised py-3">
            <Link to={`/podcast/${i.id}`} className="flex min-w-0 flex-1 items-center gap-3 text-p-text no-underline">
              <Art podcast={i} size={56} radius={12} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold">{i.title}</span>
                <span className="block truncate text-[13px] text-p-muted">{i.author ? `${i.author} · ` : ''}{plural(i.subscriberCount, 'subscriber')}</span>
              </span>
            </Link>
            {added.has(i.id) ? <span className="inline-flex h-9 items-center gap-1.5 text-sm font-semibold text-p-accent"><Check size={16} />Subscribed</span> : <button onClick={() => void subscribe(i)} disabled={!online} className="h-9 rounded-full border border-p-accent bg-transparent px-4 text-sm font-semibold text-p-accent disabled:opacity-50">Subscribe</button>}
          </div>
        ))}
        {items && !items.length && <EmptyState title={q ? 'No matches' : 'Nothing to discover yet'}>{q ? 'Try a different search.' : 'Podcasts appear here once other people on this server subscribe to public feeds you don’t follow yet.'}</EmptyState>}
        {!items && !err && <p className="py-10 text-center text-sm text-p-muted">Loading…</p>}
      </div>
    </Page>
  );
}
