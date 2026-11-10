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
