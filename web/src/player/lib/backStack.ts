import { useEffect, useRef } from 'react';

/**
 * Makes overlays (sheets, the Now Playing panel, the transcript) part of browser history, so the
 * system Back button / swipe closes the top overlay instead of leaving the page.
 *
 * Each open overlay pushes one history entry (keeping the router's `idx` so React Router stays in
 * sync). Back pops the entry and closes the overlay; closing from the UI pops the entry again.
 */
interface Layer {
  id: number;
  close: () => void;
}
interface HistState {
  layer?: number;
  idx?: number;
  [k: string]: unknown;
}

let seq = 0;
let stack: Layer[] = [];
let skipPops = 0;
let removed = new Set<number>();
let flushScheduled = false;
const state = (): HistState => (window.history.state ?? {}) as HistState;

function openLayer(close: () => void): number {
  const id = ++seq;
  const cur = state();
  window.history.pushState({ ...cur, layer: id, idx: (cur.idx ?? 0) + 1 }, '');
  stack.push({ id, close });
  return id;
}

/** Close an overlay from code: drop its history entry too (batched, so several close with one step back). */
function closeLayer(id: number): void {
  const i = stack.findIndex((l) => l.id === id);
  if (i < 0) return; // already closed by the Back button
  stack.splice(i, 1);
  removed.add(id);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    const ids = removed;
    removed = new Set();
    const newest = Math.max(...ids);
    // Only unwind history if we are still on the entries those overlays pushed (no navigation since).
    if (state().layer === newest) {
      skipPops++;
      window.history.go(-ids.size);
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (skipPops > 0) {
      skipPops--;
      return;
    }
    const top = stack[stack.length - 1];
    const st = state();
    if (top && st.layer !== top.id) {
      stack.pop();
      top.close();
    } else if (st.layer && !stack.some((l) => l.id === st.layer)) {
      // Landed on an overlay entry whose overlay is gone (e.g. the user navigated away from it): skip it.
      window.history.back();
    }
  });
}

/** While `active`, the overlay owns one history entry; Back calls `onClose`. */
export function useLayer(active: boolean, onClose: () => void): void {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!active) return;
    let id = 0;
    // Deferred so React StrictMode's mount/unmount/mount in development pushes only one entry.
    const t = setTimeout(() => {
      id = openLayer(() => cb.current());
    }, 0);
    return () => {
      clearTimeout(t);
      if (id) closeLayer(id);
    };
  }, [active]);
}
