import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { BackIcon, BrandMark, FeedsIcon, JobsIcon, MenuIcon, OverviewIcon, SettingsIcon, ShieldIcon, UsageIcon, UsersIcon } from './icons';
import { Button, cx } from './ui';

const NAV = [
  { to: '/admin', label: 'Overview', icon: OverviewIcon, end: true },
  { to: '/admin/users', label: 'Users & invites', icon: UsersIcon },
  { to: '/admin/feeds', label: 'Feeds', icon: FeedsIcon },
  { to: '/admin/jobs', label: 'Jobs', icon: JobsIcon },
  { to: '/admin/usage', label: 'Usage', icon: UsageIcon },
  { to: '/admin/audit', label: 'Audit log', icon: ShieldIcon },
  { to: '/admin/settings', label: 'Settings', icon: SettingsIcon },
];

const linkCls = (active: boolean) =>
  cx('flex h-10 items-center gap-3 rounded-[10px] px-3 text-sm no-underline', active ? 'bg-brand-soft font-semibold text-brand' : 'text-ink-2 hover:bg-page');

export function AdminLayout() {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-screen flex-col bg-page text-ink md:flex-row">
      <nav aria-label="Admin" className="sticky top-0 z-30 box-border flex w-full shrink-0 flex-col gap-0.5 border-b border-line bg-white px-4 py-3 md:h-screen md:w-60 md:overflow-y-auto md:border-r md:border-b-0 md:py-6">
        <div className="flex items-center gap-2.5 px-1 pb-0 md:px-3 md:pb-5">
          <BrandMark size={34} />
          <div>
            <div className="font-display text-base leading-[18px] font-bold tracking-[-0.02em]">Homecast</div>
            <div className="text-xs leading-4 text-muted">Admin</div>
          </div>
          <button type="button" aria-label="Toggle navigation" aria-expanded={open} onClick={() => setOpen(!open)} className="ml-auto flex h-11 w-11 items-center justify-center rounded-lg border-0 bg-transparent text-ink-2 md:hidden">
            <MenuIcon size={22} />
          </button>
        </div>
        <div className={cx('flex-col gap-0.5', open ? 'mt-3 flex' : 'hidden md:flex')}>
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} onClick={() => setOpen(false)} className={({ isActive }) => linkCls(isActive)}>
              <Icon />
              {label}
            </NavLink>
          ))}
        </div>
        <div className="hidden flex-1 md:block" />
        <div className={cx('mt-2 flex-col gap-0.5', open ? 'flex pb-1' : 'hidden md:flex')}>
          <NavLink to="/" className={linkCls(false)}>
            <BackIcon />
            Back to player
          </NavLink>
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-line-2 px-3 pt-3 text-[13px] text-muted">
            <span className="truncate" title={user?.username}>
              {user?.username}
            </span>
            <Button small onClick={() => void signOut().then(() => nav('/login'))}>
              Sign out
            </Button>
          </div>
        </div>
      </nav>
      <main className="box-border min-w-0 flex-1 px-4 py-6 md:px-10 md:py-8">
        <Outlet />
      </main>
    </div>
  );
}
