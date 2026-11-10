import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { SessionDto } from '@homecast/shared';
import { del, download, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useApp, useSyncStatus } from '../AppData';
import { Page, Toggle } from '../components/page';
import { ChevronRight } from '../components/picons';
import { SyncLabel } from '../components/Shell';
import { readDeviceSettings, writeDeviceSettings, type DeviceSettings } from '../lib/downloads';
import { relTime } from '../../lib/format';
import { speedText } from '../lib/format';
import { useSettings } from '../lib/hooks';
import { toast } from '../lib/ui';

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mt-6">
    <h2 className="m-0 mb-2 text-xs font-semibold tracking-[0.06em] text-p-muted uppercase">{title}</h2>
    <div className="divide-y divide-p-line rounded-[14px] bg-p-surface">{children}</div>
  </section>
);
const Row = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => <div className={`flex min-h-14 items-center justify-between gap-4 px-4 py-3 ${className}`}>{children}</div>;
const btn = 'h-9 rounded-full border border-p-line bg-transparent px-4 text-sm font-medium text-p-text disabled:opacity-50';

export function ProfilePage() {
  const { user, signOut } = useAuth();
  const { db, data, sync, downloads, player } = useApp();
  const nav = useNavigate();
  const settings = useSettings();
  const syncStatus = useSyncStatus();
  const [dev, setDev] = useState<DeviceSettings>(readDeviceSettings());
  const [sessions, setSessions] = useState<SessionDto[] | null>(null);
  const [pw, setPw] = useState({ cur: '', next: '' });
  const [pwErr, setPwErr] = useState<string | null>(null);
  const updateDev = (p: Partial<DeviceSettings>) => {
    const n = { ...dev, ...p };
    setDev(n);
    writeDeviceSettings(n);
  };
  useEffect(() => {
    get<{ sessions: SessionDto[] }>('/auth/sessions').then((r) => setSessions(r.sessions), () => setSessions(null));
  }, []);
  const run = (fn: () => Promise<unknown>, ok?: string) => async () => {
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(e instanceof TypeError ? 'You need a connection for that.' : e instanceof Error ? e.message : 'Something went wrong');
    }
  };
  return (
    <Page title="Profile">
      <Section title="Account">
        <Row><div><div className="text-[15px] font-medium">{user?.username}</div><div className="text-[13px] text-p-muted">{user?.role === 'admin' ? 'Administrator' : 'User'} · <SyncLabel /></div>{syncStatus.error && syncStatus.state !== 'idle' && <div className="mt-1 text-xs text-p-danger">Last sync error: {syncStatus.error}</div>}</div>
          <button className={btn} onClick={() => void sync.sync()}>Sync now</button></Row>
        {user?.role === 'admin' && <Row><span className="text-[15px]">Admin dashboard</span><Link to="/admin" className={`${btn} inline-flex items-center no-underline`}>Open</Link></Row>}
        <Link to="/bookmarks" className="flex min-h-14 items-center justify-between gap-4 px-4 py-3 text-[15px] text-p-text no-underline">Bookmarks<span className="text-p-muted"><ChevronRight /></span></Link>
        <Link to="/downloads" className="flex min-h-14 items-center justify-between gap-4 px-4 py-3 text-[15px] text-p-text no-underline">Downloads<span className="text-p-muted"><ChevronRight /></span></Link>
      </Section>

      <Section title="Playback">
        <Row>
          <div><div className="text-[15px] font-medium">Default speed</div><div className="text-[13px] text-p-muted">Used unless a podcast has its own override. Synced.</div></div>
          <div className="flex items-center gap-2">
            <button aria-label="Decrease default speed" className="h-9 w-9 rounded-lg border border-p-line bg-p-bg text-lg text-p-text" onClick={() => void data.setDefaultSpeed(Math.max(0.5, Math.round((settings.defaultSpeed - 0.1) * 10) / 10)).then(() => player.refreshSpeed())}>−</button>
            <span className="w-12 text-center font-display text-base font-bold text-p-accent" aria-live="polite">{speedText(settings.defaultSpeed)}</span>
            <button aria-label="Increase default speed" className="h-9 w-9 rounded-lg border border-p-line bg-p-bg text-lg text-p-text" onClick={() => void data.setDefaultSpeed(Math.min(3, Math.round((settings.defaultSpeed + 0.1) * 10) / 10)).then(() => player.refreshSpeed())}>+</button>
          </div>
        </Row>
      </Section>

      <Section title="This device">
        <Row>
          <div><div className="text-[15px] font-medium">Download on Wi-Fi only</div><div className="text-[13px] text-p-muted">Where the browser reports the connection type.</div></div>
          <Toggle label="Download on Wi-Fi only" checked={dev.wifiOnly} onChange={(v) => updateDev({ wifiOnly: v })} />
        </Row>
        <Row>
          <label htmlFor="cap" className="text-[15px] font-medium">Storage cap</label>
          <select id="cap" value={dev.storageCapMB} onChange={(e) => updateDev({ storageCapMB: Number(e.target.value) })} className="h-10 rounded-lg border border-p-line bg-p-bg px-3 text-sm text-p-text">
            <option value={0}>No cap</option>{[500, 1000, 2000, 5000].map((m) => (<option key={m} value={m}>{m >= 1000 ? `${m / 1000} GB` : `${m} MB`}</option>))}
          </select>
        </Row>
        <Row>
          <div><div className="text-[15px] font-medium">Delete all downloads</div><div className="text-[13px] text-p-muted">Frees space on this device only.</div></div>
          <button className={`${btn} !text-p-danger`} onClick={run(async () => { if (window.confirm('Delete every downloaded episode from this device?')) for (const d of await db.downloads.toArray()) await downloads.remove(d.episodeId); }, 'Downloads cleared')}>Delete</button>
        </Row>
      </Section>

      <Section title="Library">
        <Row><span className="text-[15px]">Export subscriptions (OPML)</span><button className={btn} onClick={run(() => download('/opml/export', 'homecast.opml'))}>Export</button></Row>
        <Row><div><div className="text-[15px]">Export all my data</div><div className="text-[13px] text-p-muted">Subscriptions, progress, bookmarks and playlists as JSON.</div></div><button className={btn} onClick={run(() => download('/me/export', 'homecast-export.json'))}>Export</button></Row>
      </Section>

      <Section title="Signed-in devices">
        {sessions === null && <Row><span className="text-sm text-p-muted">Connect to the server to see your devices.</span></Row>}
        {sessions?.map((s) => (
          <Row key={s.id}>
            <div className="min-w-0"><div className="truncate text-[15px] font-medium">{s.deviceName}{s.current && <span className="ml-2 text-xs font-normal text-p-accent">This device</span>}</div><div className="text-[13px] text-p-muted">Last active {relTime(s.lastUsedAt).toLowerCase()}</div></div>
            {!s.current && <button className={btn} onClick={run(async () => { await del(`/auth/sessions/${s.id}`); setSessions((l) => l?.filter((x) => x.id !== s.id) ?? null); }, 'Signed out that device')}>Sign out</button>}
          </Row>
        ))}
      </Section>

      <Section title="Password">
        <form className="flex flex-col gap-3 p-4" onSubmit={async (e) => { e.preventDefault(); setPwErr(null); try { await post('/auth/change-password', { currentPassword: pw.cur, newPassword: pw.next }); setPw({ cur: '', next: '' }); toast('Password changed. Other devices were signed out.'); } catch (er) { setPwErr(er instanceof Error ? er.message : 'Failed'); } }}>
          <input type="password" aria-label="Current password" placeholder="Current password" autoComplete="current-password" value={pw.cur} onChange={(e) => setPw({ ...pw, cur: e.target.value })} className="h-11 rounded-xl border border-p-line bg-p-bg px-3.5 text-[15px] text-p-text" />
          <input type="password" aria-label="New password" placeholder="New password (10+ characters)" minLength={10} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} className="h-11 rounded-xl border border-p-line bg-p-bg px-3.5 text-[15px] text-p-text" />
          {pwErr && <div role="alert" className="text-sm text-p-danger">{pwErr}</div>}
          <button type="submit" disabled={!pw.cur || pw.next.length < 10} className={`${btn} self-start`}>Change password</button>
        </form>
      </Section>

      <div className="mt-8 flex flex-wrap gap-3">
        <button className="h-11 rounded-full border-0 bg-p-accent px-6 text-[15px] font-semibold text-p-ink" onClick={async () => { await signOut(); nav('/login'); }}>Sign out</button>
        <button className="h-11 rounded-full border border-p-line bg-transparent px-5 text-[15px] text-p-danger" onClick={async () => { if (window.confirm('Remove all podcast data and downloads from this device? Your synced data stays on the server.')) { for (const d of await db.downloads.toArray()) await downloads.remove(d.episodeId); await signOut(); db.close(); await db.delete(); nav('/login'); } }}>Sign out and clear this device</button>
      </div>
    </Page>
  );
}
