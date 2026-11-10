import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuditEntry } from '@homecast/shared';
import { Button, Card, Empty, ErrorNote, Loading, PageHeader, Segmented, Table, Th, Thead } from '../../components/ui';
import { get } from '../../lib/api';
import { describeAudit } from '../../lib/audit';
import { fmtWhen } from '../../lib/format';

interface Page {
  entries: AuditEntry[];
  nextBefore: number | null;
}

export function AuditPage() {
  const [filter, setFilter] = useState<'all' | 'auth' | 'admin'>('all');
  const q = useInfiniteQuery({
    queryKey: ['admin', 'audit', filter],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => get<Page>(`/admin/audit?limit=50&filter=${filter}${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <>
      <PageHeader title="Audit log" subtitle="Sign-ins, failed sign-ins and admin actions. Kept for one year." actions={<Segmented label="Filter" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'auth', label: 'Sign-ins' }, { value: 'admin', label: 'Admin' }]} />} />
      <ErrorNote error={q.error} className="mt-4" />
      <Card className="mt-6">
        {q.isLoading ? (
          <Loading />
        ) : !entries.length ? (
          <Empty>No entries.</Empty>
        ) : (
          <Table stack>
            <Thead>
              <Th>When</Th>
              <Th>Event</Th>
              <Th>IP address</Th>
            </Thead>
            <tbody>
              {entries.map((e) => {
                const v = describeAudit(e);
                return (
                  <tr key={e.id} className="border-t border-line-2 align-top">
                    <td className="tnum py-3 pr-2 pl-5 whitespace-nowrap text-muted">{fmtWhen(e.at)}</td>
                    <td data-block className="px-2 py-3">
                      <div className={v.tone === 'warn' ? 'font-medium text-warn-fg' : ''}>{v.text}</div>
                      {v.note && <div className="text-xs text-muted">{v.note}</div>}
                    </td>
                    <td data-label="IP address" className="py-3 pr-5 pl-2 font-mono text-[13px] text-muted">{e.ip ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        {q.hasNextPage && (
          <div className="border-t border-line-2 p-4 text-center">
            <Button onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
