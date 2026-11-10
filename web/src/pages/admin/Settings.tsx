import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AdminFeed, AdminOverview, AdminSettings, AutoTranscribeSettings } from '@homecast/shared';
import { Button, Card, ErrorNote, Field, inputCls, Loading, PageHeader, Switch } from '../../components/ui';
import { fmtInt } from '../../lib/format';
import { get, patch, post } from '../../lib/api';
import { fmtBytes, fmtWhen } from '../../lib/format';

const MODELS = [
  { value: 'base.en-q5_1', label: 'base.en (q5_1): default, about 60 MB' },
  { value: 'small.en-q5_1', label: 'small.en (q5_1): better accuracy, about 3x the compute' },
  { value: 'base', label: 'base (multilingual)' },
];

function Choice({ name, checked, onChange, title, hint, disabled }: { name: string; checked: boolean; onChange: () => void; title: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-[10px] border px-3.5 py-3 ${checked ? 'border-brand bg-brand-soft' : 'border-line'} ${disabled ? 'opacity-50' : ''}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} className="mt-1 accent-[#0f766e]" />
      <span><span className="block text-sm font-medium">{title}</span>{hint && <span className="block text-[13px] text-muted">{hint}</span>}</span>
    </label>
  );
}

function AutoTranscribe({ value, onChange, pending, saved }: { value: AutoTranscribeSettings; onChange: (v: AutoTranscribeSettings) => void; pending: number; saved: boolean }) {
  const feeds = useQuery({ queryKey: ['admin', 'feeds', 'all', 'picker'], queryFn: () => get<{ feeds: AdminFeed[] }>('/admin/feeds?limit=500') });
  const [filter, setFilter] = useState('');
  const list = (feeds.data?.feeds ?? []).filter((f) => f.subscribers > 0 && f.title.toLowerCase().includes(filter.toLowerCase()));
  const selected = new Set(value.podcastIds ?? []);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ ...value, podcastIds: [...next].sort() });
  };
  const target = value.podcastIds === null ? 'all' : 'selected';
  return (
    <Card title="Auto-transcribe">
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="font-medium">Transcribe episodes automatically</div>
            <div className="text-[13px] text-muted">Queues Whisper jobs without anyone asking. Publisher transcripts are used when the feed has them. Only podcasts someone subscribes to are considered.</div>
          </div>
          <Switch label="Transcribe episodes automatically" checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} />
        </div>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" disabled={!value.enabled}>
          <legend className="mb-1 p-0 text-[13px] font-medium text-ink-2">Which episodes</legend>
          <Choice name="at-scope" disabled={!value.enabled} checked={value.scope === 'new'} onChange={() => onChange({ ...value, scope: 'new' })} title="New episodes only" hint="Episodes the server finds from now on. The existing back catalogue is left alone." />
          <Choice name="at-scope" disabled={!value.enabled} checked={value.scope === 'all'} onChange={() => onChange({ ...value, scope: 'all' })} title="All episodes, including the back catalogue" hint="Fed into the queue a few at a time, newest first, so manual requests are never stuck behind them. This can take a long time on large feeds." />
        </fieldset>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" disabled={!value.enabled}>
          <legend className="mb-1 p-0 text-[13px] font-medium text-ink-2">Which podcasts</legend>
          <Choice name="at-target" disabled={!value.enabled} checked={target === 'all'} onChange={() => onChange({ ...value, podcastIds: null })} title="All podcasts" />
          <Choice name="at-target" disabled={!value.enabled} checked={target === 'selected'} onChange={() => onChange({ ...value, podcastIds: value.podcastIds ?? [] })} title="Only selected podcasts" />
          {target === 'selected' && value.enabled && (
            <div className="rounded-[10px] border border-line">
              <div className="border-b border-line-2 p-2">
                <input type="search" aria-label="Filter podcasts" placeholder="Filter podcasts" value={filter} onChange={(e) => setFilter(e.target.value)} className={inputCls} />
              </div>
              <ul className="m-0 max-h-64 list-none overflow-y-auto p-0">
                {list.map((f) => (
                  <li key={f.id} className="border-b border-line-2 last:border-b-0">
                    <label className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 text-sm">
                      <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} className="h-4 w-4 accent-[#0f766e]" />
                      <span className="min-w-0 flex-1 truncate">{f.title}</span>
                      <span className="text-xs text-muted">{fmtInt(f.episodeCount)} episodes</span>
                    </label>
                  </li>
                ))}
                {!list.length && <li className="px-3.5 py-4 text-center text-sm text-muted">{feeds.isLoading ? 'Loading…' : 'No podcasts found.'}</li>}
              </ul>
              <div className="px-3.5 py-2 text-xs text-muted">{selected.size} selected{selected.size === 0 ? '. Nothing will be transcribed until you pick at least one.' : ''}</div>
            </div>
          )}
        </fieldset>
        {value.enabled && (
          <div className="text-[13px] text-muted" role="status">
            {saved ? `${fmtInt(pending)} episode${pending === 1 ? '' : 's'} waiting to be queued.` : 'Save to apply. The count of waiting episodes updates after saving.'}
          </div>
        )}
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => get<AdminSettings>('/admin/settings') });
  const overview = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => get<AdminOverview>('/admin/overview') });
  const [form, setForm] = useState<AdminSettings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) setForm(q.data);
  }, [q.data]);

  const save = useMutation({
    mutationFn: ({ autoTranscribePending: _p, ...s }: AdminSettings) => patch<AdminSettings>('/admin/settings', s),
    onSuccess: (s) => {
      qc.setQueryData(['admin', 'settings'], s);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });
  const backup = useMutation({ mutationFn: () => post('/admin/backup'), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'overview'] }) });
  const norm = (f: AdminSettings | null | undefined) => JSON.stringify(f && { ...f, autoTranscribePending: 0 });
  const dirty = !!form && !!q.data && norm(form) !== norm(q.data);
  const custom = form && !MODELS.some((m) => m.value === form.whisperModel);
  const b = overview.data?.backup;

  return (
    <>
      <PageHeader title="Settings" subtitle="Server-wide configuration." />
      <ErrorNote error={q.error ?? save.error ?? backup.error} className="mt-4" />
      {!form ? (
        !q.error && <Loading />
      ) : (
        <div className="mt-6 flex max-w-3xl flex-col gap-4">
          <Card title="Registration">
            <div className="flex items-center justify-between gap-6 px-5 py-4">
              <div>
                <div className="font-medium">Allow new sign-ups</div>
                <div className="text-[13px] text-muted">Registration is always invite-only. Turn this off to stop accepting invite codes entirely.</div>
              </div>
              <Switch label="Allow new sign-ups" checked={form.registrationOpen} onChange={(v) => setForm({ ...form, registrationOpen: v })} />
            </div>
          </Card>
          <Card title="Feeds">
            <div className="px-5 py-4">
              <Field label="Poll interval (minutes)" hint="How often each subscribed feed is checked, with per-feed jitter and backoff on failures.">
                {(id) => <input id={id} type="number" min={5} max={1440} className={`${inputCls} max-w-[160px]`} value={form.pollIntervalMinutes} onChange={(e) => setForm({ ...form, pollIntervalMinutes: Number(e.target.value) })} />}
              </Field>
            </div>
          </Card>
          <Card title="Transcription">
            <div className="flex flex-col gap-3 px-5 py-4">
              <Field label="Whisper model" hint="Looked up as ggml-<model>.bin in the server's model directory.">
                {(id) => (
                  <select id={id} className={inputCls} value={custom ? '__custom' : form.whisperModel} onChange={(e) => e.target.value !== '__custom' && setForm({ ...form, whisperModel: e.target.value })}>
                    {MODELS.map((m) => (<option key={m.value} value={m.value}>{m.label}</option>))}
                    {custom && <option value="__custom">Custom: {form.whisperModel}</option>}
                  </select>
                )}
              </Field>
              <Field label="Custom model name">
                {(id) => <input id={id} className={`${inputCls} font-mono`} value={form.whisperModel} onChange={(e) => setForm({ ...form, whisperModel: e.target.value })} pattern="[A-Za-z0-9._\-/]+" />}
              </Field>
            </div>
          </Card>
          <AutoTranscribe value={form.autoTranscribe} onChange={(autoTranscribe) => setForm({ ...form, autoTranscribe })} pending={q.data?.autoTranscribePending ?? 0} saved={!dirty} />
          <div className="flex items-center gap-3">
            <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => form && save.mutate(form)}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
            {dirty && <Button onClick={() => q.data && setForm(q.data)}>Discard</Button>}
            {saved && <span role="status" className="text-sm text-ok-fg">Saved</span>}
          </div>

          <Card title="Backups" className="mt-2">
            <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <div className="text-sm">
                <div>{b?.lastAt ? `Last backup ${fmtWhen(b.lastAt)}${b.lastBytes ? ` (${fmtBytes(b.lastBytes, 0)})` : ''}` : 'No backup yet'}</div>
                <div className="text-[13px] text-muted">Daily at 03:00, newest {b?.kept ?? 0} of 14 kept in data/backups.</div>
              </div>
              <Button onClick={() => backup.mutate()} disabled={backup.isPending}>
                {backup.isPending ? 'Backing up…' : 'Back up now'}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
