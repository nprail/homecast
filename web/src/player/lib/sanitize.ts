import { linkifyText } from '@homecast/shared';

const ALLOWED = new Set(['P', 'BR', 'A', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'BLOCKQUOTE']);

/**
 * Descriptions are already sanitized by the server (spec §7); this is a second pass so the client
 * never trusts a cached or tampered record: an allow-list walk over an inert DOM.
 */
export function safeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (!ALLOWED.has(child.tagName)) {
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const keep = child.tagName === 'A' && attr.name === 'href' && /^(https?:|mailto:)/i.test(attr.value);
        if (!keep) child.removeAttribute(attr.name);
      }
      if (child.tagName === 'A') {
        child.setAttribute('rel', 'nofollow noopener noreferrer');
        child.setAttribute('target', '_blank');
      }
      walk(child);
    }
  };
  // Scripts/styles must be dropped with their content, not unwrapped.
  doc.body.querySelectorAll('script,style,iframe,object,embed,template').forEach((n) => n.remove());
  walk(doc.body);
  return doc.body.innerHTML;
}

/**
 * Sanitized show notes with bare URLs made into links and timestamps made into jump buttons
 * (`<a data-t="ms">`, handled by the page). The rules are the shared ones in `@homecast/shared`.
 */
export function showNotesHtml(html: string, durationMs = 0, opts: { times?: boolean } = {}): string {
  const doc = new DOMParser().parseFromString(`<body>${safeHtml(html)}</body>`, 'text/html');
  const texts: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.parentElement && n.parentElement.closest('a'))) texts.push(n as Text);
  }
  for (const node of texts) {
    const segs = linkifyText(node.data, durationMs);
    if (segs.length === 1 && segs[0]!.type === 'text') continue;
    node.replaceWith(
      ...segs.map((s) => {
        if (s.type === 'text' || (s.type === 'time' && opts.times === false)) return doc.createTextNode(s.text);
        const a = doc.createElement('a');
        a.textContent = s.text;
        if (s.type === 'time') {
          a.setAttribute('href', `?t=${Math.floor(s.ms / 1000)}`);
          a.setAttribute('data-t', String(s.ms));
        } else {
          a.setAttribute('href', s.url);
          a.setAttribute('rel', 'nofollow noopener noreferrer');
          a.setAttribute('target', '_blank');
        }
        return a;
      }),
    );
  }
  return doc.body.innerHTML;
}
