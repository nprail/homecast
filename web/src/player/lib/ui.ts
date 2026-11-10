import { Store } from './store';

export type SheetName = 'speed' | 'sleep' | 'bookmark' | null;
interface UIState {
  /** The full Now Playing panel. */
  nowPlaying: boolean;
  transcript: boolean;
  sheet: SheetName;
  /** Episode whose action menu is open. */
  menuEpisodeId: string | null;
  /** Add-to-playlist picker for this episode. */
  playlistPickerFor: string | null;
  toast: string | null;
}

export const ui = new Store<UIState>({ nowPlaying: false, transcript: false, sheet: null, menuEpisodeId: null, playlistPickerFor: null, toast: null });
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(message: string) {
  ui.set({ toast: message });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.set({ toast: null }), 2600);
}
