import type { ReactNode } from 'react';

/** Shared page chrome: padded column, heading row. */
export function Page({ title, right, children, wide }: { title?: ReactNode; right?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto w-full px-5 pt-4 pb-8 md:px-10 md:pt-8 ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>
      {title !== undefined && (
        <div className="flex min-h-12 items-center justify-between gap-3">
          <h1 className="m-0 font-display text-[28px] font-bold">{title}</h1>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Pills<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-0.5 md:mx-0 md:flex-wrap md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden">
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)} className={`h-9 shrink-0 rounded-full px-3.5 text-sm whitespace-nowrap sm:px-4 ${o.value === value ? 'border-0 bg-p-accent font-semibold text-p-ink' : 'border border-p-line bg-transparent font-medium text-p-text'}`}>{o.label}</button>
      ))}
    </div>
  );
}

export function Segment<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex h-10 rounded-xl bg-p-surface p-1">
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)} className={`flex-1 rounded-[9px] border-0 text-sm ${o.value === value ? 'bg-p-line font-semibold text-p-text' : 'bg-transparent font-medium text-p-muted'}`}>{o.label}</button>
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="m-0 font-display text-lg font-semibold">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-sm text-sm text-p-muted">{children}</div>}
    </div>
  );
}

export const primaryBtn = 'inline-flex h-10 items-center justify-center gap-2 rounded-full border-0 bg-p-accent px-5 text-sm font-semibold text-p-ink no-underline disabled:opacity-60';
export const outlineBtn = 'inline-flex h-10 items-center justify-center gap-2 rounded-full border border-p-line bg-p-surface px-4 text-sm font-medium text-p-text no-underline disabled:opacity-60';

/** Themed on/off switch (dark player theme). */
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={`flex h-8 w-[52px] shrink-0 items-center rounded-2xl border-0 p-[3px] ${checked ? 'justify-end bg-p-accent' : 'justify-start bg-p-grip'}`}>
      <span className={`h-[26px] w-[26px] rounded-full ${checked ? 'bg-p-ink' : 'bg-p-text'}`} />
    </button>
  );
}
