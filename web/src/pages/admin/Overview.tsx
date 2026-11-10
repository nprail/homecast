import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { AdminFeed, AdminOverview } from '@homecast/shared';
import { Badge, Button, Card, ErrorNote, Loading, PageHeader, StatCard, Table, Th, Thead } from '../../components/ui';
import { get, post } from '../../lib/api';
import { describeAudit } from '../../lib/audit';
import { fmtBytes, fmtClock, fmtInt, fmtUptime, fmtWhen, relTime } from '../../lib/format';

export function FeedStatusBadge({ feed }: { feed: Pick<AdminFeed, 'status' | 'statusLabel'> }) {
  const tone = feed.status === 'ok' ? 'ok' : feed.status === 'error' ? 'bad' : feed.status === 'slow' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{feed.statusLabel}</Badge>;
}

export function OverviewPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => get<AdminOverview>('/admin/overview'), refetchInterval: 30_000 });
  const backup = useMutation({ mutationFn: () => post('/admin/backup'), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }) });
  const o = q.data;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={o ? `Version ${o.version} · up ${fmtUptime(o.uptimeSec)}` : undefined}
        actions={
          <Button onClick={() => backup.mutate()} disabled={backup.isPending}>
            {backup.isPending ? 'Backing up…' : 'Back up now'}
          </Button>
        }
      />
      {backup.error && <ErrorNote error={backup.error} className="mt-4" />}
      {q.error && <ErrorNote error={q.error} className="mt-4" />}
      {!o ? (
        !q.error && <Loading />
      ) : (
        <>
          <div className="mt-6 flex flex-wrap gap-4">
            <StatCard label="Users" value={fmtInt(o.users.total)} caption={`${o.users.activeToday} active today`} />
            <StatCard label="Podcasts" value={fmtInt(o.podcasts.total)} caption={o.podcasts.withErrors ? `${o.podcasts.withErrors} with fetch errors` : 'No fetch errors'} captionTone={o.podcasts.withErrors ? 'bad' : undefined} />
            <StatCard label="Episodes" value={fmtInt(o.episodes.total)} caption={`+${fmtInt(o.episodes.last24h)} in the last 24 h`} />
            <StatCard label="Database" value={fmtBytes(o.database.bytes, 0)} caption={o.database.diskFreeBytes !== null ? `${fmtBytes(o.database.diskFreeBytes, 0)} disk free` : 'Disk free unknown'} />
            <StatCard
              label="Last backup"
              value={o.backup.lastAt ? fmtClock(o.backup.lastAt) : 'Never'}
              caption={o.backup.lastAt ? `${fmtWhen(o.backup.lastAt).split(',')[0]} · ${o.backup.kept} kept` : `${o.backup.kept} kept`}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-start gap-4">
            <Card
              className="min-w-[min(100%,480px)] flex-[3_1_480px]"
              title="Feed health"
              action={<Link to="/admin/feeds" className="text-sm font-medium text-brand no-underline">View all {fmtInt(o.podcasts.total)}</Link>}
            >
              <Table stack>
                <Thead>
                  <Th>Podcast</Th>
                  <Th>Subscribers</Th>
                  <Th>Last fetched</Th>
                  <Th>Status</Th>
                </Thead>
                <tbody>
                  {o.feedHealth.map((f) => (
                    <tr key={f.id} className="border-t border-line-2">
                      <td className="py-3 pr-2 pl-5 font-medium">{f.title}</td>
                      <td data-label="Subscribers" className="tnum px-2 py-3">{f.subscribers}</td>
                      <td data-label="Last fetched" className="px-2 py-3 whitespace-nowrap text-muted">{relTime(f.lastFetchedAt)}</td>
                      <td data-label="Status" className="py-3 pr-5 pl-2">
                        <FeedStatusBadge feed={f} />
                      </td>
                    </tr>
                  ))}
                  {!o.feedHealth.length && (
                    <tr>
                      <td colSpan={4} className="px-5 py-8 text-center text-muted">
                        No podcasts yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Card>

            <Card className="min-w-[min(100%,320px)] flex-[2_1_320px]" title="Recent activity" action={<Link to="/admin/audit" className="text-sm font-medium text-brand no-underline">Audit log</Link>}>
              <ul className="m-0 list-none p-0">
                {o.recentActivity.map((e, i) => {
                  const v = describeAudit(e);
                  return (
                    <li key={e.id} className={`px-5 py-3 ${i ? 'border-t border-line-2' : ''}`}>
                      <div className={`text-sm ${v.tone === 'warn' ? 'font-medium text-warn-fg' : ''}`}>{v.text}</div>
                      <div className="text-xs text-muted">
                        {e.action === 'backup.completed' ? fmtWhen(e.at) : relTime(e.at)}
                        {v.note ? ` · ${v.note}` : ''}
                      </div>
                    </li>
                  );
                })}
                {!o.recentActivity.length && <li className="px-5 py-8 text-center text-sm text-muted">Nothing yet.</li>}
              </ul>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
