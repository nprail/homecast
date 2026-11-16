import type { Chapter, ChaptersResponse, ChapterSource } from '@homecast/shared';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { Episode } from '../db/types.js';
import { safeFetchBuffer } from '../security/ssrf.js';
import { toText } from '../util/html.js';
import { now } from '../util/misc.js';

const CHAPTERS_MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CHAPTERS = 500;
/** How long a fetched list is trusted before the publisher's file is read again. */
const FRESH_MS = 24 * 3600_000;
/** After a failed fetch, wait this long before trying again. */
const RETRY_MS = 30 * 60_000;

const httpUrl = (u: unknown): string | undefined => {
  if (typeof u !== 'string') return undefined;
  try {
    const p = new URL(u.trim());
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString().slice(0, 2048) : undefined;
  } catch {
    return undefined;
  }
};

/** Normal Play Time ("1:02:03.5", "12:30", "754.2") to milliseconds, or null. */
export function parseNpt(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const m = /^(?:(\d+):)?(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(s);
  if (!m) return null;
  const ms = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms;
}

/** Sort, drop blanks and duplicates, and cap the list. Returns [] when there is nothing usable. */
function tidy(list: Chapter[]): Chapter[] {
  const out: Chapter[] = [];
  for (const c of [...list].sort((a, b) => a.startMs - b.startMs)) {
    if (!c.title) continue;
    if (out.length && out[out.length - 1]!.startMs === c.startMs) continue;
    out.push(c);
    if (out.length >= MAX_CHAPTERS) break;
  }
  return out;
}

/** Podcasting 2.0 chapters JSON: `{ "version": "1.2.0", "chapters": [{ "startTime": 0, "title": "..." }] }`. */
export function parseChaptersJson(raw: string): Chapter[] {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (j as { chapters?: unknown })?.chapters;
  if (!Array.isArray(list)) return [];
  const out: Chapter[] = [];
  for (const c of list as Record<string, unknown>[]) {
    if (!c || typeof c !== 'object' || c.toc === false) continue; // toc:false chapters are not meant for navigation
    const t = typeof c.startTime === 'number' ? c.startTime : typeof c.startTime === 'string' ? Number(c.startTime) : NaN;
    if (!Number.isFinite(t) || t < 0) continue;
    const title = toText(typeof c.title === 'string' ? c.title : '', 200);
    const chapter: Chapter = { startMs: Math.round(t * 1000), title };
    const img = httpUrl(c.img);
    const url = httpUrl(c.url);
    if (img) chapter.img = img;
    if (url) chapter.url = url;
    out.push(chapter);
  }
  return tidy(out);
}

/** Chapters written inline in the feed (Podlove Simple Chapters: `<psc:chapter start="00:01:00" title="..."/>`). */
export function parseInlineChapters(nodes: { start: string; title: string; href?: string; image?: string }[]): Chapter[] {
  const out: Chapter[] = [];
  for (const n of nodes) {
    const startMs = parseNpt(n.start);
    if (startMs === null) continue;
    const chapter: Chapter = { startMs, title: toText(n.title, 200) };
    const url = httpUrl(n.href);
    const img = httpUrl(n.image);
    if (url) chapter.url = url;
    if (img) chapter.img = img;
    out.push(chapter);
  }
  return tidy(out);
}

/**
 * Show notes often list chapters by hand: one "12:34 Topic" line each. Used only when the feed has
 * no real chapters, and only when it looks deliberate: at least three lines, in order, starting near 0.
 */
export function parseDescriptionChapters(descriptionHtml: string): Chapter[] {
  const text = descriptionHtml.replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, '\n');
  const out: Chapter[] = [];
  for (const raw of text.split('\n')) {
    const line = toText(raw, 300).replace(/^[-–—•*\s]+/, '');
    const m = /^[([]?((?:\d{1,2}:)?\d{1,2}:\d{2})[)\]]?\s*[-–—:.)]?\s*(.+)$/.exec(line) ?? /^(.+?)\s*[-–—:(]\s*[([]?((?:\d{1,2}:)?\d{1,2}:\d{2})[)\]]?$/.exec(line);
    if (!m) continue;
    // The first form puts the time first; the second puts it last.
    const timeFirst = /^\d/.test(m[1]!);
    const time = timeFirst ? m[1]! : m[2]!;
    const title = (timeFirst ? m[2]! : m[1]!).trim();
    const startMs = parseNpt(time);
    if (startMs !== null && title.length >= 2) out.push({ startMs, title: title.slice(0, 200) });
  }
  if (out.length < 3) return [];
  for (let i = 1; i < out.length; i++) if (out[i]!.startMs <= out[i - 1]!.startMs) return []; // not a chapter list
  if (out[0]!.startMs > 60_000) return [];
  return tidy(out);
}

export class ChaptersService {
  private inflight = new Map<string, Promise<ChaptersResponse | null>>();

  constructor(
    private db: Database,
    private config: Config,
    private log: { warn: (o: unknown, m?: string) => void },
  ) {}

  /** Chapters for an episode, or null when it has none. Publisher chapters win over show-note timestamps. */
  get(episode: Episode): Promise<ChaptersResponse | null> {
    const running = this.inflight.get(episode.id);
    if (running) return running;
    const p = this.resolve(episode).finally(() => this.inflight.delete(episode.id));
    this.inflight.set(episode.id, p);
    return p;
  }

  private async resolve(episode: Episode): Promise<ChaptersResponse | null> {
    const url = episode.chaptersUrl ?? null;
    if (url) {
      const cached = this.db.episodeChapters.findOne({ episodeId: episode.id });
      const t = now();
      const usable = cached && cached.sourceUrl === url && (cached.error ? t - cached.fetchedAt < RETRY_MS : t - cached.fetchedAt < FRESH_MS);
      if (usable && cached.chapters.length) return { source: 'json', chapters: cached.chapters };
      if (!usable) {
        const fetched = await this.fetchJson(episode, url);
        if (fetched.length) return { source: 'json', chapters: fetched };
      }
      // A failed or empty file falls through to the other sources.
    }
    if (episode.inlineChapters?.length) return { source: 'feed', chapters: episode.inlineChapters };
    const fromNotes = parseDescriptionChapters(episode.description);
    return fromNotes.length ? { source: 'description' as ChapterSource, chapters: fromNotes } : null;
  }

  private async fetchJson(episode: Episode, url: string): Promise<Chapter[]> {
    let chapters: Chapter[] = [];
    let error: string | null = null;
    try {
      const res = await safeFetchBuffer(url, { maxBytes: CHAPTERS_MAX_BYTES, timeoutMs: FETCH_TIMEOUT_MS, allowPrivate: this.config.allowPrivateNetworks });
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      else {
        chapters = parseChaptersJson(res.body.toString('utf8'));
        if (!chapters.length) error = 'No chapters in file';
      }
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : 'Fetch failed';
      this.log.warn({ err: e, episode: episode.id }, 'chapters fetch failed');
    }
    const row = { episodeId: episode.id, source: chapters.length ? ('json' as const) : null, sourceUrl: url, chapters, fetchedAt: now(), error };
    const existing = this.db.episodeChapters.findOne({ episodeId: episode.id });
    if (existing) Object.assign(existing, row), this.db.episodeChapters.saveQuiet(existing);
    else this.db.episodeChapters.insert({ id: episode.id, ...row });
    return chapters;
  }
}
