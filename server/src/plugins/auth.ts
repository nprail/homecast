import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import type { User } from '../db/types.js';
import { forbidden, unauthorized } from '../util/errors.js';
import { now } from '../util/misc.js';

export interface AuthInfo {
  user: User;
  sid: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

export function makeAuth(ctx: Ctx) {
  const authenticate = async (req: FastifyRequest, _reply?: FastifyReply): Promise<void> => {
    const h = req.headers.authorization;
    if (!h || !/^Bearer /i.test(h)) throw unauthorized('Missing bearer token');
    const info = await ctx.sessions.authenticate(h.slice(7).trim());
    req.auth = info;
    // Track "last active" without churning the DB on every request.
    if (!info.user.lastActiveAt || now() - info.user.lastActiveAt > 60_000) {
      info.user.lastActiveAt = now();
      ctx.db.users.saveQuiet(info.user as never);
    }
  };
  /** Enforced server-side on every /admin route; hiding UI is not the security boundary. */
  const requireAdmin = async (req: FastifyRequest, reply?: FastifyReply): Promise<void> => {
    await authenticate(req, reply);
    if (req.auth?.user.role !== 'admin') throw forbidden('Admin access required');
  };
  return { authenticate, requireAdmin };
}

export const userOf = (req: FastifyRequest): User => {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
};
