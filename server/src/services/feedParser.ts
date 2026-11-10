import { XMLParser } from 'fast-xml-parser';
import { sanitizeDescription, toText } from '../util/html.js';

export interface ParsedEpisode {
  guid: string;
  title: string;
  description: string;
  audioUrl: string;
  mimeType: string;
  durationSec: number;
  releasedAt: number | null;
  transcriptUrl: string | null;
  transcriptType: string | null;
}
export interface ParsedFeed {
  title: string;
  author: string;
  description: string;
  imageUrl: string | null;
  episodes: ParsedEpisode[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  isArray: (name) => ['item', 'entry', 'enclosure', 'podcast:transcript', 'link', 'category'].includes(name),
});

type Node = Record<string, unknown> | string | number | undefined | null;

/** Text content of a parsed XML node (string, or `{ '#text': ... }`). */
function txt(n: unknown): string {
  if (n === undefined || n === null) return '';
  if (typeof n === 'string') return n;
  if (typeof n === 'number') return String(n);
  if (Array.isArray(n)) return txt(n[0]);
  if (typeof n === 'object') return txt((n as Record<string, unknown>)['#text']);
  return '';
}
const attr = (n: unknown, name: string): string => {
  const o = Array.isArray(n) ? n[0] : n;
  return o && typeof o === 'object' ? txt((o as Record<string, unknown>)[`@_${name}`]) : '';
};
const first = (n: unknown): Node => (Array.isArray(n) ? (n[0] as Node) : (n as Node));

export function parseDuration(v: string): number {
  const s = v.trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map((p) => Number(p));
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isFinite(p))) return 0;
  return Math.round(parts.reduce((acc, p) => acc * 60 + p, 0));
}

/**
 * Feeds without <itunes:duration> (e.g. Planning Center Publishing) get an estimate from the file
 * size, assuming 128 kbps for compressed audio. Clients replace it with the real value once the
 * audio metadata loads.
 */
export function estimateDuration(lengthBytes: string, mime: string): number {
  const n = Number(lengthBytes);
  if (!Number.isFinite(n) || n < 100_000 || !/^audio\/(mpeg|mp3|mp4|aac|x-m4a|m4a)/i.test(mime || 'audio/mpeg')) return 0;
  return Math.round((n * 8) / 128_000);
}

function parseDate(v: string): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const httpUrl = (u: string): string | null => {
  try {
    const p = new URL(u.trim());
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : null;
  } catch {
    return null;
  }
};

export function parseFeed(xml: string, maxEpisodes = 5000): ParsedFeed {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new Error('Feed is not valid XML');
  }
  const rss = doc.rss as Record<string, unknown> | undefined;
  const atom = doc.feed as Record<string, unknown> | undefined;
  if (rss?.channel) return parseRss(first(rss.channel) as Record<string, unknown>, maxEpisodes);
  if (atom) return parseAtom(atom, maxEpisodes);
  throw new Error('Not an RSS or Atom feed');
}

function parseRss(ch: Record<string, unknown>, max: number): ParsedFeed {
  const imageUrl =
    httpUrl(attr(ch['itunes:image'], 'href')) ?? httpUrl(txt((ch.image as Record<string, unknown> | undefined)?.url)) ?? null;
  const episodes: ParsedEpisode[] = [];
  for (const it of (ch.item as Record<string, unknown>[] | undefined) ?? []) {
    const enclosure = ((it.enclosure as unknown[] | undefined) ?? []).find((e) => httpUrl(attr(e, 'url')));
    const audioUrl = enclosure ? httpUrl(attr(enclosure, 'url')) : null;
    if (!audioUrl) continue;
    const title = toText(txt(it['itunes:title']) || txt(it.title), 300) || 'Untitled episode';
    const transcripts = ((it['podcast:transcript'] as unknown[] | undefined) ?? []).filter((t) => httpUrl(attr(t, 'url')));
    // Prefer machine-friendly formats.
    const rank = (t: unknown) => ['application/json', 'text/vtt', 'application/x-subrip', 'text/srt'].indexOf(attr(t, 'type'));
    const tr = [...transcripts].sort((a, b) => (rank(b) + 1 || 0) - (rank(a) + 1 || 0))[0];
    episodes.push({
      guid: txt(it.guid) || audioUrl,
      title,
      description: sanitizeDescription(txt(it['content:encoded']) || txt(it.description) || txt(it['itunes:summary'])),
      audioUrl,
      mimeType: attr(enclosure, 'type') || 'audio/mpeg',
      durationSec: parseDuration(txt(it['itunes:duration'])) || estimateDuration(attr(enclosure, 'length'), attr(enclosure, 'type')),
      releasedAt: parseDate(txt(it.pubDate) || txt(it['dc:date'])),
      transcriptUrl: tr ? httpUrl(attr(tr, 'url')) : null,
      transcriptType: tr ? attr(tr, 'type') || null : null,
    });
  }
  return {
    title: toText(txt(ch.title), 300) || 'Untitled podcast',
    author: toText(txt(ch['itunes:author']) || txt(ch.author) || txt(ch['dc:creator']), 200),
    description: toText(txt(ch['itunes:summary']) || txt(ch.description), 2000),
    imageUrl,
    episodes: dedupe(episodes).sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0)).slice(0, max),
  };
}

