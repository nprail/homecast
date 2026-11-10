import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { evaluateSmartPlaylist, smartPlaylistDefinitionSchema, type SmartPlaylistDefinition, type SmartRule } from '@homecast/shared';
import { useApp } from '../AppData';
import { Art } from '../components/Art';
import { ChevronUpDown, Close, Plus } from '../components/picons';
import { Page } from '../components/page';
import { Sheet } from '../components/Sheet';
import { ago } from '../lib/format';
import { useGoBack, usePodcastMap, useStates, useSubscribedPodcasts } from '../lib/hooks';
import { buildEpisodeViews } from '../lib/views';
import { toast } from '../lib/ui';

type Rule = SmartRule;
const blank = (): SmartPlaylistDefinition => ({ name: '', match: 'all', rules: [{ field: 'status', op: 'is', value: 'unplayed' }], sort: { field: 'releasedAt', dir: 'desc' }, limit: 50, autoDownload: false });

const SORTS = [
  { key: 'releasedAt:desc', label: 'Newest first' }, { key: 'releasedAt:asc', label: 'Oldest first' },
  { key: 'duration:desc', label: 'Longest first' }, { key: 'duration:asc', label: 'Shortest first' },
  { key: 'title:asc', label: 'Title A to Z' }, { key: 'title:desc', label: 'Title Z to A' },
];
const LIMITS = [10, 25, 50, 100, 250];
const ADD_RULES: { label: string; make: () => Rule }[] = [
  { label: 'Podcast', make: () => ({ field: 'podcast', op: 'in', value: [] }) },
  { label: 'Status', make: () => ({ field: 'status', op: 'is', value: 'unplayed' }) },
  { label: 'Released within', make: () => ({ field: 'releasedWithin', op: 'days', value: 7 }) },
  { label: 'Duration', make: () => ({ field: 'duration', op: 'lt', value: 30 }) },
  { label: 'Downloaded', make: () => ({ field: 'downloaded', op: 'is', value: true }) },
  { label: 'Starred', make: () => ({ field: 'starred', op: 'is', value: true }) },
  { label: 'Title contains', make: () => ({ field: 'title', op: 'contains', value: '' }) },
];

const card = 'rounded-[14px] bg-p-surface p-3.5';
const selectCls = 'h-11 w-full appearance-none rounded-xl border border-p-line bg-p-bg px-3.5 text-[15px] text-p-text';

function Select({ label, value, onChange, children, bg }: { label: string; value: string | number; onChange: (v: string) => void; children: React.ReactNode; bg?: string }) {
  return (
    <div className="relative">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={`${selectCls} ${bg ?? ''}`}>{children}</select>
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-p-muted"><ChevronUpDown size={16} /></span>
    </div>
  );
}

function Stepper({ value, onChange, unit, min = 1, max = 36500, step = 1, label }: { value: number; onChange: (n: number) => void; unit: string; min?: number; max?: number; step?: number; label: string }) {
  return (
    <div className="mt-2.5 flex items-center gap-3">
      <button aria-label={`Decrease ${label}`} onClick={() => onChange(Math.max(min, value - step))} className="h-11 w-11 rounded-xl border border-p-line bg-p-bg text-xl text-p-text">−</button>
      <div className="min-w-20 text-center text-[17px] font-semibold tnum">{value} {unit}{value === 1 ? '' : 's'}</div>
      <button aria-label={`Increase ${label}`} onClick={() => onChange(Math.min(max, value + step))} className="h-11 w-11 rounded-xl border border-p-line bg-p-bg text-xl text-p-text">+</button>
    </div>
  );
}

