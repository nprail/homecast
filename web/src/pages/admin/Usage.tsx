import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { AdminUsage } from '@homecast/shared';
import { Button, Card, ErrorNote, Loading, PageHeader, Segmented, StatCard, Table, Th, Thead } from '../../components/ui';
import { download, get } from '../../lib/api';
import { fmtBytes, fmtDay, fmtInt } from '../../lib/format';

const RANGES = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
] as const;
const CHART_H = 220;
const TIP_SPACE = 72;

/** A tidy axis maximum so there are four evenly spaced gridlines. */
function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  return { top: step * 4, step };
}
const tickLabel = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function TrafficChart({ usage }: { usage: AdminUsage }) {
  const days = usage.daily;
  const gb = useMemo(() => days.map((d) => ({ day: d.day, audio: d.proxyBytes / 1e9, tr: d.transcribeBytes / 1e9 })), [days]);
  const { top, step } = niceScale(Math.max(0, ...gb.map((d) => d.audio + d.tr)));
  const [hover, setHover] = useState<number | null>(null);
  const idx = hover ?? gb.length - 1;
  const sel = gb[idx];
  const px = (v: number) => Math.round((v / top) * CHART_H);
  const labels = [0, Math.round((gb.length - 1) / 3), Math.round(((gb.length - 1) * 2) / 3), gb.length - 1].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div className="mt-4 flex gap-2">
      <div className="relative w-10 shrink-0 text-xs text-[#52514E] tnum" style={{ height: CHART_H, marginTop: TIP_SPACE }} aria-hidden="true">
        {[4, 3, 2, 1, 0].map((i) => (
          <span key={i} className="absolute right-0" style={{ top: ((4 - i) / 4) * CHART_H - 8 }}>{tickLabel(step * i)}</span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative" style={{ height: CHART_H, marginTop: TIP_SPACE }} role="group" aria-label="Traffic per day. Use the table view for exact values.">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="absolute right-0 left-0 h-px bg-chart-grid" style={{ top: (i / 4) * CHART_H }} />
          ))}
          <div className="absolute right-0 bottom-0 left-0 h-px bg-chart-axis" />
          <div className="absolute inset-0 flex items-end gap-[2px] px-[2px] sm:gap-1" onMouseLeave={() => setHover(null)}>
            {gb.map((d, i) => (
              <div
                key={d.day}
                tabIndex={0}
                role="img"
                aria-label={`${fmtDay(d.day)}: ${(d.audio + d.tr).toFixed(1)} GB, audio proxy ${d.audio.toFixed(1)}, transcription ${d.tr.toFixed(1)}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="flex h-full min-w-0 flex-1 flex-col justify-end gap-[2px] outline-offset-0"
                style={{ opacity: hover === null || hover === i ? 1 : 0.55 }}
              >
                <div className="rounded-t bg-chart-transcribe" style={{ height: px(d.tr) }} />
                <div className="bg-chart-audio" style={{ height: px(d.audio) }} />
              </div>
            ))}
          </div>
          {sel && (
            <div role="status" className="pointer-events-none absolute box-border w-[190px] -translate-x-1/2 rounded-[10px] border border-line-input bg-white px-3 py-2 text-xs text-ink shadow-[0_6px_18px_rgba(20,23,28,0.12)]" style={{ left: `clamp(95px, ${((idx + 0.5) / gb.length) * 100}%, calc(100% - 95px))`, top: -68 }}>
              <div className="font-semibold">{fmtDay(sel.day)} · {(sel.audio + sel.tr).toFixed(1)} GB</div>
              <div className="mt-0.5 flex items-center justify-between text-[#52514E]"><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px] bg-chart-audio" />Audio proxy</span><span>{sel.audio.toFixed(1)} GB</span></div>
              <div className="flex items-center justify-between text-[#52514E]"><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px] bg-chart-transcribe" />Transcription</span><span>{sel.tr.toFixed(1)} GB</span></div>
            </div>
          )}
        </div>
        <div className="mt-2 flex justify-between text-xs text-[#52514E]">
          {labels.map((i) => (<span key={i}>{fmtDay(gb[i]!.day)}</span>))}
        </div>
      </div>
    </div>
  );
}

function DailyTable({ usage }: { usage: AdminUsage }) {
  const rows = [...usage.daily].reverse();
  return (
    <div className="mt-4 max-h-[380px] overflow-auto rounded-[10px] border border-line-2">
      <Table className="tnum">
        <Thead>
          <Th>Day</Th>
          <Th align="right">Audio proxy</Th>
          <Th align="right">Feeds</Th>
          <Th align="right">Transcription</Th>
          <Th align="right">Transcript min</Th>
        </Thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.day} className="border-t border-line-2">
              <td className="py-2 pr-2 pl-5">{fmtDay(d.day)}</td>
              <td className="p-2 text-right">{fmtBytes(d.proxyBytes)}</td>
              <td className="p-2 text-right">{fmtBytes(d.feedBytes)}</td>
              <td className="p-2 text-right">{fmtBytes(d.transcribeBytes)}</td>
              <td className="py-2 pr-5 pl-2 text-right">{fmtInt(d.transcriptMinutes)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

export function UsagePage() {
  const [range, setRange] = useState<'30' | '90' | '365'>('30');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [exportErr, setExportErr] = useState<unknown>(null);
  const q = useQuery({ queryKey: ['admin', 'usage', range], queryFn: () => get<AdminUsage>(`/admin/usage?days=${range}`) });
  const u = q.data;
  const rangeLabel = RANGES.find((r) => r.value === range)!.label.toLowerCase();
  const total = u ? u.byUser.reduce((a, r) => a + r.proxyBytes + r.feedBytes + r.transcribeBytes, 0) : 0;

  return (
    <>
      <PageHeader
        title="Usage"
        subtitle="Tracking only. No quotas are enforced. Daily totals are kept for 1 year."
        actions={
          <div className="flex gap-2">
            <Segmented label="Range" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />
            <Button onClick={() => download(`/admin/usage?days=${range}&format=csv`, `usage-${range}d.csv`).then(() => setExportErr(null), setExportErr)}>Export CSV</Button>
          </div>
        }
      />
      <ErrorNote error={q.error ?? exportErr} className="mt-4" />
      {!u ? (
        !q.error && <Loading />
      ) : (
        <>
          <div className="mt-6 flex flex-wrap gap-4">
            <StatCard label="Audio proxy" value={`${fmtBytes(u.totals.proxyBytes)}`} caption="Playback and downloads in the web app" />
            <StatCard label="Feed fetches" value={fmtBytes(u.totals.feedBytes)} caption={`${fmtInt(u.feedCount)} feeds, every ${u.pollIntervalMinutes} min`} />
            <StatCard label="Transcription downloads" value={fmtBytes(u.totals.transcribeBytes)} caption="Audio fetched for Whisper" />
            <StatCard label="Transcript minutes" value={fmtInt(u.totals.transcriptMinutes)} caption={`Processed with ${u.whisperModel.split('-')[0]}`} />
          </div>

          <section className="mt-4 rounded-[14px] border border-line bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="m-0 font-display text-lg font-semibold">Traffic per day</h2>
                <div className="mt-0.5 text-[13px] text-[#52514E]">Gigabytes, all users, {fmtDay(u.from)} to {fmtDay(u.to)}</div>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-4 text-[13px] text-[#52514E]">
                  <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] bg-chart-audio" />Audio proxy</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] bg-chart-transcribe" />Transcription downloads</span>
                </div>
                <Segmented small label="View" value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />
              </div>
            </div>
            {view === 'chart' ? <TrafficChart usage={u} /> : <DailyTable usage={u} />}
          </section>

          <Card className="mt-4" title={`By user, last ${rangeLabel}`}>
            <Table className="tnum" stack>
              <Thead>
                <Th>User</Th>
                <Th align="right">Audio proxy</Th>
                <Th align="right">Feeds</Th>
                <Th align="right">Transcription</Th>
                <Th align="right">Transcript min</Th>
                <Th className="min-w-[160px]">Share of traffic</Th>
              </Thead>
              <tbody>
                {u.byUser.map((r) => {
                  const share = total ? Math.round(((r.proxyBytes + r.feedBytes + r.transcribeBytes) / total) * 100) : 0;
                  return (
                    <tr key={r.userId} className="border-t border-line-2">
                      <td className="py-3 pr-2 pl-5 font-medium">{r.username}</td>
                      <td data-label="Audio proxy" className="p-2 text-right whitespace-nowrap">{fmtBytes(r.proxyBytes)}</td>
                      <td data-label="Feeds" className="p-2 text-right whitespace-nowrap">{fmtBytes(r.feedBytes)}</td>
                      <td data-label="Transcription" className="p-2 text-right whitespace-nowrap">{fmtBytes(r.transcribeBytes)}</td>
                      <td data-label="Transcript min" className="p-2 text-right whitespace-nowrap">{fmtInt(r.transcriptMinutes)}</td>
                      <td data-label="Share" className="py-3 pr-5 pl-2">
                        <div className="flex min-w-0 flex-1 items-center gap-2.5 md:flex-none">
                          <div className="h-2 flex-1 rounded bg-line-2"><div className="h-2 rounded bg-chart-audio" style={{ width: `${share}%` }} /></div>
                          <span className="w-9 text-right text-[13px] text-[#52514E]">{share}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!u.byUser.length && (
                  <tr><td colSpan={6} className="px-5 py-8 text-center text-muted">No usage recorded in this period.</td></tr>
                )}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