function parseAtom(feed: Record<string, unknown>, max: number): ParsedFeed {
  const episodes: ParsedEpisode[] = [];
  for (const e of (feed.entry as Record<string, unknown>[] | undefined) ?? []) {
    const links = (e.link as unknown[] | undefined) ?? [];
    const enc = links.find((l) => attr(l, 'rel') === 'enclosure' && httpUrl(attr(l, 'href')));
    const audioUrl = enc ? httpUrl(attr(enc, 'href')) : null;
    if (!audioUrl) continue;
    episodes.push({
      guid: txt(e.id) || audioUrl,
      title: toText(txt(e.title), 300) || 'Untitled episode',
      description: sanitizeDescription(txt(e.content) || txt(e.summary)),
      audioUrl,
      mimeType: attr(enc, 'type') || 'audio/mpeg',
      durationSec: parseDuration(txt(e['itunes:duration'])),
      releasedAt: parseDate(txt(e.published) || txt(e.updated)),
      transcriptUrl: null,
      transcriptType: null,
    });
  }
  const author = first(feed.author);
  return {
    title: toText(txt(feed.title), 300) || 'Untitled podcast',
    author: toText(typeof author === 'object' ? txt((author as Record<string, unknown>).name) : txt(author), 200),
    description: toText(txt(feed.subtitle), 2000),
    imageUrl: httpUrl(txt(feed.logo)),
    episodes: dedupe(episodes).slice(0, max),
  };
}

function dedupe(list: ParsedEpisode[]): ParsedEpisode[] {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.guid) ? false : (seen.add(e.guid), true)));
}

/** Heuristic for tokenized/credentialed feed URLs (spec §3.10): never listed in Discover. */
export function looksPrivateFeed(feedUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(feedUrl);
  } catch {
    return false;
  }
  if (u.username || u.password) return true;
  for (const k of u.searchParams.keys()) {
    if (/(token|key|auth|secret|sig|signature|pass|passwd|password|uid|user|member|subscriber|access|session)/i.test(k)) return true;
  }
  if (/(^|\.)(patreon\.com|supercast\.com|supportingcast\.fm|memberful\.com|steady\.fm|glow\.fm)$/i.test(u.hostname)) return true;
  return u.pathname.split('/').some((seg) => seg.length >= 28 && /^[A-Za-z0-9_-]+$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg));
}

/** URL safe to show to admins: private feeds have credentials and query stripped. */
export function redactFeedUrl(feedUrl: string, isPrivate: boolean): string {
  try {
    const u = new URL(feedUrl);
    if (!isPrivate && !u.username && !u.password) return feedUrl;
    return `${u.protocol}//${u.host}${u.pathname.length > 24 ? u.pathname.slice(0, 20) + '…' : u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return '(invalid url)';
  }
}

export function normalizeFeedUrl(raw: string): string {
  const u = new URL(raw.trim().replace(/^feed:\/\//i, 'http://').replace(/^itpc:\/\//i, 'http://').replace(/^pcast:\/\//i, 'http://'));
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  return u.toString();
}

