import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { CopyIcon } from './icons';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="m-0 font-display text-[32px] leading-9 font-bold">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-muted">{subtitle}</div>}
      </div>
      {actions}
    </div>
  );
}

type Tone = 'ok' | 'bad' | 'warn' | 'neutral' | 'off' | 'brand';
const TONES: Record<Tone, string> = {
  ok: 'bg-ok-bg text-ok-fg',
  bad: 'bg-bad-bg text-bad-fg',
  warn: 'bg-warn-bg text-warn-fg',
  neutral: 'bg-neutral-bg text-ink-2',
  off: 'bg-off-bg text-ink-2',
  brand: 'bg-brand-chip text-brand',
};
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('inline-block h-6 rounded-xl px-2.5 text-xs leading-6 font-semibold whitespace-nowrap', TONES[tone])}>{children}</span>;
}

export function StatCard({ label, value, caption, captionTone, valueTone }: { label: string; value: ReactNode; caption?: ReactNode; captionTone?: 'bad'; valueTone?: 'bad' }) {
  return (
    <div className="min-w-[140px] flex-[1_1_140px] rounded-[14px] border border-line bg-white px-4 py-3 sm:min-w-[180px] sm:flex-[1_1_180px] sm:px-5 sm:py-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={cx('mt-1 font-display text-[28px] font-bold', valueTone === 'bad' && 'text-bad-fg')}>{value}</div>
      {caption !== undefined && <div className={cx('text-xs', captionTone === 'bad' ? 'text-bad-fg' : 'text-muted')}>{caption}</div>}
    </div>
  );
}

export function Card({ title, action, children, className, bodyClass }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('min-w-0 overflow-hidden rounded-[14px] border border-line bg-white', className)}>
      {title !== undefined && (
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="m-0 font-display text-lg font-semibold">{title}</h2>
          {action}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function CardNote({ children }: { children: ReactNode }) {
  return <div className="border-t border-line-2 px-5 py-3 text-[13px] text-muted">{children}</div>;
}

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'outlineBrand';
export function Button({ variant = 'secondary', small, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; small?: boolean }) {
  const base = small ? 'h-9 rounded-lg px-3.5 text-[13px]' : 'h-10 rounded-[10px] px-4 text-sm';
  const v = {
    primary: 'bg-brand text-white font-semibold border-0 hover:bg-brand-dark',
    secondary: 'bg-white text-ink font-medium border border-line-input hover:bg-page',
    danger: 'bg-white text-bad-fg font-medium border border-line-input hover:bg-bad-bg/40',
    outlineBrand: 'bg-white text-brand font-semibold border border-brand hover:bg-brand-soft',
  }[variant];
  return <button className={cx('inline-flex items-center justify-center gap-2 whitespace-nowrap', base, v, className)} {...rest} />;
}

export function Segmented<T extends string>({ value, options, onChange, label, small }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; small?: boolean }) {
  return (
    <div role="group" aria-label={label} className={cx('box-border flex rounded-[10px] bg-off-bg p-[3px]', small ? 'h-9' : 'h-10')}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)} className={cx('rounded-lg border-0 px-3 text-sm whitespace-nowrap sm:px-4', small && 'px-3 text-[13px] sm:px-3.5', o.value === value ? 'bg-white font-semibold text-ink' : 'bg-transparent font-medium text-ink-2')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** `stack`: below the md breakpoint each row becomes a card (cells need `data-label`). */
export function Table({ children, className, stack }: { children: ReactNode; className?: string; stack?: boolean }) {
  return (
    <div className="relative overflow-x-auto">
      <table className={cx('w-full border-collapse text-sm', stack && 'stack-table', className)}>{children}</table>
    </div>
  );
}
export function Th({ children, className, srOnly, align }: { children?: ReactNode; className?: string; srOnly?: boolean; align?: 'right' }) {
  return (
    <th scope="col" className={cx('px-2 py-3 text-xs font-semibold tracking-[0.05em] whitespace-nowrap uppercase first:pl-5 last:pr-5', align === 'right' ? 'text-right' : 'text-left', className)}>
      {srOnly ? <span className="sr-only-cell">{children}</span> : children}
    </th>
  );
}
export const Thead = ({ children }: { children: ReactNode }) => (
  <thead>
    <tr className="text-left text-muted">{children}</tr>
  </thead>
);

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className={cx('rounded-[10px] bg-bad-bg px-4 py-3 text-sm text-bad-fg', className)}>
      {msg}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="px-5 py-10 text-center text-sm text-muted">
      {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-5 py-10 text-center text-sm text-muted">{children}</div>;
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className={cx('max-h-[90vh] w-full overflow-auto rounded-2xl border border-line bg-white shadow-[0_16px_48px_rgba(20,23,28,0.2)] outline-none', wide ? 'max-w-xl' : 'max-w-md')}>
        <div className="border-b border-line px-6 py-4">
          <h2 id={id} className="m-0 font-display text-lg font-semibold">
            {title}
          </h2>
        </div>
        <div className="px-6 py-5 text-sm">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 text-[13px] font-medium text-ink-2">{label}</div>
      <div className="flex items-center gap-2">
        <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} className="h-10 min-w-0 flex-1 rounded-[10px] border border-line-input bg-page px-3 font-mono text-[13px]" />
        <Button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <CopyIcon size={16} />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children(id)}
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export const inputCls = 'h-10 w-full rounded-[10px] border border-line-input bg-white px-3 text-sm text-ink placeholder:text-muted/70';

/** Click-outside + Escape handling for popovers. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={cx('relative h-6 w-11 shrink-0 rounded-full border-0 transition-colors', checked ? 'bg-brand' : 'bg-line-input')}>
      <span className={cx('absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
    </button>
  );
}
