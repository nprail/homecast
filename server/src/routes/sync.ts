import type { FastifyInstance } from 'fastify';
import { syncRequestSchema } from '@homecast/shared';
import type { Ctx } from '../context.js';
import { makeAuth, userOf } from '../plugins/auth.js';
import { body } from '../util/validate.js';

export function syncRoutes(ctx: Ctx) {
  const { authenticate } = makeAuth(ctx);
  return async (app: FastifyInstance) => {
    app.post('/sync', { preHandler: authenticate, bodyLimit: 16 * 1024 * 1024, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
      const b = body(req, syncRequestSchema);
      return ctx.sync.sync(userOf(req), b);
    });
  };
}
