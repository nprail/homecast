import type { FastifyInstance } from 'fastify';
import { transcriptSearchQuery } from '@homecast/shared';
import type { Ctx } from '../context.js';
import type { Episode, User } from '../db/types.js';
import { makeAuth, userOf } from '../plugins/auth.js';
import { notFound } from '../util/errors.js';
import { query } from '../util/validate.js';

export function transcriptRoutes(ctx: Ctx) {
  const { authenticate } = makeAuth(ctx);

  /** Public feeds are open to any user; private feeds only to their subscribers (or admins). */
  const episodeFor = (user: User, id: string): Episode => {
    const ep = ctx.db.episodes.get(id);
    if (!ep || ep.deleted) throw notFound('Episode not found');
    const podcast = ctx.db.podcasts.get(ep.podcastId);
    if (!podcast) throw notFound('Episode not found');
    if (podcast.isPrivate && user.role !== 'admin') {
      const subscribed = ctx.db.subscriptions.find({ userId: user.id, podcastId: podcast.id }).some((s) => !s.deleted);
      if (!subscribed) throw notFound('Episode not found');
    }
    return ep;
  };

  const jobDto = (j: NonNullable<ReturnType<typeof ctx.db.jobs.get>>) => ({
    id: j.id, episodeId: j.episodeId, status: j.status, stage: j.stage, progress: j.progress, error: j.error,
    queuePosition: ctx.transcripts.queuePosition(j), source: j.source, createdAt: j.createdAt, finishedAt: j.finishedAt,
  });

  return async (app: FastifyInstance) => {
    app.post<{ Params: { id: string } }>('/episodes/:id/transcript', { preHandler: authenticate, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const user = userOf(req);
      const ep = episodeFor(user, req.params.id);
      const r = ctx.transcripts.request(user.id, ep.id);
      return reply.code(r.status === 'ready' ? 200 : 202).send({ status: r.status, job: r.job ? jobDto(r.job) : null });
    });

    app.get<{ Params: { id: string } }>('/episodes/:id/transcript', { preHandler: authenticate }, async (req, reply) => {
      const ep = episodeFor(userOf(req), req.params.id);
      const t = ctx.transcripts.get(ep.id);
      if (t) return { status: 'ready', source: t.source, model: t.model, segments: t.segments };
      const job = ctx.db.jobs.find({ episodeId: ep.id }).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (job && (job.status === 'queued' || job.status === 'running')) return reply.code(202).send({ status: job.status, job: jobDto(job) });
      throw notFound('No transcript for this episode');
    });

    // Search the transcripts of the podcasts you subscribe to.
    app.get('/search/transcripts', { preHandler: authenticate, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      const q = query(req, transcriptSearchQuery);
      const mine = new Set(ctx.db.subscriptions.find({ userId: userOf(req).id }).filter((s) => !s.deleted).map((s) => s.podcastId));
      return ctx.search.transcripts(q.q, mine, q);
    });

    // What a shared "moment" link points at. Lets someone who doesn't follow the podcast yet see what they were sent
    // (public podcasts only; a private feed is visible only to its subscribers and admins, see `episodeFor`).
    app.get<{ Params: { id: string } }>('/episodes/:id/share', { preHandler: authenticate }, async (req) => {
      const user = userOf(req);
      const ep = episodeFor(user, req.params.id);
      const podcast = ctx.db.podcasts.get(ep.podcastId)!;
      const subscribed = ctx.db.subscriptions.find({ userId: user.id, podcastId: podcast.id }).some((s) => !s.deleted);
      return {
        episode: { id: ep.id, title: ep.title, durationSec: ep.durationSec, releasedAt: ep.releasedAt },
        podcast: { id: podcast.id, title: podcast.title, imageUrl: podcast.imageUrl, isPrivate: podcast.isPrivate },
        subscribed,
      };
    });

    app.get<{ Params: { id: string } }>('/episodes/:id/chapters', { preHandler: authenticate }, async (req) => {
      const ep = episodeFor(userOf(req), req.params.id);
      const r = await ctx.chapters.get(ep);
      if (!r) throw notFound('No chapters for this episode');
      return r;
    });

    app.get<{ Params: { id: string } }>('/jobs/:id', { preHandler: authenticate }, async (req) => {
      const user = userOf(req);
      const job = ctx.db.jobs.get(req.params.id);
      if (!job || !ctx.transcripts.canView(job, user.id, user.role === 'admin')) throw notFound('Job not found');
      return jobDto(job);
    });
  };
}
