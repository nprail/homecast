import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publicDiscoverQuery, publicEpisodesQuery, type DiscoverItem, type PublicConfig, type PublicEpisode, type PublicPodcast } from '@homecast/shared';
import type { Ctx } from '../context.js';
import type { Episode, Podcast } from '../db/types.js';
import { directoryItems } from '../services/directory.js';
import { notFound } from '../util/errors.js';
import { query } from '../util/validate.js';

const idParams = z.object({ id: z.string().min(8).max(64) });
const limit = (max: number, windowMs = '1 minute') => ({ rateLimit: { max, timeWindow: windowMs } });

/**
 * The public, view-only directory (off by default, see Settings). No login, so everything here is read-only
 * and answers 404 while the feature is off. What it exposes: the same podcasts as Discover, their episode
 * lists and show notes, and (each behind its own setting) the publisher's audio address and transcripts.
 * Private feeds are never served, and hosted copies are never served: listening streams from the publisher.
 */
export function publicRoutes(ctx: Ctx) {
  const cfg = (): PublicConfig => ({ ...ctx.settings.get().publicDirectory });
  const requireOn = (): PublicConfig => {
    const c = cfg();
    if (!c.enabled) throw notFound('Not available');
    return c;
  };
  const publicPodcast = (id: string): Podcast => {
    const p = ctx.db.podcasts.get(id);
    // A podcast an admin hid from Discover stays reachable by link; a private feed never is.
    if (!p || p.deleted || p.isPrivate) throw notFound('Podcast not found');
    return p;
  };
  const publicEpisode = (id: string): { ep: Episode; podcast: Podcast } => {
    const ep = ctx.db.episodes.get(id);
    if (!ep || ep.deleted) throw notFound('Episode not found');
    return { ep, podcast: publicPodcast(ep.podcastId) };
  };
  const subscriberCount = (podcastId: string) => ctx.db.subscriptions.find({ podcastId }).filter((s) => !s.deleted).length;

  return async (app: FastifyInstance) => {
    // Always answers, so the web app can tell whether to show public pages or send you to sign in.
    app.get('/public/config', { config: limit(120) }, async () => cfg());

    app.get('/public/discover', { config: limit(60) }, async (req) => {
      const c = requireOn();
      const q = query(req, publicDiscoverQuery);
      const sort = q.sort === 'subscribers' && !c.subscriberCounts ? 'recent' : q.sort;
      const sorters = {
        subscribers: (a: DiscoverItem, b: DiscoverItem) => b.subscriberCount - a.subscriberCount || a.title.localeCompare(b.title),
        recent: (a: DiscoverItem, b: DiscoverItem) => b.addedAt - a.addedAt,
        az: (a: DiscoverItem, b: DiscoverItem) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }),
      };
      const items = directoryItems(ctx.db, { q: q.q }).sort(sorters[sort]);
      const page = items.slice(q.offset, q.offset + q.limit).map((i) => (c.subscriberCounts ? i : { ...i, subscriberCount: 0 }));
      return { total: items.length, items: page };
    });

    app.get<{ Params: { id: string } }>('/public/podcasts/:id', { config: limit(120) }, async (req): Promise<PublicPodcast> => {
      const c = requireOn();
      const p = publicPodcast(idParams.parse(req.params).id);
      const q = query(req, publicEpisodesQuery);
      const all = ctx.db.episodes.find({ podcastId: p.id }).filter((e) => !e.deleted).sort((a, b) => b.releasedAt - a.releasedAt);
      return {
        id: p.id, title: p.title, author: p.author, imageUrl: p.imageUrl, description: p.description,
        ...(c.subscriberCounts ? { subscriberCount: subscriberCount(p.id) } : {}),
        total: all.length,
        episodes: all.slice(q.offset, q.offset + q.limit).map((e) => ({ id: e.id, title: e.title, releasedAt: e.releasedAt, durationSec: e.durationSec })),
      };
    });

    app.get<{ Params: { id: string } }>('/public/episodes/:id', { config: limit(120) }, async (req): Promise<PublicEpisode> => {
      const c = requireOn();
      const { ep, podcast } = publicEpisode(idParams.parse(req.params).id);
      const chapters = (await ctx.chapters.get(ep).catch(() => null))?.chapters ?? [];
      return {
        id: ep.id, title: ep.title, description: ep.description, releasedAt: ep.releasedAt, durationSec: ep.durationSec,
        podcast: { id: podcast.id, title: podcast.title, author: podcast.author, imageUrl: podcast.imageUrl },
        audioUrl: c.listening ? ep.audioUrl : null,
        hasTranscript: c.transcripts && !!ctx.transcripts.get(ep.id),
        chapters,
      };
    });

    app.get<{ Params: { id: string } }>('/public/episodes/:id/transcript', { config: limit(60) }, async (req) => {
      const c = requireOn();
      const { ep } = publicEpisode(idParams.parse(req.params).id);
      if (!c.transcripts) throw notFound('Not available');
      const t = ctx.transcripts.get(ep.id);
      if (!t) throw notFound('No transcript for this episode');
      return { status: 'ready', source: t.source, segments: t.segments };
    });
  };
}
