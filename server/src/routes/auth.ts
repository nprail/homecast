import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  changePasswordBody, loginBody, refreshBody, registerBody, resetPasswordBody,
  type AuthResponse, type SessionDto, type UserDto,
} from '@homecast/shared';
import type { Ctx } from '../context.js';
import type { User } from '../db/types.js';
import { makeAuth, userOf } from '../plugins/auth.js';
import { dummyVerify, hashPassword, verifyPassword } from '../security/passwords.js';
import { REFRESH_TTL_MS } from '../services/sessions.js';
import { conflict, forbidden, HttpError, notFound, unauthorized } from '../util/errors.js';
import { now, randomToken, safeEqualHex, sha256 } from '../util/misc.js';
import { body } from '../util/validate.js';

const COOKIE = 'rt';
const COOKIE_PATH = '/api/v1/auth';

export const toUserDto = (u: User): UserDto => ({ id: u.id, username: u.username, role: u.role });

export function authRoutes(ctx: Ctx) {
  const { authenticate } = makeAuth(ctx);
  const originOk = (req: FastifyRequest): boolean => {
    const o = req.headers.origin;
    if (!o || ctx.config.allowedOrigins.includes(o)) return true;
    // Same-origin requests are always fine (reached via a LAN IP or another hostname than PUBLIC_URL).
    try {
      return new URL(o).host === req.host;
    } catch {
      return false;
    }
  };
  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, { httpOnly: true, secure: ctx.config.secureCookies, sameSite: 'strict', path: COOKIE_PATH, maxAge: Math.floor(REFRESH_TTL_MS / 1000) });
  const clearCookie = (reply: FastifyReply) => reply.clearCookie(COOKIE, { path: COOKIE_PATH });

  async function respond(reply: FastifyReply, user: User, sid: string, refreshToken: string, web: boolean): Promise<AuthResponse> {
    const { token, expiresAt } = await ctx.sessions.signAccess(user.id, sid);
    if (web) setCookie(reply, refreshToken);
    return { user: toUserDto(user), accessToken: token, accessTokenExpiresAt: expiresAt, ...(web ? {} : { refreshToken }) };
  }

  return async (app: FastifyInstance) => {
    app.post('/auth/login', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const b = body(req, loginBody);
      const guard = ctx.loginGuard.check(req.ip, b.username);
      if (!guard.allowed) {
        reply.header('retry-after', String(guard.retryAfterSec));
        throw new HttpError(429, 'Too many attempts. Try again later.', 'locked');
      }
      const user = ctx.db.users.findOne({ usernameKey: b.username.trim().toLowerCase() });
      const ok = user ? await verifyPassword(user.passwordHash, b.password) : (await dummyVerify(b.password), false);
      if (!user || !ok || user.disabled) {
        const f = ctx.loginGuard.fail(req.ip, b.username);
        ctx.audit.log({
          action: 'login.failed',
          actorName: b.username.slice(0, 64),
          ip: req.ip,
          detail: f.locked ? `${f.attempts} attempts, locked ${f.lockMinutes} min` : user?.disabled && ok ? 'account disabled' : null,
        });
        throw unauthorized('Invalid username or password');
      }
      ctx.loginGuard.succeed(req.ip, b.username);
      const { sid, refreshToken } = ctx.sessions.createSession(user, b.deviceName ?? (b.client === 'web' ? 'Web browser' : 'Unknown device'), req.ip);
      ctx.audit.log({ action: 'login.success', actorId: user.id, ip: req.ip, detail: b.deviceName ?? (b.client === 'web' ? 'Web browser' : null) });
      return respond(reply, user, sid, refreshToken, b.client === 'web');
    });

    app.post('/auth/refresh', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      const b = body(req, refreshBody);
      const cookieToken = (req.cookies as Record<string, string | undefined>)[COOKIE];
      const token = b.refreshToken ?? cookieToken;
      if (!token) throw unauthorized('No refresh token');
      const viaCookie = !b.refreshToken;
      if (viaCookie && !originOk(req)) throw forbidden('Cross-origin refresh refused');
      try {
        const r = ctx.sessions.rotate(token, req.ip);
        return await respond(reply, r.user, r.sid, r.refreshToken, viaCookie);
      } catch (e) {
        const reused = (e as { reuseOf?: { id: string; userId: string } }).reuseOf;
        if (reused) ctx.audit.log({ action: 'session.reuse_detected', actorId: reused.userId, target: reused.id, ip: req.ip });
        if (viaCookie) clearCookie(reply);
        throw e;
      }
    });

    app.post('/auth/logout', async (req, reply) => {
      let sid: string | null = null;
      try {
        await authenticate(req);
        sid = req.auth?.sid ?? null;
      } catch {
        const t = (req.cookies as Record<string, string | undefined>)[COOKIE];
        // Only revoke by cookie when the secret actually matches the session's current token.
        if (t && originOk(req)) {
          const dot = t.indexOf('.');
          const rec = dot > 0 ? ctx.db.refreshTokens.get(t.slice(0, dot)) : null;
          if (rec && safeEqualHex(sha256(t.slice(dot + 1)), rec.tokenHash)) sid = rec.id;
        }
      }
      if (sid) {
        ctx.sessions.revoke(sid);
        ctx.audit.log({ action: 'logout', actorId: ctx.db.refreshTokens.get(sid)?.userId ?? null, ip: req.ip });
      }
      clearCookie(reply);
      return reply.code(204).send();
    });

    app.post('/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
      const b = body(req, registerBody);
      const usernameKey = b.username.toLowerCase();
      let role: User['role'] = 'user';
      let invite: ReturnType<typeof ctx.db.invites.get> = null;

      const noUsers = ctx.db.users.count() === 0;
      if (b.bootstrapToken) {
        if (!noUsers || !ctx.bootstrap.token || !safeEqualHex(sha256(b.bootstrapToken), sha256(ctx.bootstrap.token)))
          throw forbidden('Invalid bootstrap token');
        role = 'admin';
      } else {
        if (!ctx.settings.get().registrationOpen) throw forbidden('Registration is closed');
        if (!b.inviteCode) throw new HttpError(400, 'An invite code is required', 'invite_required');
        invite = ctx.db.invites.findOne({ codeHash: sha256(b.inviteCode.trim()) });
        if (!invite || invite.usedBy || invite.revokedAt || invite.expiresAt < now()) throw new HttpError(400, 'Invite code is invalid or expired', 'invite_invalid');
      }
      if (ctx.db.users.findOne({ usernameKey })) throw conflict('Username already taken');
      const user = ctx.db.users.insert({
        username: b.username,
        usernameKey,
        passwordHash: await hashPassword(b.password),
        role,
        createdAt: now(),
        disabled: false,
        lastActiveAt: now(),
      });
      if (invite) {
        invite.usedBy = user.id;
        invite.usedAt = now();
        ctx.db.invites.saveQuiet(invite);
      } else {
        ctx.bootstrap.token = null;
      }
      ctx.audit.log({ action: role === 'admin' ? 'register.admin' : 'register', actorId: user.id, target: user.id, targetLabel: user.username, ip: req.ip });
      const { sid, refreshToken } = ctx.sessions.createSession(user, b.deviceName ?? (b.client === 'web' ? 'Web browser' : 'Unknown device'), req.ip);
      return reply.code(201).send(await respond(reply, user, sid, refreshToken, b.client === 'web'));
    });

    app.get('/auth/me', { preHandler: authenticate }, async (req) => ({ user: toUserDto(userOf(req)) }));

    app.get('/auth/sessions', { preHandler: authenticate }, async (req): Promise<{ sessions: SessionDto[] }> => ({
      sessions: ctx.sessions.listForUser(userOf(req).id).map((s) => ({ id: s.id, deviceName: s.deviceName, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, current: s.id === req.auth?.sid })),
    }));

    app.delete<{ Params: { id: string } }>('/auth/sessions/:id', { preHandler: authenticate }, async (req, reply) => {
      const rec = ctx.db.refreshTokens.get(req.params.id);
      if (!rec || rec.userId !== userOf(req).id) throw notFound('Session not found');
      ctx.sessions.revoke(rec.id);
      return reply.code(204).send();
    });

    app.post('/auth/reset-password', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
      const b = body(req, resetPasswordBody);
      const rec = ctx.db.resetTokens.findOne({ tokenHash: sha256(b.token) });
      if (!rec || rec.usedAt || rec.expiresAt < now()) throw new HttpError(400, 'Reset link is invalid or expired', 'reset_invalid');
      const user = ctx.db.users.get(rec.userId);
      if (!user) throw new HttpError(400, 'Reset link is invalid or expired', 'reset_invalid');
      user.passwordHash = await hashPassword(b.password);
      ctx.db.users.saveQuiet(user);
      rec.usedAt = now();
      ctx.db.resetTokens.saveQuiet(rec);
      ctx.sessions.revokeAllForUser(user.id);
      ctx.audit.log({ action: 'password.reset', actorId: user.id, target: user.id, targetLabel: user.username, ip: req.ip });
      return { ok: true };
    });

    app.post('/auth/change-password', { preHandler: authenticate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const b = body(req, changePasswordBody);
      const user = userOf(req);
      if (!(await verifyPassword(user.passwordHash, b.currentPassword))) throw unauthorized('Current password is incorrect');
      user.passwordHash = await hashPassword(b.newPassword);
      ctx.db.users.saveQuiet(user);
      ctx.sessions.revokeAllForUser(user.id, req.auth?.sid);
      ctx.audit.log({ action: 'password.changed', actorId: user.id, ip: req.ip });
      return { ok: true };
    });
  };
}

export const newInviteCode = (): string => `inv_${randomToken(16)}`;
