import type { App } from '../AppData';

/** Lets non-React helpers reach the current app instance. Set by AppDataProvider consumers. */
let current: App | null = null;
export const setApp = (a: App | null) => (current = a);
export const openApp = (): App | null => current;
