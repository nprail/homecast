import type { TranscriptSegment } from '@homecast/shared';
import { toText } from '../util/html.js';

function clock(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(s.trim());
  if (!m) return null;
  const ms = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms;
}

function parseCues(text: string): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx]!.split('-->').map((s) => s.trim().split(/\s+/)[0] ?? '');
    const start = clock(a ?? '');
    const end = clock(b ?? '');
    const body = toText(lines.slice(idx + 1).join(' '), 2000);
    if (start !== null && end !== null && body) segs.push({ startMs: start, endMs: end, text: body });
  }
  return segs;
}

/** Parse a publisher transcript (WebVTT, SubRip, or Podcasting 2.0 JSON). Returns null if unsupported. */
export function parseTranscript(raw: string, contentType: string | null, url: string): TranscriptSegment[] | null {
  const type = (contentType ?? '').toLowerCase();
  const trimmed = raw.trim();
  let segs: TranscriptSegment[] = [];
  if (type.includes('json') || url.endsWith('.json') || trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as { segments?: { startTime?: number; endTime?: number; body?: string }[] };
      segs = (j.segments ?? [])
        .filter((s) => typeof s.startTime === 'number' && typeof s.body === 'string')
        .map((s) => ({ startMs: Math.round(s.startTime! * 1000), endMs: Math.round((s.endTime ?? s.startTime!) * 1000), text: toText(s.body!, 2000) }))
        .filter((s) => s.text);
    } catch {
      return null;
    }
  } else if (trimmed.startsWith('WEBVTT') || trimmed.includes('-->')) {
    segs = parseCues(trimmed.replace(/^WEBVTT[^\n]*\n/, ''));
  }
  segs.sort((a, b) => a.startMs - b.startMs);
  return segs.length ? segs : null;
}
