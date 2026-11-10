import type { ReactNode, SVGProps } from 'react';

function Svg({ children, size = 18, ...rest }: { children: ReactNode; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}
type P = { size?: number };

export const OverviewIcon = (p: P) => (
  <Svg {...p}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></Svg>
);
export const UsersIcon = (p: P) => (<Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>);
export const FeedsIcon = (p: P) => (<Svg {...p}><path d="M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8" /><circle cx="6" cy="18" r="1.5" /></Svg>);
export const JobsIcon = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>);
export const UsageIcon = (p: P) => (<Svg {...p}><path d="M5 20V10M12 20V4M19 20v-7" /></Svg>);
export const ShieldIcon = (p: P) => (<Svg {...p}><path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z" /></Svg>);
export const SettingsIcon = (p: P) => (<Svg {...p}><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></Svg>);
export const BackIcon = (p: P) => (<Svg {...p}><path d="m15 6-6 6 6 6" /></Svg>);
export const PlusIcon = ({ size = 16 }: P) => (<Svg size={size} strokeWidth="2.6"><path d="M12 5v14M5 12h14" /></Svg>);
export const KebabIcon = ({ size = 20 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" /></svg>
);
export const CopyIcon = (p: P) => (<Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></Svg>);
export const MenuIcon = (p: P) => (<Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>);

/**
 * The Homecast mark ("waveform roof", logo/homecast-mark*.svg). `on="light"` is for light surfaces
 * (dark teal + dark amber), `on="dark"` for the player's dark theme (teal + amber).
 */
export function BrandMark({ size = 32, on = 'light' }: { size?: number; on?: 'light' | 'dark' }) {
  const wave = on === 'dark' ? '#4FD1C5' : '#0F766E';
  const floor = on === 'dark' ? '#F5B544' : '#B7791F';
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Homecast" className="shrink-0">
      <path d="M4 42H15L21 30L27 50L34 12L41 48L46 34L49 42H60" stroke={wave} />
      <path d="M14 56H50" stroke={floor} />
    </svg>
  );
}
