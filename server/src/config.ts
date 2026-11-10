import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  publicUrl: string;
  /** Origins allowed by CORS and for cookie-authenticated requests: the PWA origin only, plus any dev origins. */
  allowedOrigins: string[];
  secureCookies: boolean;
  whisperBin: string;
  whisperModel: string;
  whisperModelDir: string;
  ffmpegBin: string;
  /** Fastify `trustProxy` value: false, true, or a list of proxy IPs/CIDRs. */
  trustProxy: boolean | string[];
  jwtSecret: string;
  webDir: string | null;
  version: string;
  /** Test/dev only: allow fetching private network addresses. Never enable in production. */
  allowPrivateNetworks: boolean;
  logLevel: string;
  maxEpisodesPerFeed: number;
  startWorkers: boolean;
}

export const VERSION = '1.0.0';

function parseTrustProxy(v: string | undefined): boolean | string[] {
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true' || v === '1') return true;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** JWT secret: env override, else generated on first run and persisted in the data dir (spec §7). */
function loadJwtSecret(dataDir: string, override?: string): string {
  if (override && override.length >= 32) return override;
  if (override) throw new Error('JWT_SECRET must be at least 32 characters');
  const file = path.join(dataDir, 'jwt.secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(file, secret + '\n', { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  const port = Number(env.PORT ?? 8080);
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  const webDirEnv = path.resolve(env.WEB_DIR ?? '../web/dist');
  const cfg: Config = {
    port,
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    publicUrl,
    allowedOrigins: [new URL(publicUrl).origin, ...(env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)],
    secureCookies: publicUrl.startsWith('https://'),
    whisperBin: env.WHISPER_BIN ?? 'whisper-cli',
    whisperModel: env.WHISPER_MODEL ?? 'base.en-q5_1',
    whisperModelDir: env.WHISPER_MODEL_DIR ?? path.join(dataDir, 'models'),
    ffmpegBin: env.FFMPEG_BIN ?? 'ffmpeg',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    jwtSecret: loadJwtSecret(dataDir, env.JWT_SECRET),
    webDir: existsSync(webDirEnv) ? webDirEnv : null,
    version: VERSION,
    allowPrivateNetworks: env.ALLOW_PRIVATE_NETWORKS === 'true',
    logLevel: env.LOG_LEVEL ?? 'info',
    maxEpisodesPerFeed: Number(env.MAX_EPISODES_PER_FEED ?? 5000),
    startWorkers: env.DISABLE_WORKERS !== 'true',
  };
  return { ...cfg, ...overrides };
}
