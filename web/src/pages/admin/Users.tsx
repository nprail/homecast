import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AdminInvite, AdminUser } from '@homecast/shared';
import { KebabIcon, PlusIcon } from '../../components/icons';
import { Badge, Button, Card, CardNote, CopyField, ErrorNote, Field, inputCls, Loading, Modal, PageHeader, Table, Th, Thead } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { relTime } from '../../lib/format';

type Action = 'reset' | 'revoke' | 'role' | 'disable' | 'delete';

function RowMenu({ user, lastAdmin, onAction }: { user: AdminUser; lastAdmin: boolean; onAction: (a: Action) => void }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = pos !== null;
  const close = useCallback(() => setPos(null), []);
  const protectedAdmin = lastAdmin && user.role === 'admin' && !user.disabled;
  const items: { action: Action; label: string; danger?: boolean; disabled?: boolean }[] = [
    { action: 'reset', label: 'Send password reset link' },
    { action: 'revoke', label: 'Revoke all sessions' },
    { action: 'role', label: user.role === 'admin' ? 'Make user' : 'Make admin', disabled: protectedAdmin && user.role === 'admin' },
    { action: 'disable', label: user.disabled ? 'Enable user' : 'Disable user', disabled: protectedAdmin },
    { action: 'delete', label: 'Delete user and data…', danger: true, disabled: protectedAdmin },
  ];

  // The menu is portalled to <body> with fixed positioning so table scroll containers can't clip it.
  const toggle = () => {
    if (open) return close();
    const r = btn.current!.getBoundingClientRect();
    const w = 220;
    const h = items.length * 40 + 14;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    const top = r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4;
    setPos({ top, left });
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (close(), btn.current?.focus());
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    // Close on page/table scroll, but not for scrolls caused by opening the menu itself.
    const armed = setTimeout(() => window.addEventListener('scroll', close, true), 150);
    menu.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      clearTimeout(armed);
      window.removeEventListener('scroll', close, true);
    };
  }, [open, close]);
  return (
    <div className="inline-block text-left">
      <button
        ref={btn}
        type="button"
        aria-label={`Actions for ${user.username}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className={`h-11 w-11 rounded-[10px] border-0 ${open ? 'bg-line text-ink' : 'bg-transparent text-muted hover:bg-page'}`}
      >
        <KebabIcon />
      </button>
      {open &&
        createPortal(
          <div ref={menu} role="menu" style={{ top: pos.top, left: pos.left }} className="fixed z-50 w-[220px] rounded-xl border border-line-input bg-white p-1.5 shadow-[0_8px_24px_rgba(20,23,28,0.12)]">
            {items.map((it) => (
              <button
                key={it.action}
                role="menuitem"
                type="button"
                disabled={it.disabled}
                title={it.disabled ? "The last remaining admin can't be demoted, disabled or deleted" : undefined}
                onClick={() => {
                  close();
                  onAction(it.action);
                }}
                className={`block h-10 w-full rounded-lg border-0 bg-transparent px-3 text-left text-sm hover:bg-page ${it.danger ? 'font-medium text-bad-fg' : 'text-ink'}`}
              >
                {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function UsersPage() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => get<{ users: AdminUser[] }>('/admin/users') });
  const invites = useQuery({ queryKey: ['admin', 'invites'], queryFn: () => get<{ invites: AdminInvite[] }>('/admin/invites') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [target, setTarget] = useState<{ user: AdminUser; action: Action } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<{ username: string; url: string; expiresAt: number } | null>(null);

  const mut = useMutation({
    mutationFn: async ({ user, action }: { user: AdminUser; action: Action }) => {
      switch (action) {
        case 'reset': {
          const r = await post<{ url: string; expiresAt: number }>(`/admin/users/${user.id}/reset-link`);
          setResetLink({ username: user.username, ...r });
          return;
        }
        case 'revoke': {
          const r = await post<{ revoked: number }>(`/admin/users/${user.id}/revoke-sessions`);
          setNotice(`Revoked ${r.revoked} session${r.revoked === 1 ? '' : 's'} for ${user.username}.`);
          return;
        }
        case 'role':
          await patch(`/admin/users/${user.id}`, { role: user.role === 'admin' ? 'user' : 'admin' });
          return;
        case 'disable':
          await patch(`/admin/users/${user.id}`, { disabled: !user.disabled });
          return;
        case 'delete':
          await del(`/admin/users/${user.id}`);
          setNotice(`Deleted ${user.username} and their data.`);
      }
    },
    onSuccess: refresh,
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/admin/invites/${id}`), onSuccess: refresh });

  const list = users.data?.users ?? [];
  const adminCount = list.filter((u) => u.role === 'admin' && !u.disabled).length;

  function onAction(user: AdminUser, action: Action) {
    setNotice(null);
    if (action === 'delete') setTarget({ user, action });
    else mut.mutate({ user, action });
  }

  return (
    <>
      <PageHeader
        title="Users & invites"
        subtitle="Registration is invite-only."
        actions={
          <Button variant="primary" onClick={() => setInviteOpen(true)}>
            <PlusIcon />
            Invite user
          </Button>
        }
      />
      {notice && <div role="status" className="mt-4 rounded-[10px] bg-ok-bg px-4 py-3 text-sm text-ok-fg">{notice}</div>}
      <ErrorNote error={mut.error ?? users.error ?? invites.error ?? revoke.error} className="mt-4" />

      <Card className="mt-6 overflow-visible" title="Users">
        {users.isLoading ? (
          <Loading />
        ) : (
          <>
            <Table stack>
              <Thead>
                <Th>User</Th>
                <Th>Role</Th>
                <Th>Last active</Th>
                <Th>Devices</Th>
                <Th>Podcasts</Th>
                <Th>Status</Th>
                <Th srOnly>Actions</Th>
              </Thead>
              <tbody>
                {list.map((u) => (
                  <tr key={u.id} className="border-t border-line-2 hover:bg-row-hover">
                    <td className="py-2 pr-2 pl-5 font-medium">
                      {u.username}
                      {u.id === me?.id && <span className="ml-2 text-xs font-normal text-muted">(you)</span>}
                      <span className="mt-0.5 block text-xs font-normal text-muted md:hidden">{u.devices} device{u.devices === 1 ? '' : 's'} · {u.podcasts} podcast{u.podcasts === 1 ? '' : 's'}</span>
                    </td>
                    <td data-label="Role" className="p-2">
                      <Badge tone={u.role === 'admin' ? 'brand' : 'neutral'}>{u.role === 'admin' ? 'Admin' : 'User'}</Badge>
                    </td>
                    <td data-label="Last active" className="p-2 whitespace-nowrap text-muted">{u.id === me?.id ? 'Just now' : relTime(u.lastActiveAt)}</td>
                    <td data-hide-mobile className="tnum p-2">{u.devices}</td>
                    <td data-hide-mobile className="tnum p-2">{u.podcasts}</td>
                    <td data-label="Status" className="p-2">
                      <Badge tone={u.disabled ? 'off' : 'ok'}>{u.disabled ? 'Disabled' : 'Active'}</Badge>
                    </td>
                    <td data-corner className="relative px-3 py-2 text-right">
                      <RowMenu user={u} lastAdmin={adminCount <= 1} onAction={(a) => onAction(u, a)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <CardNote>The last remaining admin can't be demoted, disabled or deleted.</CardNote>
          </>
        )}
      </Card>

      <Card className="mt-4" title="Invites">
        {invites.isLoading ? (
          <Loading />
        ) : (
          <Table stack>
            <Thead>
              <Th>Code</Th>
              <Th>Created by</Th>
              <Th>Expires</Th>
              <Th>Status</Th>
              <Th srOnly>Actions</Th>
            </Thead>
            <tbody>
              {invites.data?.invites.map((i) => (
                <tr key={i.id} className="border-t border-line-2">
                  <td className="py-2 pr-2 pl-5 font-mono text-[13px]">{i.codePrefix}</td>
                  <td data-label="Created by" className="p-2">{i.createdBy}</td>
                  <td data-label="Expires" className="p-2 text-muted">{i.status === 'used' ? `Used by ${i.usedBy}` : i.status === 'revoked' ? 'Revoked' : relTime(i.expiresAt)}</td>
                  <td data-label="Status" className="p-2">
                    <Badge tone={i.status === 'pending' ? 'warn' : i.status === 'used' ? 'ok' : 'off'}>{i.status[0]!.toUpperCase() + i.status.slice(1)}</Badge>
                  </td>
                  <td data-actions className="px-5 py-2 text-right">
                    {i.status === 'pending' && (
                      <Button small variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {!invites.data?.invites.length && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-muted">
                    No invites yet.
                  </td>
                </tr>
              )}
            </tbody>
          </Table>
        )}
      </Card>

      {inviteOpen && <InviteModal onClose={() => { setInviteOpen(false); void refresh(); }} />}
      {resetLink && (
        <Modal title={`Password reset link for ${resetLink.username}`} onClose={() => setResetLink(null)} footer={<Button variant="primary" onClick={() => setResetLink(null)}>Done</Button>}>
          <p className="mt-0 text-muted">Send this one-time link to {resetLink.username}. It works once and expires {relTime(resetLink.expiresAt).toLowerCase()}. Setting a new password signs them out everywhere. You won't be able to see this link again.</p>
          <CopyField label="Reset link" value={resetLink.url} />
        </Modal>
      )}
      {target && (
        <Modal
          title="Delete user and data?"
          onClose={() => setTarget(null)}
          footer={
            <>
              <Button onClick={() => setTarget(null)}>Cancel</Button>
              <Button variant="primary" className="!bg-bad-fg" disabled={mut.isPending} onClick={() => { mut.mutate(target, { onSettled: () => setTarget(null) }); }}>
                Delete {target.user.username}
              </Button>
            </>
          }
        >
          <p className="m-0">
            This permanently deletes <strong>{target.user.username}</strong>, their subscriptions, playback state, bookmarks, playlists, settings and usage history. Shared feeds and transcripts stay. This can't be undone.
          </p>
        </Modal>
      )}
    </>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState(7);
  const create = useMutation({ mutationFn: () => post<{ code: string; registerUrl: string; invite: AdminInvite }>('/admin/invites', { expiresInDays: days }) });
  const r = create.data;
  return (
    <Modal
      title="Invite user"
      onClose={onClose}
      footer={
        r ? (
          <Button variant="primary" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'Creating…' : 'Create invite'}</Button>
          </>
        )
      }
    >
      <ErrorNote error={create.error} className="mb-4" />
      {r ? (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-muted">Share this with the person you're inviting. The code is single-use and is only shown now.</p>
          <CopyField label="Invite code" value={r.code} />
          <CopyField label="Sign-up link" value={r.registerUrl} />
        </div>
      ) : (
        <Field label="Expires after" hint="Invite codes are single-use.">
          {(id) => (
            <select id={id} className={inputCls} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[1, 3, 7, 14, 30].map((d) => (
                <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>
              ))}
            </select>
          )}
        </Field>
      )}
    </Modal>
  );
}