function RuleCard({ rule, onChange, onRemove }: { rule: Rule; onChange: (r: Rule) => void; onRemove: () => void }) {
  const pods = useSubscribedPodcasts() ?? [];
  const [picking, setPicking] = useState(false);
  const head = (title: React.ReactNode, rest?: React.ReactNode) => (
    <div className="flex h-6 items-center justify-between">
      <div className="text-sm text-p-muted"><span className="font-semibold text-p-text">{title}</span>{rest}</div>
      <button aria-label="Remove rule" onClick={onRemove} className="-my-2.5 -mr-2.5 flex h-11 w-11 items-center justify-center border-0 bg-transparent text-p-muted"><Close size={20} /></button>
    </div>
  );
  switch (rule.field) {
    case 'podcast':
      return (
        <div className={card}>
          {head('Podcast', <> is <button onClick={() => onChange({ ...rule, op: rule.op === 'in' ? 'notIn' : 'in' })} className="border-0 bg-transparent p-0 text-sm text-p-accent underline">{rule.op === 'in' ? 'any of' : 'none of'}</button></>)}
          <div className="mt-2.5 flex flex-wrap gap-2">
            {rule.value.map((pid) => (
              <span key={pid} className="inline-flex h-9 items-center gap-2 rounded-full bg-p-accent-soft pr-1.5 pl-3 text-sm">
                {pods.find((p) => p.id === pid)?.title ?? 'Unknown podcast'}
                <button aria-label="Remove podcast" onClick={() => onChange({ ...rule, value: rule.value.filter((v) => v !== pid) })} className="flex h-6 w-6 items-center justify-center border-0 bg-transparent text-p-muted"><Close size={14} /></button>
              </span>
            ))}
            <button onClick={() => setPicking(true)} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-dashed border-p-grip bg-transparent px-3 text-sm font-medium text-p-accent"><Plus size={16} />Add podcast</button>
          </div>
          {picking && (
            <Sheet title="Add podcast" onClose={() => setPicking(false)} z={80}>
              <div className="mt-3 flex flex-col">
                {pods.filter((p) => !rule.value.includes(p.id)).map((p) => (
                  <button key={p.id} onClick={() => { onChange({ ...rule, value: [...rule.value, p.id] }); setPicking(false); }} className="flex h-14 items-center gap-3 border-0 border-b border-p-line bg-transparent text-left text-p-text"><Art podcast={p} size={36} radius={8} /><span className="truncate text-[15px]">{p.title}</span></button>
                ))}
                {!pods.length && <p className="text-sm text-p-muted">Subscribe to a podcast first.</p>}
              </div>
            </Sheet>
          )}
        </div>
      );
    case 'status':
      return (
        <div className={card}>
          {head('Status', ' is')}
          <div className="mt-2.5"><Select label="Status" value={rule.value} onChange={(v) => onChange({ ...rule, value: v as typeof rule.value })}><option value="unplayed">Unplayed</option><option value="inProgress">In progress</option><option value="played">Played</option></Select></div>
        </div>
      );
    case 'releasedWithin':
      return (<div className={card}>{head('Released within')}<Stepper label="days" value={rule.value} unit="day" onChange={(value) => onChange({ ...rule, value })} /></div>);
    case 'duration':
      return (
        <div className={card}>
          {head('Duration', ' is')}
          <div className="mt-2.5"><Select label="Duration comparison" value={rule.op} onChange={(v) => onChange({ ...rule, op: v as 'lt' | 'gt' })}><option value="lt">Shorter than</option><option value="gt">Longer than</option></Select></div>
          <Stepper label="minutes" value={rule.value} unit="minute" step={5} min={1} max={1000} onChange={(value) => onChange({ ...rule, value })} />
        </div>
      );
    case 'downloaded':
    case 'starred':
      return (
        <div className={card}>
          {head(rule.field === 'downloaded' ? 'Downloaded' : 'Starred', ' is')}
          <div className="mt-2.5"><Select label={rule.field} value={String(rule.value)} onChange={(v) => onChange({ ...rule, value: v === 'true' })}><option value="true">Yes</option><option value="false">No</option></Select></div>
        </div>
      );
    case 'title':
      return (
        <div className={card}>
          {head('Title', ' contains')}
          <input aria-label="Title contains" value={rule.value} maxLength={200} onChange={(e) => onChange({ ...rule, value: e.target.value })} className="mt-2.5 h-11 w-full rounded-xl border border-p-line bg-p-bg px-3.5 text-[15px] text-p-text" />
        </div>
      );
  }
}

