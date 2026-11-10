import type { FastifyInstance } from 'fastify';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { addPodcastBody, discoverQuery, subscribeBody, type DiscoverItem } from '@homecast/shared';
import type { Ctx } from '../context.js';
import type { Podcast, Subscription } from '../db/types.js';
import { makeAuth, userOf } from '../plugins/auth.js';
import { toText } from '../util/html.js';
import { clean, now } from '../util/misc.js';
import { HttpError, notFound } from '../util/errors.js';
import { body, query } from '../util/validate.js';

const podcastDto = (p: Podcast) => ({
  id: p.id, title: p.title, author: p.author, imageUrl: p.imageUrl, description: p.description, feedUrl: p.feedUrl, isPrivate: p.isPrivate,
});

export function libraryRoutes(ctx: Ctx) {
  const { authenticate } = makeAuth(ctx);

  const subscribedPodcasts = (userId: string): { sub: Subscription; podcast: Podcast }[] =>
    ctx.db.subscriptions
      .find({ userId })
      .filter((s) => !s.deleted)
      .flatMap((sub) => {
        const podcast = ctx.db.podcasts.get(sub.podcastId);
        return podcast && !podcast.deleted ? [{ sub, podcast }] : [];
      });

  return async (app: FastifyInstance) => {
    // OPML arrives as XML text.
    app.addContentTypeParser(['text/xml', 'application/xml', 'text/x-opml', 'text/plain'], { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 }, (_req, b, done) => done(null, b));

    app.post('/podcasts', { preHandler: authenticate, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const b = body(req, addPodcastBody);
      const user = userOf(req);
      const podcast = await ctx.feeds.addByUrl(user.id, b.feedUrl, b.private);
      const sub = ctx.feeds.subscribe(user.id, podcast.id);
      ctx.audit.log({ action: 'podcast.add', actorId: user.id, target: podcast.id, targetLabel: podcast.title, ip: req.ip });
      return reply.code(201).send({ podcast: podcastDto(podcast), subscription: clean(sub) });
    });

    app.post('/subscriptions', { preHandler: authenticate }, async (req, reply) => {
      const b = body(req, subscribeBody);
      const user = userOf(req);
      const podcast = ctx.db.podcasts.get(b.podcastId);
      // Private feeds can't be referenced by id: the user must supply the feed URL themselves.
      if (!podcast || podcast.deleted || podcast.isPrivate) throw notFound('Podcast not found');
      const sub = ctx.feeds.subscribe(user.id, podcast.id);
      return reply.code(201).send({ podcast: { ...podcastDto(podcast), feedUrl: undefined }, subscription: clean(sub) });
    });

    app.delete<{ Params: { id: string } }>('/subscriptions/:id', { preHandler: authenticate }, async (req, reply) => {
      const sub = ctx.db.subscriptions.get(req.params.id);
      if (!sub || sub.userId !== userOf(req).id) throw notFound('Subscription not found');
      if (!sub.deleted) {
        sub.deleted = true;
        sub.deletedAt = now();
        sub.clientUpdatedAt = now();
        ctx.db.subscriptions.save(sub);
      }
      return reply.code(204).send();
    });

    app.get('/discover', { preHandler: authenticate }, async (req) => {
      const q = query(req, discoverQuery);
      const user = userOf(req);
      const mine = new Set(ctx.db.subscriptions.find({ userId: user.id }).filter((s) => !s.deleted).map((s) => s.podcastId));
      const counts = new Map<string, number>();
      for (const s of ctx.db.subscriptions.where((x) => !x.deleted)) counts.set(s.podcastId, (counts.get(s.podcastId) ?? 0) + 1);
      const needle = q.q?.trim().toLowerCase();
      let items: DiscoverItem[] = [];
      for (const [podcastId, n] of counts) {
        const p = ctx.db.podcasts.get(podcastId);
        // Private and hidden feeds are never listed; podcasts with no subscribers drop out naturally.
        if (!p || p.deleted || p.isPrivate || p.hiddenFromDiscover || mine.has(podcastId)) continue;
        if (needle && !p.title.toLowerCase().includes(needle) && !p.author.toLowerCase().includes(needle)) continue;
        items.push({ id: p.id, title: p.title, author: p.author, imageUrl: p.imageUrl, description: p.description.slice(0, 300), subscriberCount: n, addedAt: p.createdAt });
      }
      const sorters = {
        subscribers: (a: DiscoverItem, b: DiscoverItem) => b.subscriberCount - a.subscriberCount || a.title.localeCompare(b.title),
        recent: (a: DiscoverItem, b: DiscoverItem) => b.addedAt - a.addedAt,
        az: (a: DiscoverItem, b: DiscoverItem) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }),
      };
      items = items.sort(sorters[q.sort]);
      return { total: items.length, items: items.slice(q.offset, q.offset + q.limit) };
    });

    // ---- OPML ---------------------------------------------------------------------------------
    app.post('/opml/import', { preHandler: authenticate, bodyLimit: 5 * 1024 * 1024, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
      const user = userOf(req);
      const raw = typeof req.body === 'string' ? req.body : typeof (req.body as { opml?: unknown })?.opml === 'string' ? (req.body as { opml: string }).opml : '';
      if (!raw) throw new HttpError(400, 'Send the OPML document as the request body', 'validation');
      const urls = extractOpmlUrls(raw).slice(0, 500);
      if (!urls.length) throw new HttpError(400, 'No feeds found in OPML', 'validation');
      const imported: string[] = [];
      const failed: { url: string; error: string }[] = [];
      let i = 0;
      const worker = async () => {
        while (i < urls.length) {
          const url = urls[i++]!;
          try {
            const p = await ctx.feeds.addByUrl(user.id, url);
            ctx.feeds.subscribe(user.id, p.id);
            imported.push(p.id);
          } catch (e) {
            failed.push({ url: url.slice(0, 200), error: e instanceof Error ? e.message : 'failed' });
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      ctx.audit.log({ action: 'opml.import', actorId: user.id, ip: req.ip, detail: `${imported.length} imported, ${failed.length} failed` });
      return { imported: imported.length, failed };
    });

    app.get('/opml/export', { preHandler: authenticate }, async (req, reply) => {
      const outlines = subscribedPodcasts(userOf(req).id).map(({ podcast }) => ({
        '@_type': 'rss', '@_text': podcast.title, '@_title': podcast.title, '@_xmlUrl': podcast.feedUrl,
      }));
      const xml = new XMLBuilder({ ignoreAttributes: false, format: true, suppressEmptyNode: true }).build({
        '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
        opml: { '@_version': '2.0', head: { title: 'Homecast subscriptions', dateCreated: new Date().toUTCString() }, body: { outline: outlines } },
      }) as string;
      return reply.header('content-type', 'text/x-opml; charset=utf-8').header('content-disposition', 'attachment; filename="homecast.opml"').send(xml);
    });

    // ---- data export ("export all my data") -----------------------------------------------------
    app.get('/me/export', { preHandler: authenticate }, async (req, reply) => {
      const u = userOf(req);
      const own = <T extends object>(rows: T[]) => rows.map((r) => clean(r));
      const subs = subscribedPodcasts(u.id);
      const data = {
        exportedAt: new Date().toISOString(),
        user: { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt },
        podcasts: subs.map(({ podcast }) => podcastDto(podcast)),
        subscriptions: own(ctx.db.subscriptions.find({ userId: u.id })),
        episodeStates: own(ctx.db.episodeStates.find({ userId: u.id })),
        bookmarks: own(ctx.db.bookmarks.find({ userId: u.id })),
        playlists: own(ctx.db.playlists.find({ userId: u.id })),
        smartPlaylists: own(ctx.db.smartPlaylists.find({ userId: u.id })),
        settings: own(ctx.db.userSettings.find({ userId: u.id })),
      };
      return reply.header('content-disposition', 'attachment; filename="homecast-export.json"').send(data);
    });
  };
}

function extractOpmlUrls(xml: string): string[] {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (n) => n === 'outline', processEntities: true }).parse(xml) as {
    opml?: { body?: unknown };
  };
  const urls: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === '@_xmlUrl' && typeof v === 'string') urls.push(toText(v, 2048));
      else if (typeof v === 'object') walk(v);
    }
  };
  walk(doc.opml?.body);
  return [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))];
}

