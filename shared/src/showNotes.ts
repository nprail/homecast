/**
 * Show notes: finding links and timestamps. Every client uses these rules so a "12:30" or a URL
 * behaves the same everywhere (vectors: shared/vectors/show-notes.json, run by the native tests too).
 */
export type NoteSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'time'; text: string; ms: number };

// A web address, or a timestamp ([h:]m:ss) that is not part of a longer word or number, not a time
// of day ("8:30 PM") and not inside a URL (the URL alternative wins because it starts first).
const TOKEN = /(?:https?:\/\/|www\.)[^\s<>"']+|(?<![\w:/.])(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)(?![\w:])(?!\s?[AaPp]\.?[Mm])/g;

function trimUrl(raw: string): string {
  let u = raw;
  for (;;) {
    const last = u[u.length - 1];
    if (last && '.,;:!?\'"'.includes(last)) u = u.slice(0, -1);
    else if (last === ')' && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
    else if (last === ']' && (u.match(/\[/g)?.length ?? 0) < (u.match(/\]/g)?.length ?? 0)) u = u.slice(0, -1);
    else return u;
  }
}

/** Splits plain text into text, link and timestamp segments. Timestamps past `durationMs` (when known) stay text. */
export function linkifyText(text: string, durationMs = 0): NoteSegment[] {
  const out: NoteSegment[] = [];
  let last = 0;
  const push = (s: NoteSegment) => {
    const prev = out[out.length - 1];
    if (s.type === 'text' && prev?.type === 'text') prev.text += s.text;
    else if (s.text) out.push(s);
  };
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    let raw = m[0];
    let seg: NoteSegment;
    if (m[2] === undefined) {
      raw = trimUrl(raw);
      if (raw.length < 8) continue;
      seg = { type: 'link', text: raw, url: raw.startsWith('www.') ? `https://${raw}` : raw };
    } else {
      const ms = ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
      if (durationMs > 0 && ms > durationMs) continue;
      seg = { type: 'time', text: raw, ms };
    }
    push({ type: 'text', text: text.slice(last, start) });
    push(seg);
    last = start + raw.length;
  }
  push({ type: 'text', text: text.slice(last) });
  return out;
}

const ENTITIES: Array<[string, string]> = [['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&apos;', "'"], ['&nbsp;', ' '], ['&amp;', '&']];

function plain(html: string): string {
  let s = html.replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n').replace(/<[^>]+>/g, '');
  for (const [k, v] of ENTITIES) s = s.split(k).join(v);
  return s.replace(/\n{3,}/g, '\n\n');
}

/**
 * Show notes HTML to segments, as plain text: tags are dropped, `<a href>` becomes a link (http, https
 * and mailto only), and bare URLs and timestamps in the rest are found by `linkifyText`.
 */
export function parseShowNotes(html: string, durationMs = 0): NoteSegment[] {
  const out: NoteSegment[] = [];
  const add = (segs: NoteSegment[]) => {
    for (const s of segs) {
      const prev = out[out.length - 1];
      if (s.type === 'text' && prev?.type === 'text') prev.text += s.text;
      else out.push(s);
    }
  };
  let last = 0;
  for (const m of html.matchAll(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
    add(linkifyText(plain(html.slice(last, m.index)), durationMs));
    const url = plain(m[1] ?? m[2] ?? '').trim();
    const label = plain(m[3] ?? '').trim();
    if (/^(https?:|mailto:)/i.test(url)) add([{ type: 'link', text: label || url, url }]);
    else add(linkifyText(label, durationMs));
    last = (m.index ?? 0) + m[0].length;
  }
  add(linkifyText(plain(html.slice(last)), durationMs));
  const first = out[0];
  if (first?.type === 'text') first.text = first.text.trimStart();
  const end = out[out.length - 1];
  if (end?.type === 'text') end.text = end.text.trimEnd();
  return out.filter((s) => s.text !== '');
}
