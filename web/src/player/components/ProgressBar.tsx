import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clock } from '../lib/format';

/** Seek bar with bookmark ticks (amber). Pointer + keyboard accessible. */
export function ProgressBar({ positionMs, durationMs, markers = [], onSeek, compact, label = 'Seek' }: { positionMs: number; durationMs: number; markers?: number[]; onSeek: (ms: number) => void; compact?: boolean; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const dur = Math.max(1, durationMs);
  const shown = drag ?? positionMs;
  const pct = Math.min(100, (shown / dur) * 100);
  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur;
  };
  const h = compact ? 16 : 20;
  const track = compact ? { top: 5, height: 6 } : { top: 7, height: 6 };
  const knob = compact ? 14 : 16;
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 30_000 : 5_000;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') (e.preventDefault(), onSeek(positionMs + step));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') (e.preventDefault(), onSeek(positionMs - step));
    else if (e.key === 'Home') (e.preventDefault(), onSeek(0));
    else if (e.key === 'End') (e.preventDefault(), onSeek(dur));
  };
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(dur / 1000)}
      aria-valuenow={Math.round(shown / 1000)}
      aria-valuetext={`${clock(shown)} of ${clock(dur)}`}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(at(e));
      }}
      onPointerMove={(e) => drag !== null && setDrag(at(e))}
      onPointerUp={(e) => {
        onSeek(at(e));
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      className="relative w-full cursor-pointer touch-none select-none"
      style={{ height: h }}
    >
      <div className="absolute right-0 left-0 rounded-[3px] bg-p-line" style={track} />
      <div className="absolute left-0 rounded-[3px] bg-p-accent" style={{ ...track, width: `${pct}%` }} />
      {markers.map((m, i) => (
        <div key={`${m}-${i}`} className="absolute w-[3px] rounded-sm bg-p-amber" style={{ left: `${Math.min(100, (m / dur) * 100)}%`, top: compact ? 2 : 3, height: compact ? 12 : 14 }} />
      ))}
      <div className="absolute rounded-full bg-p-text" style={{ left: `calc(${pct}% - ${knob / 2}px)`, top: compact ? 1 : 2, width: knob, height: knob }} />
    </div>
  );
}
