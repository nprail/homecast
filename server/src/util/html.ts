import sanitizeHtml from 'sanitize-html';

/** Limited HTML for descriptions (spec §7: feed HTML is sanitized server-side). */
export function sanitizeDescription(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'a', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'blockquote'],
    allowedAttributes: { a: ['href', 'rel', 'target'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener noreferrer', target: '_blank' }, true) },
    disallowedTagsMode: 'discard',
  }).slice(0, 20000);
}

/** Plain text for titles and short fields. */
export function toText(html: string, max = 500): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
