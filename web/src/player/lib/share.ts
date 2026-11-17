import { clock } from './format';
import { toast } from './ui';

/** Link that opens an episode in this server's web player, at a moment if one is given. */
export function momentUrl(episodeId: string, positionMs?: number): string {
  const t = positionMs && positionMs >= 1000 ? `?t=${Math.floor(positionMs / 1000)}` : '';
  return `${location.origin}/episode/${episodeId}${t}`;
}

/** Seconds from a `?t=` value ("754", or "12:34"), or null. */
export function parseMomentTime(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d{1,6}$/.test(raw)) return Number(raw);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(raw);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export interface MomentInfo {
  episodeId: string;
  title: string;
  podcastTitle?: string;
  positionMs?: number;
  /** A line from the transcript to quote. */
  quote?: string;
}

/** The text that goes with the link: a quote if there is one, then where it is from. */
export function momentText(m: MomentInfo): string {
  const at = m.positionMs && m.positionMs >= 1000 ? ` (${clock(m.positionMs)})` : '';
  const from = `${m.title}${m.podcastTitle ? `, ${m.podcastTitle}` : ''}${at}`;
  const quote = m.quote?.trim();
  return `${quote ? `“${quote.slice(0, 280)}” — ` : ''}${from}\n${momentUrl(m.episodeId, m.positionMs)}`;
}

/** Copy text when the Clipboard API isn't available (a LAN `http://` origin isn't a secure context). */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      el.remove();
    }
  }
}

/** Open the system share sheet, or copy the message when there isn't one. */
export async function shareMoment(m: MomentInfo): Promise<void> {
  const text = momentText(m);
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: m.title, text });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // the person closed the sheet
    }
  }
  toast((await copy(text)) ? 'Link copied' : 'Could not copy the link');
}
