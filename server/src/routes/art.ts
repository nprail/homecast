import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { notFound } from '../util/errors.js';

const params = z.object({ podcastId: z.string().min(8).max(64) });

/**
 * Podcast artwork served from this origin. No login: an <img> tag can't send a bearer token, and the
 * podcast id is an unguessable UUID that only people who can see the podcast ever learn. Only the cover
 * image itself is served, never the feed.
 */
export function artRoutes(ctx: Ctx) {
  return async (app: FastifyInstance) => {
    app.get('/art/:podcastId', { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { podcastId } = params.parse(req.params);
      // `?v=` on the URL is only a cache-busting tag chosen by the client; it is not read here.
      const art = await ctx.art.get(podcastId);
      if (!art) throw notFound('No artwork');
      reply.header('etag', art.etag);
      reply.header('cache-control', 'public, max-age=604800');
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-security-policy', "default-src 'none'; sandbox");
      if (req.headers['if-none-match'] === art.etag) return reply.code(304).send();
      reply.header('content-type', art.mimeType);
      reply.header('content-length', art.bytes);
      return reply.send(createReadStream(art.path));
    });
  };
}
