import type { ReactNode } from 'react';
import type { AuditEntry } from '@homecast/shared';
import { fmtBytes } from './format';

const mono = (s: string) => <span className="font-mono text-[13px]">{s}</span>;

export interface AuditView {
  text: ReactNode;
  /** Secondary text shown with the timestamp (e.g. lockout info). */
  note?: string;
  tone?: 'warn';
}

/** Turns a raw audit entry into the sentence shown in the dashboard. */
export function describeAudit(e: AuditEntry): AuditView {
  const who = e.actorName ?? 'Someone';
  const target = e.targetLabel ?? e.target ?? '';
  switch (e.action) {
    case 'invite.create': return { text: <>{who} created invite {mono(target)}</> };
    case 'invite.revoke': return { text: <>{who} revoked invite {mono(target)}</> };
    case 'login.success': return { text: <>{who} signed in{e.detail ? ` from ${e.detail}` : ''}</> };
    case 'login.failed':
      return { tone: 'warn', text: <>Failed sign-in for “{e.actorName ?? 'unknown'}”{e.ip ? ` from ${e.ip}` : ''}</>, note: e.detail ?? undefined };
    case 'logout': return { text: <>{who} signed out</> };
    case 'register': return { text: <>{who} joined with an invite</> };
    case 'register.admin': return { text: <>{who} created the admin account</> };
    case 'password.reset': return { text: <>{who} reset their password</> };
    case 'password.changed': return { text: <>{who} changed their password</> };
    case 'session.reuse_detected': return { tone: 'warn', text: <>Refresh token reuse detected for {who}; session revoked</> };
    case 'job.done': return { text: <>Transcript finished: {target}</> };
    case 'job.failed': return { tone: 'warn', text: <>Transcript failed: {target}</>, note: e.detail ?? undefined };
    case 'job.retry': return { text: <>{who} retried the transcript for {target}</> };
    case 'job.cancel': return { text: <>{who} cancelled the transcript for {target}</> };
    case 'backup.completed': return { text: <>Backup completed{e.detail && Number(e.detail) ? ` (${fmtBytes(Number(e.detail), 0)})` : ''}</> };
    case 'user.promote': return { text: <>{who} made {target} an admin</> };
    case 'user.demote': return { text: <>{who} made {target} a regular user</> };
    case 'user.disable': return { text: <>{who} disabled {target}</> };
    case 'user.enable': return { text: <>{who} enabled {target}</> };
    case 'user.delete': return { text: <>{who} deleted user {target}</> };
    case 'user.reset_link': return { text: <>{who} issued a password reset link for {target}</> };
    case 'user.revoke_sessions': return { text: <>{who} revoked all sessions for {target}</>, note: e.detail ?? undefined };
    case 'feed.refresh': return { text: <>{who} refreshed {target}</>, note: e.detail ?? undefined };
    case 'feed.hide': return { text: <>{who} hid {target} from Discover</> };
    case 'feed.unhide': return { text: <>{who} listed {target} in Discover</> };
    case 'feeds.prune': return { text: <>{who} removed orphaned feeds</>, note: e.detail ?? undefined };
    case 'settings.update': return { text: <>{who} changed server settings</>, note: e.detail ?? undefined };
    case 'podcast.add': return { text: <>{who} added {target}</> };
    case 'opml.import': return { text: <>{who} imported OPML</>, note: e.detail ?? undefined };
    default: return { text: <>{who}: {e.action}{target ? ` ${target}` : ''}</> };
  }
}
