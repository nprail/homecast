import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Grip } from './picons';

/**
 * Reorderable list. The grip is the only drag handle (pointer events, so it works for touch and
 * mouse) and also responds to ArrowUp/ArrowDown for keyboard users.
 */
export function Sortable<T extends { id: string }>({ items, onMove, children, label = 'Reorder' }: { items: T[]; onMove: (from: number, to: number) => void; children: (item: T, index: number, handle: ReactNode) => ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);

  const indexAt = (y: number): number => {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-sort-row]') ?? []);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!.getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return rows.length - 1;
  };

  return (
    <div ref={ref}>
      {items.map((item, i) => {
        const key = (e: KeyboardEvent) => {
          if (e.key === 'ArrowUp' && i > 0) (e.preventDefault(), onMove(i, i - 1), requestAnimationFrame(() => (ref.current?.querySelectorAll<HTMLElement>('[data-grip]')[i - 1])?.focus()));
          if (e.key === 'ArrowDown' && i < items.length - 1) (e.preventDefault(), onMove(i, i + 1), requestAnimationFrame(() => (ref.current?.querySelectorAll<HTMLElement>('[data-grip]')[i + 1])?.focus()));
        };
        const handle = (
          <button
            data-grip
            aria-label={`${label}: ${i + 1} of ${items.length}. Drag, or use the up and down arrow keys`}
            onKeyDown={key}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setDrag({ from: i, over: i });
            }}
            onPointerMove={(e) => drag && setDrag({ from: drag.from, over: indexAt(e.clientY) })}
            onPointerUp={() => {
              if (drag && drag.over !== drag.from) onMove(drag.from, drag.over);
              setDrag(null);
            }}
            onPointerCancel={() => setDrag(null)}
            className="flex h-11 w-9 shrink-0 cursor-grab touch-none items-center justify-center border-0 bg-transparent text-p-muted active:cursor-grabbing"
          >
            <Grip size={20} />
          </button>
        );
        const over = drag && drag.over === i && drag.from !== i;
        return (
          <div key={item.id} data-sort-row className={`relative ${drag?.from === i ? 'opacity-50' : ''}`}>
            {over && <div className={`absolute right-0 left-0 h-0.5 bg-p-accent ${drag.over < drag.from ? '-top-px' : '-bottom-px'}`} />}
            {children(item, i, handle)}
          </div>
        );
      })}
    </div>
  );
}
