import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AdminFeed, AdminOverview, AdminSettings, AutoTranscribeSettings, EpisodeMirrorSettings, EpisodeMirrorStatus } from '@homecast/shared';
import { Button, Card, ErrorNote, Field, inputCls, Loading, PageHeader, Switch } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { fmtBytes, fmtInt, fmtWhen } from '../../lib/format';

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
          <Choice name="at-scope" disabled={!value.enabled} checked={value.scope === 'recent'} onChange={() => onChange({ ...value, scope: 'recent' })} title="The latest episodes of each podcast" hint="The newest N episodes of every podcast, including ones released later. Older episodes are left alone." />
          {value.scope === 'recent' && (
            <div className="ml-8 flex items-center gap-2 text-sm">
              <label htmlFor="at-recent">Last</label>
              <input
                id="at-recent"
                type="number"
                min={1}
                max={1000}
                step={1}
                disabled={!value.enabled}
                value={value.recentCount}
                onChange={(e) => onChange({ ...value, recentCount: Math.min(1000, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
                className={`${inputCls} max-w-[110px]`}
              />
              <span className="text-muted">episodes per podcast</span>
            </div>
          )}
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

const STOP_TEXT = {
  cap: 'Paused: the storage cap is reached. Raise the cap or delete copies to continue.',
  disk: "Paused: less than 5 GB is free on the server's data disk.",
} as const;

function EpisodeHosting({
  value,
  status,
  savedEnabled,
  onChange,
  onDeleted,
}: {
  value: EpisodeMirrorSettings;
  status: EpisodeMirrorStatus | undefined;
  savedEnabled: boolean;
  onChange: (v: EpisodeMirrorSettings) => void;
  onDeleted: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => del<{ removed: number }>('/admin/mirror'),
    onSuccess: onDeleted,
  });
  const stop = status?.stoppedReason ? STOP_TEXT[status.stoppedReason] : null;
  return (
    <Card title="Episode hosting">
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="font-medium">Keep copies of episodes on this server</div>
            <div className="text-[13px] text-muted">
              Off by default. When on, the server downloads every episode of the podcasts people subscribe to, one at a time, newest first, and serves them from its own disk. This uses server disk space and bandwidth.
            </div>
          </div>
          <Switch label="Keep copies of episodes on this server" checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} />
        </div>
        <Field label="Storage cap (GB)" hint="Leave empty for no cap. Copying also stops while less than 5 GB is free on the data disk.">
          {(id) => (
            <input
              id={id}
              type="number"
              min={0.1}
              step={0.5}
              placeholder="No cap"
              value={value.maxGB ?? ''}
              onChange={(e) => onChange({ ...value, maxGB: e.target.value === '' ? null : Number(e.target.value) })}
              className={`${inputCls} max-w-[200px]`}
            />
          )}
        </Field>
        {status && (
          <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div><dt className="text-[13px] text-muted">Hosted</dt><dd className="m-0 font-medium tnum">{fmtInt(status.hosted)}</dd></div>
            <div><dt className="text-[13px] text-muted">Waiting</dt><dd className="m-0 font-medium tnum">{fmtInt(status.pending)}</dd></div>
            <div><dt className="text-[13px] text-muted">Failed</dt><dd className={`m-0 font-medium tnum ${status.failed ? 'text-bad-fg' : ''}`}>{fmtInt(status.failed)}</dd></div>
            <div><dt className="text-[13px] text-muted">Used</dt><dd className="m-0 font-medium tnum">{fmtBytes(status.bytes)}{status.freeBytes !== null ? ` · ${fmtBytes(status.freeBytes, 0)} free` : ''}</dd></div>
          </dl>
        )}
        {status?.lastError && <div className="text-[13px] text-bad-fg">Last error: {status.lastError}</div>}
        {value.enabled && stop && <div className="text-[13px] text-warn-fg" role="status">{stop}</div>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-2 pt-4">
          <div className="text-[13px] text-muted">{savedEnabled ? 'Turn hosting off before deleting copies.' : 'Deletes every copy from the server. They are downloaded again if hosting is turned back on.'}</div>
          <Button
            variant="danger"
            disabled={savedEnabled || remove.isPending || !status?.hosted}
            onClick={() => {
              if (window.confirm(`Delete all ${status?.hosted ?? 0} hosted episode copies from the server?`)) remove.mutate();
            }}
          >
            {remove.isPending ? 'Deleting…' : 'Delete hosted copies'}
          </Button>
        </div>
        <ErrorNote error={remove.error} />
      </div>
    </Card>
  );
}

function PublicDirectory({ value, onChange }: { value: AdminSettings['publicDirectory']; onChange: (v: AdminSettings['publicDirectory']) => void }) {
  const row = (key: keyof AdminSettings['publicDirectory'], title: string, hint: string) => (
    <div className="flex items-center justify-between gap-6">
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-[13px] text-muted">{hint}</div>
      </div>
      <Switch label={title} checked={value[key]} onChange={(v) => onChange({ ...value, [key]: v })} />
    </div>
  );
  return (
    <Card title="Public directory">
      <div className="flex flex-col gap-4 px-5 py-4">
        {row('enabled', 'Show a public directory', 'Anyone can browse the podcasts people here follow, and open shared episode links, without signing in. The pages are view-only: following, saving and every other action asks for a sign-in. Private feeds are never shown.')}
        {value.enabled && (
          <>
            {row('listening', 'Allow public listening', "Visitors can play episodes. Audio streams straight from the podcast's own server, never from a copy hosted here.")}
            {row('transcripts', 'Allow public viewing of transcripts', 'Visitors can read the transcript of an episode that has one.')}
            {row('subscriberCounts', 'Show subscriber counts', 'Show how many people here follow each podcast, and allow sorting by it.')}
          </>
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
    mutationFn: ({ autoTranscribePending: _p, episodeMirrorStatus: _m, ...s }: AdminSettings) => patch<AdminSettings>('/admin/settings', s),
    onSuccess: (s) => {
      qc.setQueryData(['admin', 'settings'], s);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });
  const backup = useMutation({ mutationFn: () => post('/admin/backup'), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'overview'] }) });
  const norm = (f: AdminSettings | null | undefined) => JSON.stringify(f && { ...f, autoTranscribePending: 0, episodeMirrorStatus: null });
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
          <EpisodeHosting
            value={form.episodeMirror}
            status={q.data?.episodeMirrorStatus}
            savedEnabled={!!q.data?.episodeMirror.enabled}
            onChange={(episodeMirror) => setForm({ ...form, episodeMirror })}
            onDeleted={() => void qc.invalidateQueries({ queryKey: ['admin', 'settings'] })}
          />
          <PublicDirectory value={form.publicDirectory} onChange={(publicDirectory) => setForm({ ...form, publicDirectory })} />
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
