import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { safeDownloadToFile } from '../security/ssrf.js';
import { sha256 } from '../util/misc.js';

/** Podcast artwork is a few MB at most; anything bigger is refused. */
const MAX_ART_BYTES = 8 * 1024 ** 2;
const TIMEOUT_MS = 15_000;
/** After a failed fetch, don't retry that image for this long. */
const RETRY_AFTER_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 24 * 3600_000;

const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' } as const;
type Ext = keyof typeof TYPES;

export interface ArtFile {
  path: string;
  mimeType: string;
  bytes: number;
  /** Identifies the source URL; the file never changes for a given tag. */
  etag: string;
}

/** What the image really is, judged by its first bytes. SVG and anything unrecognised is refused. */
export function sniffImage(head: Buffer): Ext | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(head.subarray(8, 12).toString('latin1'))) return 'avif';
  return null;
}

/**
 * Same-origin copies of podcast artwork. The web player's CSP only allows images from this server, so
 * covers are fetched once through the SSRF guard, checked to really be raster images, kept in
 * DATA_DIR/cache/art, and served from here. Copies are keyed by the image URL, so a changed cover is
 * fetched again and unused ones are swept daily.
 */
export class ArtService {
  private inflight = new Map<string, Promise<ArtFile | null>>();
  private failedUntil = new Map<string, number>();
  private lastSweep = 0;

  constructor(
    private db: Database,
    private config: Config,
    private log: { warn: (o: unknown, m?: string) => void },
  ) {}

  get dir(): string {
    return path.join(this.config.dataDir, 'cache', 'art');
  }

  private keyOf(url: string): string {
    return sha256(url).slice(0, 32);
  }

  private existing(key: string): ArtFile | null {
    for (const ext of Object.keys(TYPES) as Ext[]) {
      const file = path.join(this.dir, `${key}.${ext}`);
      if (existsSync(file)) return { path: file, mimeType: TYPES[ext], bytes: statSync(file).size, etag: `"${key}"` };
    }
    return null;
  }

  /** The cover for a podcast, fetching it on first use. Null when there is none or it can't be fetched. */
  async get(podcastId: string): Promise<ArtFile | null> {
    const p = this.db.podcasts.get(podcastId);
    if (!p || p.deleted || !p.imageUrl) return null;
    const url = p.imageUrl;
    const key = this.keyOf(url);
    const have = this.existing(key);
    if (have) return have;
    if ((this.failedUntil.get(key) ?? 0) > Date.now()) return null;
    let run = this.inflight.get(key);
    if (!run) {
      run = this.fetch(url, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, run);
    }
    return run;
  }

  private async fetch(url: string, key: string): Promise<ArtFile | null> {
    mkdirSync(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `${key}.part`);
    try {
      await safeDownloadToFile(url, tmp, { maxBytes: MAX_ART_BYTES, timeoutMs: TIMEOUT_MS, allowPrivate: this.config.allowPrivateNetworks });
      const fd = openSync(tmp, 'r');
      const head = Buffer.alloc(16);
      let n = 0;
      try {
        n = readSync(fd, head, 0, 16, 0);
      } finally {
        closeSync(fd);
      }
      const ext = sniffImage(head.subarray(0, n));
      if (!ext) throw new Error('Not a supported image');
      renameSync(tmp, path.join(this.dir, `${key}.${ext}`));
      this.failedUntil.delete(key);
      this.sweepSoon();
      return this.existing(key);
    } catch (e) {
      rmSync(tmp, { force: true });
      this.failedUntil.set(key, Date.now() + RETRY_AFTER_MS);
      this.log.warn({ error: e instanceof Error ? e.message : String(e) }, 'podcast artwork could not be cached');
      return null;
    }
  }

  private sweepSoon(): void {
    if (Date.now() - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = Date.now();
    this.sweep();
  }

  /** Delete cached covers no podcast refers to any more. Returns how many were removed. */
  sweep(): number {
    if (!existsSync(this.dir)) return 0;
    const keep = new Set(this.db.podcasts.where((p) => !p.deleted && !!p.imageUrl).map((p) => this.keyOf(p.imageUrl!)));
    let removed = 0;
    for (const f of readdirSync(this.dir)) {
      const key = f.split('.')[0]!;
      if (f.endsWith('.part') || !keep.has(key)) {
        rmSync(path.join(this.dir, f), { force: true });
        removed++;
      }
    }
    return removed;
  }
}

