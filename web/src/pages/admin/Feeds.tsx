import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AdminFeed } from '@homecast/shared';
import { Badge, Button, Card, CardNote, Empty, ErrorNote, inputCls, Loading, PageHeader, Segmented, Table, Th, Thead } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { fmtInt, relTime } from '../../lib/format';
import { FeedStatusBadge } from './Overview';

interface FeedList {
  total: number;
  orphans: number;
  feeds: AdminFeed[];
}

export function FeedsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'all' | 'errors'>('all');
  const [search, setSearch] = useState('');
  const q = useQuery({
    queryKey: ['admin', 'feeds', status, search],
    queryFn: () => get<FeedList>(`/admin/feeds?status=${status}&limit=500${search ? `&q=${encodeURIComponent(search)}` : ''}`),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const refresh = useMutation({ mutationFn: (id: string) => post(`/admin/feeds/${id}/refresh`), onSuccess: invalidate });
  const hide = useMutation({ mutationFn: (f: AdminFeed) => patch(`/admin/feeds/${f.id}`, { hiddenFromDiscover: !f.hiddenFromDiscover }), onSuccess: invalidate });
  const prune = useMutation({ mutationFn: () => del<{ removed: number }>('/admin/feeds/orphans'), onSuccess: invalidate });
  const d = q.data;

  return (
    <>
      <PageHeader
        title="Feeds"
        subtitle="Fetch status for every podcast on this server."
        actions={
          <Button
            variant="danger"
            disabled={!d?.orphans || prune.isPending}
            onClick={() => {
              if (window.confirm(`Remove ${d?.orphans} feed${d?.orphans === 1 ? '' : 's'} with no subscribers, along with their episodes?`)) prune.mutate();
            }}
          >
            Remove orphans{d?.orphans ? ` (${d.orphans})` : ''}
          </Button>
        }
      />
      <ErrorNote error={q.error ?? refresh.error ?? hide.error ?? prune.error} className="mt-4" />
      {prune.data && <div role="status" className="mt-4 rounded-[10px] bg-ok-bg px-4 py-3 text-sm text-ok-fg">Removed {prune.data.removed} orphaned feed{prune.data.removed === 1 ? '' : 's'}.</div>}
      <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <input type="search" aria-label="Search podcasts" placeholder="Search podcasts" value={search} onChange={(e) => setSearch(e.target.value)} className={`${inputCls} w-full sm:max-w-xs`} />
        <Segmented label="Filter" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'errors', label: 'Errors' }]} />
      </div>
      <Card className="mt-4" title={`Podcasts${d ? ` (${fmtInt(d.total)})` : ''}`}>
        {q.isLoading ? (
          <Loading />
        ) : !d?.feeds.length ? (
          <Empty>{status === 'errors' ? 'No feeds with errors.' : 'No podcasts found.'}</Empty>
        ) : (
          <Table stack>
            <Thead>
              <Th>Podcast</Th>
              <Th>Subscribers</Th>
              <Th>Episodes</Th>
              <Th>Last fetched</Th>
              <Th>Status</Th>
              <Th>Discover</Th>
              <Th srOnly>Actions</Th>
            </Thead>
            <tbody>
              {d.feeds.map((f) => (
                <tr key={f.id} className="border-t border-line-2">
                  <td className="py-3 pr-2 pl-5 md:max-w-[320px]">
                    <div className="flex items-center gap-2 font-medium">
                      <span className="truncate">{f.title}</span>
                      {f.isPrivate && <Badge tone="neutral">Private</Badge>}
                    </div>
                    <div className="truncate font-mono text-xs text-muted" title={f.feedUrl}>{f.feedUrl}</div>
                  </td>
                  <td data-label="Subscribers" className="tnum px-2 py-3">{f.subscribers}</td>
                  <td data-label="Episodes" className="tnum px-2 py-3">{fmtInt(f.episodeCount)}</td>
                  <td data-label="Last fetched" className="px-2 py-3 whitespace-nowrap text-muted">{relTime(f.lastFetchedAt)}</td>
                  <td data-label="Status" className="px-2 py-3"><FeedStatusBadge feed={f} /></td>
                  <td data-label="Discover" className="px-2 py-3">
                    {f.isPrivate ? (
                      <span className="text-muted">Never listed</span>
                    ) : (
                      <Button small disabled={hide.isPending} onClick={() => hide.mutate(f)} aria-label={`${f.hiddenFromDiscover ? 'List' : 'Hide'} ${f.title} in Discover`}>
                        {f.hiddenFromDiscover ? 'Hidden' : 'Listed'}
                      </Button>
                    )}
                  </td>
                  <td data-actions className="px-5 py-3 text-right">
                    <Button small variant="outlineBrand" disabled={refresh.isPending && refresh.variables === f.id} onClick={() => refresh.mutate(f.id)}>
                      {refresh.isPending && refresh.variables === f.id ? 'Refreshing…' : 'Refresh now'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <CardNote>Private and tokenized feeds are never listed in Discover and their URLs are redacted here. Feeds with no subscribers are not polled.</CardNote>
      </Card>
    </>
  );
}
