import { useSyncExternalStore } from 'react';

/** Minimal external store with a selector hook (avoids a state-management dependency). */
export class Store<T extends object> {
  private listeners = new Set<() => void>();
  constructor(private state: T) {}
  get = (): T => this.state;
  set(patch: Partial<T>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  use<S>(selector: (s: T) => S): S {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useSyncExternalStore(this.subscribe, () => selector(this.state));
  }
}
