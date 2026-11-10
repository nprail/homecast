import { Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { makeAuth, userOf } from '../plugins/auth.js';
import { discardBody, safeRequest } from '../security/ssrf.js';
import { forbidden, HttpError, notFound } from '../util/errors.js';
import { query } from '../util/validate.js';

const q = z.object({ url: z.string().url().max(4096) });
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/**
 * Authenticated audio proxy for the PWA only (browsers can't cache cross-origin audio without CORS).
 * Only URLs belonging to an episode in the database are proxied; bytes are counted per user.
 */
export function proxyRoutes(ctx: Ctx) {
  const { authenticate } = makeAuth(ctx);
  return async (app: FastifyInstance) => {
    app.get('/proxy/audio', { preHandler: authenticate, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
      const user = userOf(req);
      const { url } = query(req, q);
      const ep = ctx.db.episodes.find({ audioUrl: url }).find((e) => !e.deleted);
      if (!ep) throw notFound('Unknown audio URL');
      const podcast = ctx.db.podcasts.get(ep.podcastId);
      if (podcast?.isPrivate && user.role !== 'admin' && !ctx.db.subscriptions.find({ userId: user.id, podcastId: podcast.id }).some((s) => !s.deleted)) throw forbidden();

      const headers: Record<string, string> = {};
      if (typeof req.headers.range === 'string' && /^bytes=\d*-\d*(,\s*\d*-\d*)*$/.test(req.headers.range)) headers.range = req.headers.range;
      let upstream;
      try {
        upstream = await safeRequest(ep.audioUrl, { headers, timeoutMs: 30_000, allowPrivate: ctx.config.allowPrivateNetworks });
      } catch (e) {
        throw new HttpError(502, `Upstream error: ${e instanceof Error ? e.message : 'failed'}`, 'upstream');
      }
      if (![200, 206, 416].includes(upstream.status)) {
        discardBody(upstream.body);
        await upstream.close();
        throw new HttpError(502, `Upstream returned HTTP ${upstream.status}`, 'upstream');
      }
      for (const h of PASS_HEADERS) {
        const v = upstream.headers[h];
        if (typeof v === 'string') reply.header(h, v);
      }
      const ct = String(upstream.headers['content-type'] ?? '');
      if (!/^(audio|video)\//i.test(ct)) reply.header('content-type', 'application/octet-stream');
      reply.header('cache-control', 'private, max-age=3600');
      reply.header('content-security-policy', "default-src 'none'; sandbox");

      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _e, cb) {
          bytes += chunk.length;
          cb(null, chunk);
        },
      });
      let recorded = false;
      const record = () => {
        if (recorded) return;
        recorded = true;
        ctx.usage.add(user.id, 'proxyBytes', bytes);
        void upstream.close();
      };
      counter.on('close', record);
      counter.on('error', () => undefined);
      reply.raw.on('close', () => {
        discardBody(upstream.body);
        counter.destroy();
        record();
      });
      upstream.body.on('error', (e) => counter.destroy(e));
      return reply.code(upstream.status).send(upstream.body.pipe(counter));
    });
  };
}
