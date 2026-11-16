import { createReadStream, statSync } from 'node:fs';
import { Transform } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import type { Episode, User } from '../db/types.js';
import { makeAuth, userOf } from '../plugins/auth.js';
import { MEDIA_URL_TTL_MS, signMedia, verifyMedia } from '../security/mediaUrl.js';
import type { LocalAudio } from '../services/mirror.js';
import { forbidden, notFound } from '../util/errors.js';
import { parseRange } from '../util/range.js';
import { query } from '../util/validate.js';

/** Whether a user may hear an episode: public podcasts are open to everyone; private ones to subscribers and admins. */
export function canHear(ctx: Ctx, user: Pick<User, 'id' | 'role'>, podcastId: string): boolean {
  const p = ctx.db.podcasts.get(podcastId);
  if (!p || p.deleted) return false;
  if (!p.isPrivate || user.role === 'admin') return true;
  return ctx.db.subscriptions.find({ userId: user.id, podcastId }).some((s) => !s.deleted);
}

/**
 * Stream a hosted copy: full response or one byte range, with the headers players expect. Bytes are
 * counted against the user's proxy usage.
 */
export function sendLocal(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, local: LocalAudio, userId: string): FastifyReply {
  const size = statSync(local.path).size;
  const range = parseRange(req.headers.range, size);
  reply.header('accept-ranges', 'bytes');
  reply.header('content-type', local.mimeType || 'application/octet-stream');
  reply.header('cache-control', 'private, max-age=3600');
  reply.header('content-security-policy', "default-src 'none'; sandbox");
  if (range === 'invalid') {
    reply.header('content-range', `bytes */${size}`);
    return reply.code(416).send();
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  reply.header('content-length', end - start + 1);
  if (range) reply.header('content-range', `bytes ${start}-${end}/${size}`);
  let served = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _e, cb) {
      served += chunk.length;
      cb(null, chunk);
    },
  });
  counter.on('close', () => ctx.usage.add(userId, 'proxyBytes', served));
  return reply.code(range ? 206 : 200).send(createReadStream(local.path, { start, end }).pipe(counter));
}

const signedQuery = z.object({
  u: z.string().min(1).max(64),
  exp: z.coerce.number().int(),
  sig: z.string().min(10).max(100),
});

export function mediaRoutes(ctx: Ctx) {
  const { authenticate } = makeAuth(ctx);
  return async (app: FastifyInstance) => {
    // The player asks for a signed URL for a hosted episode. Not hosted: `url` is null and the player
    // uses the podcast's own URL instead.
    app.get<{ Params: { id: string } }>('/episodes/:id/stream', { preHandler: authenticate, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
      const user = userOf(req);
      const ep = ctx.db.episodes.get(req.params.id);
      if (!ep || ep.deleted || !canHear(ctx, user, ep.podcastId)) throw notFound('Episode not found');
      if (!ctx.mirror.localAudio(ep)) return { url: null, expiresAt: null };
      const exp = Date.now() + MEDIA_URL_TTL_MS;
      const sig = signMedia(ctx.config.jwtSecret, ep.id, user.id, exp);
      return { url: `/api/v1/media/${ep.id}?u=${user.id}&exp=${exp}&sig=${sig}`, expiresAt: exp };
    });

    // Streams a hosted copy using a signed URL, so an <audio> element can play it without a header.
    app.get<{ Params: { id: string } }>('/media/:id', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
      const q = signedQuery.safeParse(req.query);
      if (!q.success || !verifyMedia(ctx.config.jwtSecret, req.params.id, q.data.u, q.data.exp, q.data.sig, Date.now())) throw forbidden('Link expired or invalid');
      const user = ctx.db.users.get(q.data.u);
      if (!user || user.disabled) throw forbidden('Account unavailable');
      const ep: Episode | null = ctx.db.episodes.get(req.params.id) ?? null;
      if (!ep || ep.deleted || !canHear(ctx, user, ep.podcastId)) throw notFound('Episode not found');
      const local = ctx.mirror.localAudio(ep);
      if (!local) throw notFound('Not hosted');
      return sendLocal(ctx, req, reply, local, user.id);
    });
  };
}
