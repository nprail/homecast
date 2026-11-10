import type { ReactNode, SVGProps } from 'react';

type P = { size?: number; className?: string; fill?: string };
function S({ size = 24, className, children, sw = 2, fill = 'none' }: P & { children: ReactNode; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {children}
    </svg>
  );
}
export const ChevronDown = (p: P) => (<S {...p}><path d="m6 9 6 6 6-6" /></S>);
export const ChevronRight = (p: P) => (<S {...p}><path d="m9 6 6 6-6 6" /></S>);
export const ChevronLeft = (p: P) => (<S {...p}><path d="m15 6-6 6 6 6" /></S>);
export const MoreH = ({ size = 24 }: P) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>);
export const MoreV = ({ size = 24 }: P) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" /></svg>);
export const PlayIcon = ({ size = 24 }: P) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>);
export const PauseIcon = ({ size = 24 }: P) => (<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></svg>);
export function Skip({ dir, secs, size = 38 }: { dir: 'back' | 'fwd'; secs: number; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === 'back' ? (<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>) : (<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></>)}
      <text x="12" y="15.4" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none" fontFamily="Inter, sans-serif">{secs}</text>
    </svg>
  );
}
export const Moon = (p: P) => (<S {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></S>);
export const Bookmark = (p: P) => (<S {...p}><path d="M6 4h12v17l-6-4-6 4z" /></S>);
export const BookmarkFilled = ({ size = 24 }: P) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M6 4h12v17l-6-4-6 4z" /></svg>);
export const Lines = (p: P) => (<S {...p}><path d="M4 6h16M4 12h16M4 18h10" /></S>);
export const CheckCircle = (p: P) => (<S {...p}><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></S>);
export const Download = (p: P) => (<S {...p}><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></S>);
export const Grip = (p: P) => (<S {...p}><path d="M5 9h14M5 15h14" /></S>);
export const Trash = (p: P) => (<S {...p}><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></S>);
export const Close = (p: P) => (<S {...p}><path d="M6 6l12 12M18 6 6 18" /></S>);
export const Plus = (p: P) => (<S {...p} sw={2.4}><path d="M12 5v14M5 12h14" /></S>);
export const Search = (p: P) => (<S {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></S>);
export const Star = (p: P) => (<S {...p}><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></S>);
export const StarFilled = ({ size = 24 }: P) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></svg>);
export const Mic = (p: P) => (<S {...p}><circle cx="12" cy="12" r="3" /><path d="M5 12a7 7 0 0 1 14 0M2 12a10 10 0 0 1 20 0" /></S>);
export const Compass = (p: P) => (<S {...p}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></S>);
export const User = (p: P) => (<S {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></S>);
export const Queue = (p: P) => (<S {...p}><path d="M4 6h16M4 12h16M4 18h8M16 16l4 2-4 2z" /></S>);
export const ListIcon = (p: P) => (<S {...p}><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></S>);
export const Shield = (p: P) => (<S {...p}><path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z" /></S>);
export const Sparkle = (p: P) => (<S {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></S>);
export const Check = (p: P) => (<S {...p} sw={2.6}><path d="m5 12 5 5 9-10" /></S>);
export const Refresh = (p: P) => (<S {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></S>);
export const Cloud = (p: P) => (<S {...p}><path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9.5 4 4 0 0 1 17 18z" /></S>);
export const CloudOff = (p: P) => (<S {...p}><path d="M3 3l18 18M7 18a4 4 0 0 1-.5-8 6 6 0 0 1 2-2.7M18 18a4 4 0 0 0 .5-7.9A6 6 0 0 0 12.6 5" /></S>);
export function ChevronUpDown({ size = 18 }: P) {
  return (<S size={size}><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></S>);
}
export type IconProps = SVGProps<SVGSVGElement>;