export function SmartEditorPage() {
  const { id } = useParams();
  const { db, data } = useApp();
  const nav = useNavigate();
  const goBack = useGoBack('/queue?tab=smart');
  const existing = useLiveQuery(() => (id ? db.smartPlaylists.get(id) : undefined), [db, id]);
  const [def, setDef] = useState<SmartPlaylistDefinition>(blank());
  const [loaded, setLoaded] = useState(!id);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const states = useStates();
  const pods = usePodcastMap();
  useEffect(() => {
    if (id && existing && !loaded) {
      setDef(existing.definition);
      setLoaded(true);
    }
  }, [id, existing, loaded]);

  const preview = useLiveQuery(async () => {
    const parsed = smartPlaylistDefinitionSchema.safeParse({ ...def, name: def.name || 'x' });
    if (!parsed.success) return null;
    const ids = evaluateSmartPlaylist(parsed.data, await buildEpisodeViews(db), Date.now());
    const eps = await db.episodes.bulkGet(ids.slice(0, 5));
    return { total: ids.length, eps: eps.filter((e) => !!e) };
  }, [db, def, states]);

  const save = async () => {
    const parsed = smartPlaylistDefinitionSchema.safeParse(def);
    if (!parsed.success) return setErr(def.name.trim() ? (parsed.error.issues[0]?.message ?? 'Invalid rules') : 'Give the playlist a name');
    const rid = await data.saveSmartPlaylist(id ?? null, { ...parsed.data, name: parsed.data.name.trim() });
    toast('Smart playlist saved');
    nav(`/smart/${rid}`, { replace: true });
  };
  const set = (patch: Partial<SmartPlaylistDefinition>) => setDef((d) => ({ ...d, ...patch }));
  const setRule = (i: number, r: Rule) => set({ rules: def.rules.map((x, j) => (j === i ? r : x)) });
  if (id && !loaded) return <Page><p className="text-p-muted">Loading…</p></Page>;
  return (
    <Page>
      <div className="flex h-12 items-center justify-between">
        <button onClick={goBack} className="-ml-2 h-11 border-0 bg-transparent px-2 text-base text-p-muted">Cancel</button>
        <h1 className="m-0 font-display text-lg font-semibold">Smart playlist</h1>
        <button onClick={() => void save()} className="-mr-2 h-11 border-0 bg-transparent px-2 text-base font-semibold text-p-accent">Save</button>
      </div>
      {err && <div role="alert" className="mt-2 text-sm text-p-danger">{err}</div>}

      <label htmlFor="sp-name" className="mt-4 block text-[13px] font-medium text-p-muted">Name</label>
      <input id="sp-name" value={def.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} placeholder="Fresh news" className="mt-1.5 box-border h-12 w-full rounded-xl border border-p-line bg-p-surface px-3.5 text-[17px] font-medium text-p-text" />

      <div className="mt-5 flex items-center gap-3">
        <span className="text-[15px] font-medium">Include episodes that match</span>
        <div role="group" aria-label="Match mode" className="flex h-9 rounded-[10px] bg-p-surface p-[3px]">
          {(['all', 'any'] as const).map((m) => (<button key={m} aria-pressed={def.match === m} onClick={() => set({ match: m })} className={`w-14 rounded-lg border-0 text-sm ${def.match === m ? 'bg-p-line font-semibold text-p-text' : 'bg-transparent font-medium text-p-muted'}`}>{m === 'all' ? 'All' : 'Any'}</button>))}
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2.5">
        {def.rules.map((r, i) => (<RuleCard key={i} rule={r} onChange={(n) => setRule(i, n)} onRemove={() => set({ rules: def.rules.filter((_, j) => j !== i) })} />))}
      </div>
      <button onClick={() => setAdding(true)} className="mt-2.5 flex h-12 w-full items-center justify-center gap-2 rounded-[14px] border border-dashed border-p-grip bg-transparent text-[15px] font-medium text-p-accent"><Plus size={18} />Add rule</button>
      {adding && (
        <Sheet title="Add rule" onClose={() => setAdding(false)}>
          <div className="mt-3 flex flex-col">{ADD_RULES.map((r) => (<button key={r.label} onClick={() => { set({ rules: [...def.rules, r.make()] }); setAdding(false); }} className="h-12 border-0 border-b border-p-line bg-transparent text-left text-[15px] text-p-text">{r.label}</button>))}</div>
        </Sheet>
      )}

      <div className="mt-5 flex gap-2.5">
        <div className="flex-1">
          <div className="text-[13px] font-medium text-p-muted">Sort by</div>
          <div className="mt-1.5"><Select label="Sort by" value={`${def.sort.field}:${def.sort.dir}`} bg="!bg-p-surface" onChange={(v) => { const [field, dir] = v.split(':') as [SmartPlaylistDefinition['sort']['field'], 'asc' | 'desc']; set({ sort: { field, dir } }); }}>{SORTS.map((s) => (<option key={s.key} value={s.key}>{s.label}</option>))}</Select></div>
        </div>
        <div className="w-[110px]">
          <div className="text-[13px] font-medium text-p-muted">Limit</div>
          <div className="mt-1.5"><Select label="Limit" value={def.limit ?? 50} bg="!bg-p-surface" onChange={(v) => set({ limit: Number(v) })}>{LIMITS.map((l) => (<option key={l} value={l}>{l}</option>))}</Select></div>
        </div>
      </div>

      <div className="mt-4 flex min-h-12 items-center justify-between gap-4">
        <div><div className="text-[15px] font-medium">Auto-download results</div><div className="text-[13px] text-p-muted">Keeps matching episodes available offline</div></div>
        <button role="switch" aria-checked={!!def.autoDownload} aria-label="Auto-download results" onClick={() => set({ autoDownload: !def.autoDownload })} className={`flex h-8 w-[52px] shrink-0 items-center rounded-2xl border-0 p-[3px] ${def.autoDownload ? 'justify-end bg-p-accent' : 'justify-start bg-p-grip'}`}><span className={`h-[26px] w-[26px] rounded-full ${def.autoDownload ? 'bg-p-ink' : 'bg-p-text'}`} /></button>
      </div>

      <div className="mt-4 border-t border-p-line pt-4">
        <div className="flex items-baseline justify-between">
          <div className="font-display text-lg font-semibold" aria-live="polite">{preview ? `${preview.total} episode${preview.total === 1 ? '' : 's'} match` : 'Checking…'}</div>
          <div className="text-[13px] text-p-muted">Works offline</div>
        </div>
        <div className="mt-2.5 flex flex-col gap-2">
          {preview?.eps.map((e) => (
            <div key={e!.id} className="flex h-[52px] items-center gap-3">
              <Art podcast={pods.get(e!.podcastId)} size={40} radius={8} />
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{e!.title}</div><div className="text-xs text-p-muted">{pods.get(e!.podcastId)?.title} · {ago(e!.releasedAt)}</div></div>
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}
