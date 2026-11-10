import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createInviteBody, patchFeedBody, patchSettingsBody, patchUserBody,
  type AdminFeed, type AdminInvite, type AdminJob, type AdminJobs, type AdminOverview, type AdminUsage, type AdminUser,
  type AuditEntry, type UsageDay, type UsageUser,
} from '@homecast/shared';
import type { Ctx } from '../context.js';
import type { Invite, Podcast, User } from '../db/types.js';
import { makeAuth, userOf } from '../plugins/auth.js';
import { redactFeedUrl } from '../services/feedParser.js';
import { conflict, notFound } from '../util/errors.js';
import { clean, dayKey, now, randomToken, sha256 } from '../util/misc.js';
import { body, query } from '../util/validate.js';
import { SYSTEM_USER } from '../services/transcripts.js';
import { newInviteCode } from './auth.js';

const DAY = 86_400_000;

export function adminRoutes(ctx: Ctx) {
  const { requireAdmin } = makeAuth(ctx);
  const { db } = ctx;

  const startOfToday = (): number => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const nameOf = (id: string | null): string => (id === SYSTEM_USER ? 'Auto-transcribe' : id ? (db.users.get(id)?.username ?? 'Deleted user') : 'System');

  // ---- DTO builders ---------------------------------------------------------------------------
  const feedDto = (p: Podcast): AdminFeed => {
    let status: AdminFeed['status'] = 'ok';
    let statusLabel = 'OK';
    if (p.fetchError) {
      status = 'error';
      statusLabel = p.fetchError;
    } else if (!p.lastFetchedAt) {
      status = 'pending';
      statusLabel = 'Pending';
    } else if ((p.lastFetchMs ?? 0) > 5000) {
      status = 'slow';
      statusLabel = `Slow (${((p.lastFetchMs ?? 0) / 1000).toFixed(1)} s)`;
    }
    return {
      id: p.id, title: p.title, feedUrl: redactFeedUrl(p.feedUrl, p.isPrivate), isPrivate: p.isPrivate, hiddenFromDiscover: p.hiddenFromDiscover,
      subscribers: ctx.feeds.subscriberCount(p.id), lastFetchedAt: p.lastFetchedAt, lastFetchMs: p.lastFetchMs, fetchError: p.fetchError,
      status, statusLabel, episodeCount: db.episodes.count({ podcastId: p.id }),
    };
  };

  const userDto = (u: User): AdminUser => ({
    id: u.id, username: u.username, role: u.role, disabled: u.disabled, createdAt: u.createdAt, lastActiveAt: u.lastActiveAt,
    devices: ctx.sessions.activeCount(u.id), podcasts: db.subscriptions.find({ userId: u.id }).filter((s) => !s.deleted).length,
  });

  const inviteDto = (i: Invite): AdminInvite => ({
    id: i.id, codePrefix: i.codePrefix, createdBy: nameOf(i.createdBy), createdAt: i.createdAt, expiresAt: i.expiresAt,
    status: i.usedBy ? 'used' : i.revokedAt ? 'revoked' : i.expiresAt < now() ? 'expired' : 'pending', usedBy: i.usedBy ? nameOf(i.usedBy) : null,
  });

  const jobDto = (j: ReturnType<typeof db.jobs.get> & object): AdminJob => {
    const ep = db.episodes.get(j.episodeId);
    return {
      id: j.id, episodeId: j.episodeId, episodeTitle: ep?.title ?? 'Deleted episode', podcastTitle: db.podcasts.get(j.podcastId)?.title ?? '',
      requestedBy: nameOf(j.requestedBy), status: j.status, stage: j.stage, progress: j.progress, queuePosition: ctx.transcripts.queuePosition(j),
      audioSeconds: j.audioSeconds, source: j.source, error: j.error, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, durationMs: j.durationMs,
    };
  };

  const auditDto = (e: ReturnType<typeof db.auditLog.get> & object): AuditEntry => clean(e) as AuditEntry;

  const activeAdmins = () => db.users.find().filter((u) => u.role === 'admin' && !u.disabled);
  const guardLastAdmin = (u: User) => {
    if (u.role === 'admin' && !u.disabled && activeAdmins().length <= 1) throw conflict("The last remaining admin can't be demoted, disabled or deleted");
  };

  function buildUsage(days: number): AdminUsage {
    ctx.usage.flush();
    const today = new Date(`${dayKey(now())}T00:00:00Z`).getTime();
    const dayKeys = Array.from({ length: days }, (_, i) => dayKey(today - (days - 1 - i) * DAY));
    const from = dayKeys[0]!;
    const daily = new Map<string, UsageDay>(dayKeys.map((day) => [day, { day, proxyBytes: 0, feedBytes: 0, transcribeBytes: 0, transcriptMinutes: 0 }]));
    const byUser = new Map<string, UsageUser>();
    for (const r of db.usageStats.where((x) => x.day >= from)) {
      const d = daily.get(r.day);
      if (!d) continue;
      d.proxyBytes += r.proxyBytes; d.feedBytes += r.feedBytes; d.transcribeBytes += r.transcribeBytes; d.transcriptMinutes += r.transcriptMinutes;
      const u = byUser.get(r.userId) ?? { userId: r.userId, username: nameOf(r.userId), proxyBytes: 0, feedBytes: 0, transcribeBytes: 0, transcriptMinutes: 0 };
      u.proxyBytes += r.proxyBytes; u.feedBytes += r.feedBytes; u.transcribeBytes += r.transcribeBytes; u.transcriptMinutes += r.transcriptMinutes;
      byUser.set(r.userId, u);
    }
    const list = [...daily.values()];
    const totals = list.reduce((a, d) => ({ proxyBytes: a.proxyBytes + d.proxyBytes, feedBytes: a.feedBytes + d.feedBytes, transcribeBytes: a.transcribeBytes + d.transcribeBytes, transcriptMinutes: a.transcriptMinutes + d.transcriptMinutes }), { proxyBytes: 0, feedBytes: 0, transcribeBytes: 0, transcriptMinutes: 0 });
    const total = (u: UsageUser) => u.proxyBytes + u.feedBytes + u.transcribeBytes;
    return {
      days, from, to: dayKeys[dayKeys.length - 1]!,
      feedCount: db.podcasts.where((p) => !p.deleted && ctx.feeds.subscriberCount(p.id) > 0).length,
      pollIntervalMinutes: ctx.settings.get().pollIntervalMinutes, whisperModel: ctx.settings.get().whisperModel,
      totals, daily: list, byUser: [...byUser.values()].sort((a, b) => total(b) - total(a)),
    };
  }

  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requireAdmin);

    // ---- overview -----------------------------------------------------------------------------
    app.get('/admin/overview', async (): Promise<AdminOverview> => {
      const t = now();
      const feeds = db.podcasts.where((p) => !p.deleted);
      const withCount = feeds.map((p) => ({ p, n: ctx.feeds.subscriberCount(p.id) }));
      const info = ctx.backup.info();
      return {
        version: ctx.config.version,
        uptimeSec: Math.round((t - ctx.startedAt) / 1000),
        users: { total: db.users.count(), activeToday: db.users.where((u) => (u.lastActiveAt ?? 0) >= startOfToday()).length },
        podcasts: { total: feeds.length, withErrors: feeds.filter((p) => p.fetchError).length },
        episodes: { total: db.episodes.count(), last24h: db.episodes.where((e) => e.createdAt > t - DAY).length },
        database: { bytes: db.fileSize(), diskFreeBytes: ctx.backup.diskFreeBytes() },
        backup: info,
        feedHealth: withCount.sort((a, b) => b.n - a.n || a.p.title.localeCompare(b.p.title)).slice(0, 5).map((x) => feedDto(x.p)),
        recentActivity: db.auditLog.find().sort((a, b) => b.at - a.at).slice(0, 6).map(auditDto),
      };
    });

    app.post('/admin/backup', async (req) => {
      const r = ctx.backup.run(userOf(req).id);
      return { ...ctx.backup.info(), bytes: r.bytes };
    });

    // ---- users --------------------------------------------------------------------------------
    app.get('/admin/users', async () => ({ users: db.users.find().sort((a, b) => a.createdAt - b.createdAt).map(userDto) }));

    app.patch<{ Params: { id: string } }>('/admin/users/:id', async (req) => {
      const actor = userOf(req);
      const u = db.users.get(req.params.id);
      if (!u) throw notFound('User not found');
      const b = body(req, patchUserBody);
      if ((b.role === 'user' && u.role === 'admin') || b.disabled === true) guardLastAdmin(u);
      if (b.role && b.role !== u.role) {
        u.role = b.role;
        ctx.audit.log({ actorId: actor.id, action: b.role === 'admin' ? 'user.promote' : 'user.demote', target: u.id, targetLabel: u.username, ip: req.ip });
      }
      if (b.disabled !== undefined && b.disabled !== u.disabled) {
        u.disabled = b.disabled;
        if (b.disabled) ctx.sessions.revokeAllForUser(u.id);
        ctx.audit.log({ actorId: actor.id, action: b.disabled ? 'user.disable' : 'user.enable', target: u.id, targetLabel: u.username, ip: req.ip });
      }
      db.users.saveQuiet(u as never);
      return { user: userDto(u) };
    });

    app.post<{ Params: { id: string } }>('/admin/users/:id/revoke-sessions', async (req) => {
      const u = db.users.get(req.params.id);
      if (!u) throw notFound('User not found');
      const n = ctx.sessions.revokeAllForUser(u.id);
      ctx.audit.log({ actorId: userOf(req).id, action: 'user.revoke_sessions', target: u.id, targetLabel: u.username, ip: req.ip, detail: `${n} sessions` });
      return { revoked: n };
    });

    app.post<{ Params: { id: string } }>('/admin/users/:id/reset-link', async (req) => {
      const u = db.users.get(req.params.id);
      if (!u) throw notFound('User not found');
      db.resetTokens.removeWhere((r) => r.userId === u.id && !r.usedAt);
      const token = randomToken(32);
      const expiresAt = now() + DAY;
      db.resetTokens.insert({ userId: u.id, tokenHash: sha256(token), expiresAt, usedAt: null });
      ctx.audit.log({ actorId: userOf(req).id, action: 'user.reset_link', target: u.id, targetLabel: u.username, ip: req.ip });
      return { url: `${ctx.config.publicUrl}/reset-password?token=${token}`, expiresAt };
    });

    app.delete<{ Params: { id: string } }>('/admin/users/:id', async (req, reply) => {
      const u = db.users.get(req.params.id);
      if (!u) throw notFound('User not found');
      guardLastAdmin(u);
      const id = u.id;
      ctx.sessions.revokeAllForUser(id);
      for (const repo of [db.refreshTokens, db.resetTokens, db.subscriptions, db.episodeStates, db.bookmarks, db.playlists, db.smartPlaylists, db.userSettings, db.usageStats] as const) {
        (repo as unknown as { removeWhere: (fn: (d: { userId: string }) => boolean) => number }).removeWhere((d) => d.userId === id);
      }
      db.users.remove(u);
      ctx.audit.log({ actorId: userOf(req).id, action: 'user.delete', target: id, targetLabel: u.username, ip: req.ip });
      return reply.code(204).send();
    });

    // ---- invites ------------------------------------------------------------------------------
    app.get('/admin/invites', async () => ({ invites: db.invites.find().sort((a, b) => b.createdAt - a.createdAt).map(inviteDto) }));

    app.post('/admin/invites', async (req, reply) => {
      const b = body(req, createInviteBody);
      const code = newInviteCode();
      const invite = db.invites.insert({
        codeHash: sha256(code), codePrefix: `${code.slice(0, 7)}…`, createdBy: userOf(req).id, createdAt: now(),
        expiresAt: now() + b.expiresInDays * DAY, usedBy: null, usedAt: null, revokedAt: null,
      });
      ctx.audit.log({ actorId: userOf(req).id, action: 'invite.create', target: invite.id, targetLabel: invite.codePrefix, ip: req.ip });
      // The plaintext code is shown exactly once.
      return reply.code(201).send({ invite: inviteDto(invite), code, registerUrl: `${ctx.config.publicUrl}/register?code=${code}` });
    });

    app.delete<{ Params: { id: string } }>('/admin/invites/:id', async (req, reply) => {
      const i = db.invites.get(req.params.id);
      if (!i) throw notFound('Invite not found');
      if (!i.usedBy && !i.revokedAt) {
        i.revokedAt = now();
        db.invites.saveQuiet(i);
        ctx.audit.log({ actorId: userOf(req).id, action: 'invite.revoke', target: i.id, targetLabel: i.codePrefix, ip: req.ip });
      }
      return reply.code(204).send();
    });

    // ---- feeds --------------------------------------------------------------------------------
    app.get('/admin/feeds', async (req) => {
      const q = query(req, z.object({ q: z.string().max(100).optional(), status: z.enum(['all', 'errors']).default('all'), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }));
      const needle = q.q?.toLowerCase();
      let list = db.podcasts.where((p) => !p.deleted).map(feedDto);
      if (needle) list = list.filter((f) => f.title.toLowerCase().includes(needle));
      if (q.status === 'errors') list = list.filter((f) => f.status === 'error');
      list.sort((a, b) => b.subscribers - a.subscribers || a.title.localeCompare(b.title));
      return { total: list.length, orphans: list.filter((f) => f.subscribers === 0).length, feeds: list.slice(q.offset, q.offset + q.limit) };
    });

    app.post<{ Params: { id: string } }>('/admin/feeds/:id/refresh', async (req) => {
      const p = db.podcasts.get(req.params.id);
      if (!p || p.deleted) throw notFound('Feed not found');
      const result = await ctx.feeds.refresh(p, { force: true });
      ctx.audit.log({ actorId: userOf(req).id, action: 'feed.refresh', target: p.id, targetLabel: p.title, ip: req.ip, detail: result.ok ? `${result.newEpisodes} new episodes` : result.error });
      return { result, feed: feedDto(p) };
    });

    app.patch<{ Params: { id: string } }>('/admin/feeds/:id', async (req) => {
      const p = db.podcasts.get(req.params.id);
      if (!p || p.deleted) throw notFound('Feed not found');
      const b = body(req, patchFeedBody);
      p.hiddenFromDiscover = b.hiddenFromDiscover;
      db.podcasts.save(p);
      ctx.audit.log({ actorId: userOf(req).id, action: b.hiddenFromDiscover ? 'feed.hide' : 'feed.unhide', target: p.id, targetLabel: p.title, ip: req.ip });
      return { feed: feedDto(p) };
    });

    app.delete('/admin/feeds/orphans', async (req) => {
      const removed = ctx.feeds.removeOrphans();
      ctx.audit.log({ actorId: userOf(req).id, action: 'feeds.prune', ip: req.ip, detail: `${removed} removed` });
      return { removed };
    });

    // ---- jobs ---------------------------------------------------------------------------------
    app.get('/admin/jobs', async (): Promise<AdminJobs> => {
      const t = now();
      const all = db.jobs.find();
      const order = { running: 0, queued: 1, failed: 2, done: 3, cancelled: 4 } as const;
      const jobs = all
        .sort((a, b) => order[a.status] - order[b.status] || (a.status === 'queued' ? a.createdAt - b.createdAt : (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt)))
        .slice(0, 100)
        .map(jobDto);
      return {
        model: ctx.settings.get().whisperModel, concurrency: 1,
        counts: {
          running: all.filter((j) => j.status === 'running').length, queued: all.filter((j) => j.status === 'queued').length,
          doneLast24h: all.filter((j) => j.status === 'done' && (j.finishedAt ?? 0) > t - DAY).length,
          failedLast24h: all.filter((j) => j.status === 'failed' && (j.finishedAt ?? 0) > t - DAY).length,
        },
        jobs,
      };
    });

    app.post<{ Params: { id: string } }>('/admin/jobs/:id/retry', async (req) => {
      const j = ctx.transcripts.retry(req.params.id);
      ctx.audit.log({ actorId: userOf(req).id, action: 'job.retry', target: j.id, targetLabel: db.episodes.get(j.episodeId)?.title ?? null, ip: req.ip });
      return { job: jobDto(j) };
    });
    app.post<{ Params: { id: string } }>('/admin/jobs/:id/cancel', async (req) => {
      const j = ctx.transcripts.cancel(req.params.id);
      ctx.audit.log({ actorId: userOf(req).id, action: 'job.cancel', target: j.id, targetLabel: db.episodes.get(j.episodeId)?.title ?? null, ip: req.ip });
      return { job: jobDto(j) };
    });

    // ---- usage --------------------------------------------------------------------------------
    app.get('/admin/usage', async (req, reply) => {
      const q = query(req, z.object({ days: z.coerce.number().int().min(1).max(365).default(30), format: z.enum(['json', 'csv']).default('json') }));
      if (q.format === 'csv') {
        ctx.usage.flush();
        const from = dayKey(now() - (q.days - 1) * DAY);
        const rows = db.usageStats.where((r) => r.day >= from).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
        const csv = ['day,user,proxy_bytes,feed_bytes,transcribe_bytes,transcript_minutes', ...rows.map((r) => [r.day, nameOf(r.userId), r.proxyBytes, r.feedBytes, r.transcribeBytes, r.transcriptMinutes].join(','))].join('\n') + '\n';
        return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="usage-${q.days}d.csv"`).send(csv);
      }
      return buildUsage(q.days);
    });

    // ---- audit --------------------------------------------------------------------------------
    app.get('/admin/audit', async (req) => {
      const q = query(req, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional(), filter: z.enum(['all', 'auth', 'admin']).default('all') }));
      const authActions = /^(login|logout|register|password|session)/;
      let rows = db.auditLog.find().sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
      if (q.before) rows = rows.filter((r) => r.at < q.before!);
      if (q.filter === 'auth') rows = rows.filter((r) => authActions.test(r.action));
      if (q.filter === 'admin') rows = rows.filter((r) => !authActions.test(r.action));
      const page = rows.slice(0, q.limit);
      return { entries: page.map(auditDto), nextBefore: rows.length > q.limit ? page[page.length - 1]!.at : null };
    });

    // ---- settings -----------------------------------------------------------------------------
    const settingsDto = () => {
      const { registrationOpen, whisperModel, pollIntervalMinutes, autoTranscribe } = ctx.settings.get();
      return {
        registrationOpen, whisperModel, pollIntervalMinutes,
        autoTranscribe: { enabled: autoTranscribe.enabled, scope: autoTranscribe.scope, podcastIds: autoTranscribe.podcastIds },
        autoTranscribePending: ctx.autoTranscribe.eligible().length,
      };
    };
    app.get('/admin/settings', async () => settingsDto());
    app.patch('/admin/settings', async (req) => {
      const b = body(req, patchSettingsBody);
      ctx.settings.update(b);
      ctx.audit.log({ actorId: userOf(req).id, action: 'settings.update', ip: req.ip, detail: Object.keys(b).join(', ') });
      if (b.autoTranscribe) ctx.autoTranscribe.tick();
      return settingsDto();
    });
  };
}
