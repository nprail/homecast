import { useState } from 'react';
import type { PodcastRec } from '../lib/db';

const TILES = ['#123B3A', '#5A3A1E', '#2E3F6B', '#4A3566', '#1F4D3A'];
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Podcast artwork with a generated tile as fallback (offline, missing or broken images). */
export function Art({ podcast, size, radius = 10, className = '' }: { podcast?: Pick<PodcastRec, 'id' | 'title' | 'imageUrl'> | null; size: number; radius?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const bg = TILES[hash(podcast?.id ?? podcast?.title ?? '') % TILES.length]!;
  const style = { width: size, height: size, borderRadius: radius, background: bg };
  if (podcast?.imageUrl && !failed) {
    return <img src={podcast.imageUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={`shrink-0 object-cover ${className}`} style={style} />;
  }
  return (
    <div className={`flex shrink-0 items-center justify-center overflow-hidden ${className}`} style={style} aria-hidden="true">
      <svg width={size * 0.8} height={size * 0.8} viewBox="0 0 300 300" fill="none" stroke="#4FD1C5" strokeWidth="5" strokeLinecap="round">
        <circle cx="150" cy="150" r="46" opacity="0.9" />
        <circle cx="150" cy="150" r="82" opacity="0.55" />
        <circle cx="150" cy="150" r="118" opacity="0.3" />
        <path d="M40 150h38l14-34 22 70 22-96 20 120 14-60h90" stroke="#F5B544" strokeWidth="7" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
