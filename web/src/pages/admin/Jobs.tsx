import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminJob, AdminJobs } from '@homecast/shared';
import { Badge, Button, Card, CardNote, ErrorNote, Loading, PageHeader, StatCard, Table, Th, Thead } from '../../components/ui';
import { get, post } from '../../lib/api';
import { fmtAudioLength, fmtElapsed, fmtWhen } from '../../lib/format';
import { useEffect, useState } from 'react';

function useTick(active: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

function StatusCell({ job }: { job: AdminJob }) {
  switch (job.status) {
    case 'running':
      return (
        <div className="min-w-0 flex-1 md:flex-none">
          <div className="flex items-center gap-2.5">
            <div className="h-2 flex-1 rounded bg-line" role="progressbar" aria-valuenow={job.progress ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label={`${job.episodeTitle} progress`}>
              <div className="h-2 rounded bg-brand transition-[width]" style={{ width: `${job.progress ?? 0}%` }} />
            </div>
            <span className="tnum text-[13px] font-semibold text-brand">{job.progress ?? 0}%</span>
          </div>
          <div className="mt-1 text-xs text-muted">{job.stage ?? 'Running'}</div>
        </div>
      );
    case 'queued':
      return <Badge tone="neutral">Queued · position {job.queuePosition ?? 1}</Badge>;
    case 'failed':
      return <Badge tone="bad">Failed</Badge>;
    case 'cancelled':
      return <Badge tone="off">Cancelled</Badge>;
    case 'done':
      return <Badge tone="ok">Done · {job.source === 'feed' ? 'Publisher transcript' : 'Whisper'}</Badge>;
  }
}

function timeText(job: AdminJob): string {
  switch (job.status) {
    case 'running': return `${fmtElapsed(Date.now() - (job.startedAt ?? job.createdAt))} so far`;
    case 'queued': return 'Waiting';
    case 'failed':
    case 'cancelled': return job.finishedAt ? fmtWhen(job.finishedAt) : '—';
    case 'done': return job.source === 'feed' || (job.durationMs ?? 0) < 1500 ? 'Instant' : `Took ${fmtElapsed(job.durationMs ?? 0)}`;
  }
}

export function JobsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'jobs'],
    queryFn: () => get<AdminJobs>('/admin/jobs'),
    refetchInterval: (query) => ((query.state.data?.counts.running ?? 0) + (query.state.data?.counts.queued ?? 0) > 0 ? 3000 : 15000),
  });
  const act = useMutation({ mutationFn: ({ id, kind }: { id: string; kind: 'retry' | 'cancel' }) => post(`/admin/jobs/${id}/${kind}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'jobs'] }) });
  const d = q.data;
  useTick(!!d && d.counts.running > 0);

  return (
    <>
      <PageHeader title="Jobs" subtitle={d ? `Transcription queue · Whisper ${d.model.replace(/^ggml-/, '').replace(/-q(\d_\d)$/, ' (q$1)')} · ${d.concurrency === 1 ? 'one job at a time' : `${d.concurrency} jobs at a time`}` : undefined} />
      <ErrorNote error={q.error ?? act.error} className="mt-4" />
      {!d ? (
        !q.error && <Loading />
      ) : (
        <>
          <div className="mt-6 flex flex-wrap gap-4">
            <StatCard label="Running" value={d.counts.running} />
            <StatCard label="Queued" value={d.counts.queued} />
            <StatCard label="Done, last 24 h" value={d.counts.doneLast24h} />
            <StatCard label="Failed, last 24 h" value={d.counts.failedLast24h} valueTone={d.counts.failedLast24h ? 'bad' : undefined} />
          </div>
          <Card className="mt-4" title="Transcript jobs">
            <Table stack>
              <Thead>
                <Th>Episode</Th>
                <Th>Requested by</Th>
                <Th className="min-w-[190px]">Status</Th>
                <Th>Audio length</Th>
                <Th>Time</Th>
                <Th srOnly>Actions</Th>
              </Thead>
              <tbody>
                {d.jobs.map((j) => (
                  <tr key={j.id} className="border-t border-line-2 align-top">
                    <td className="py-3 pr-2 pl-5">
                      <div className="font-medium">{j.episodeTitle}</div>
                      {j.error && <div className="text-xs text-bad-fg">{j.error}</div>}
                      <div className="text-xs text-muted">{j.podcastTitle}</div>
                    </td>
                    <td data-label="Requested by" className="px-2 py-3">{j.requestedBy}</td>
                    <td data-label="Status" className="px-2 py-3"><StatusCell job={j} /></td>
                    <td data-label="Audio length" className="px-2 py-3 whitespace-nowrap text-muted">{fmtAudioLength(j.audioSeconds)}</td>
                    <td data-label="Time" className="tnum px-2 py-3 whitespace-nowrap text-muted">{timeText(j)}</td>
                    <td data-actions className="py-3 pr-5 pl-2 text-right">
                      {(j.status === 'running' || j.status === 'queued') && (
                        <Button small variant="danger" disabled={act.isPending} onClick={() => act.mutate({ id: j.id, kind: 'cancel' })}>
                          Cancel
                        </Button>
                      )}
                      {(j.status === 'failed' || j.status === 'cancelled') && (
                        <Button small variant="outlineBrand" disabled={act.isPending} onClick={() => act.mutate({ id: j.id, kind: 'retry' })}>
                          Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                {!d.jobs.length && (
                  <tr>
                    <td colSpan={6} className="px-5 py-10 text-center text-muted">
                      No transcript jobs yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
            <CardNote>Transcripts are shared across users. A request for an episode that already has a job or transcript attaches to it.</CardNote>
          </Card>
        </>
      )}
    </>
  );
}
