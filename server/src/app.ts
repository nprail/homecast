import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import { Database } from './db/index.js';
import { LoginGuard } from './security/loginGuard.js';
import { AuditService } from './services/audit.js';
import { AutoTranscriber } from './services/autoTranscribe.js';
import { BackupService } from './services/backup.js';
import { FeedPoller, FeedService } from './services/feeds.js';
import { Maintenance } from './services/maintenance.js';
import { SessionService } from './services/sessions.js';
import { SettingsService } from './services/settings.js';
import { SyncService } from './services/sync.js';
import { TranscriptService } from './services/transcripts.js';
import { UsageService } from './services/usage.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { libraryRoutes } from './routes/library.js';
import { proxyRoutes } from './routes/proxy.js';
import { syncRoutes } from './routes/sync.js';
import { transcriptRoutes } from './routes/transcripts.js';
import { HttpError } from './util/errors.js';

export interface App {
  app: FastifyInstance;
  ctx: Ctx;
  maintenance: Maintenance;
  close: () => Promise<void>;
}

export async function buildApp(config: Config, opts: { db?: Database; logger?: boolean } = {}): Promise<App> {
  const logger =
    opts.logger === false
      ? false
      : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] };
  const app = Fastify({
    logger,
    trustProxy: config.trustProxy, // X-Forwarded-* is honored only from the configured proxy
    bodyLimit: 1024 * 1024,
  });

  const db = opts.db ?? (await Database.open({ dataDir: config.dataDir }));
  const log = app.log;
  const settings = new SettingsService(db, config);
  const audit = new AuditService(db);
  const usage = new UsageService(db);
  const sessions = new SessionService(db, config);
  const feeds = new FeedService(db, config, usage, settings);
  const transcripts = new TranscriptService(db, config, usage, settings, audit, log);
  const autoTranscribe = new AutoTranscriber(db, settings, transcripts, feeds);
  const backup = new BackupService(db, config, settings, audit);
  const sync = new SyncService(db);
  const ctx: Ctx = {
    config, db, sessions, audit, usage, settings, feeds, transcripts, autoTranscribe, sync, backup,
    poller: new FeedPoller(db, feeds, log),
    loginGuard: new LoginGuard(),
    bootstrap: { token: null },
    startedAt: Date.now(),
  };
  if (db.users.count() === 0) {
    ctx.bootstrap.token = randomBytes(24).toString('base64url');
  }
  feeds.onNewEpisodes = () => autoTranscribe.tick();
  transcripts.onJobFinished = () => autoTranscribe.tick();
  const maintenance = new Maintenance(db, backup, sync, usage, audit, sessions, transcripts, ctx.loginGuard, log);

  const isHttps = config.publicUrl.startsWith('https://');
  await app.register(helmet, {
    hsts: isHttps ? { maxAge: 15552000, includeSubDomains: true } : false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:', 'http:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:', 'https:', 'http:'], // audio streams straight from the podcast CDN
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: isHttps ? [] : null,
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', keyGenerator: (req) => req.ip });
  app.decorateRequest('auth', null);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: { code: err.code ?? 'error', message: err.message } });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests' } });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  await app.register(
    async (api) => {
      api.addHook('onSend', async (_req, reply) => {
        reply.header('cache-control', 'no-store');
      });
      await api.register(healthRoutes(ctx));
      await api.register(authRoutes(ctx));
      await api.register(libraryRoutes(ctx));
      await api.register(syncRoutes(ctx));
      await api.register(transcriptRoutes(ctx));
      await api.register(proxyRoutes(ctx));
      await api.register(adminRoutes(ctx));
    },
    { prefix: '/api/v1' },
  );
  // Ops probe also at the root for load balancers.
  await app.register(healthRoutes(ctx));

  if (config.webDir) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      wildcard: false,
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (res, filePath) => {
        // Hashed build assets never change; the shell, manifest and service worker must always revalidate.
        const hashed = /[\\/]assets[\\/]/.test(filePath);
        res.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if ((req.method === 'GET' || req.method === 'HEAD') && !req.url.startsWith('/api/') && (req.headers.accept ?? '').includes('text/html'))
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } }));
  }

  const close = async () => {
    ctx.poller.stop();
    maintenance.stop();
    transcripts.stop();
    autoTranscribe.stop();
    usage.stop();
    await app.close();
    await db.save();
    await db.close();
  };
  return { app, ctx, maintenance, close };
}

/** Background workers (feed poller, transcript queue, maintenance). Not started in tests. */
export function startWorkers({ ctx, maintenance }: App): void {
  ctx.usage.start();
  ctx.poller.start();
  ctx.transcripts.start();
  ctx.autoTranscribe.start();
  maintenance.start();
}
