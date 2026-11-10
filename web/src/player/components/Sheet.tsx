import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useLayer } from '../lib/backStack';
import { useDesktop } from '../lib/hooks';

/**
 * Bottom sheet on mobile, centered dialog on desktop.
 * Traps focus, closes on Escape / scrim click.
 */
export function Sheet({ title, onClose, children, subtitle, badge, z = 60 }: { title: string; subtitle?: string; badge?: ReactNode; onClose: () => void; children: ReactNode; z?: number }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const desktop = useDesktop();
  useLayer(true, onClose);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button[data-autofocus]');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const a = f[0]!;
        const b = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === a) (e.preventDefault(), b.focus());
        else if (!e.shiftKey && document.activeElement === b) (e.preventDefault(), a.focus());
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className={`fixed inset-0 flex ${desktop ? 'items-center justify-center p-6' : 'items-end'} bg-black/60`} style={{ zIndex: z }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className={`max-h-[92vh] w-full overflow-y-auto border-p-line bg-[#1f232c] px-5 pt-3 pb-[calc(1.75rem+env(safe-area-inset-bottom))] text-p-text outline-none ${desktop ? 'max-w-md rounded-3xl border' : 'rounded-t-3xl border-t'}`}
      >
        {!desktop && <div className="mx-auto mb-4 h-1 w-10 rounded-sm bg-p-grip" />}
        <div className="flex items-center justify-between gap-3">
          <h2 id={id} className="m-0 font-display text-xl font-semibold">{title}</h2>
          {badge}
        </div>
        {subtitle && <div className="mt-1 truncate text-[13px] text-p-muted">{subtitle}</div>}
        {children}
      </div>
    </div>
  );
}

export const fieldCls = 'mt-1.5 box-border w-full rounded-xl border border-p-line bg-p-surface px-3.5 text-[15px] text-p-text placeholder:text-p-muted/60';
export const btnGhost = 'h-12 flex-1 rounded-xl border border-p-line bg-transparent text-[15px] font-medium text-p-text';
export const btnPrimary = 'h-12 flex-1 rounded-xl border-0 bg-p-accent text-[15px] font-semibold text-p-ink';
