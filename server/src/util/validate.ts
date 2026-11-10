import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { HttpError } from './errors.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, `${where}${issue?.message ?? 'Invalid request'}`, 'validation');
  }
  return r.data;
}

export const body = <S extends z.ZodTypeAny>(req: FastifyRequest, schema: S): z.infer<S> => parse(schema, req.body);
export const query = <S extends z.ZodTypeAny>(req: FastifyRequest, schema: S): z.infer<S> => parse(schema, req.query);
