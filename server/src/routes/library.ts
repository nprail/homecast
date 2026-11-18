import type { FastifyInstance } from 'fastify';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { addPodcastBody, discoverQuery, subscribeBody, type DiscoverItem } from '@homecast/shared';
import type { Ctx } from '../context.js';
import type { Podcast, Subscription } from '../db/types.js';
import { makeAuth, userOf } from '../plugins/auth.js';
import { directoryItems } from '../services/directory.js';
import { normalizeFeedUrl } from '../services/feedParser.js';
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
      let items = directoryItems(ctx.db, { q: q.q, exclude: mine });
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
      const all = extractOpmlUrls(raw);
      const urls = all.slice(0, OPML_MAX_FEEDS);
      if (!urls.length) throw new HttpError(400, 'No feeds found in this file. Is it an OPML export?', 'validation');
      const imported: string[] = [];
      let alreadySubscribed = 0;
      const failed: { url: string; error: string }[] = [];
      let i = 0;
      const worker = async () => {
        while (i < urls.length) {
          const url = urls[i++]!;
          try {
            const p = await ctx.feeds.addByUrl(user.id, url);
            if (ctx.db.subscriptions.find({ userId: user.id, podcastId: p.id }).some((s) => !s.deleted)) alreadySubscribed++;
            else imported.push(p.id);
            ctx.feeds.subscribe(user.id, p.id);
          } catch (e) {
            failed.push({ url: url.slice(0, 200), error: e instanceof Error ? e.message : 'failed' });
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      ctx.audit.log({ action: 'opml.import', actorId: user.id, ip: req.ip, detail: `${imported.length} imported, ${alreadySubscribed} already subscribed, ${failed.length} failed` });
      return { imported: imported.length, alreadySubscribed, failed, skipped: all.length - urls.length };
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

const OPML_MAX_FEEDS = 500;

/** Feed URLs from an OPML document, at any folder depth. Attribute names are matched case-insensitively. */
export function extractOpmlUrls(xml: string): string[] {
  let doc: { opml?: { body?: unknown } };
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (n) => n === 'outline', processEntities: true }).parse(xml) as typeof doc;
  } catch {
    throw new HttpError(400, 'This is not a valid OPML file', 'validation');
  }
  const urls: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k.toLowerCase() === '@_xmlurl' && typeof v === 'string') urls.push(toText(v, 2048));
      else if (typeof v === 'object') walk(v);
    }
  };
  walk(doc.opml?.body);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    if (!/^(https?|feed|itpc|pcast):\/\//i.test(raw)) continue;
    let key: string;
    try {
      key = normalizeFeedUrl(raw);
    } catch {
      continue;
    }
    if (!seen.has(key)) (seen.add(key), out.push(key));
  }
  return out;
}

