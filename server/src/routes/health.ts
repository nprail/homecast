import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';

export function healthRoutes(ctx: Ctx) {
  return async (app: FastifyInstance) => {
    app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true, version: ctx.config.version, uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000) }));
  };
}
