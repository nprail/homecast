import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { setApp as setAppRef } from './lib/appRef';
import { LocalData } from './lib/data';
import { PodDB } from './lib/db';
import { DownloadManager } from './lib/downloads';
import { Player } from './lib/player';
import { SyncEngine, type SyncStatus } from './lib/sync';

export interface App {
  db: PodDB;
  data: LocalData;
  sync: SyncEngine;
  downloads: DownloadManager;
  player: Player;
}

const Ctx = createContext<App | null>(null);

/** Opens the signed-in user's local database and wires sync, downloads and the audio engine. */
export function AppDataProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [app, setApp] = useState<App | null>(null);
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return;
    const db = new PodDB(userId);
    const sync = new SyncEngine(db);
    const data = new LocalData(db, sync);
    const downloads = new DownloadManager(data);
    const player = new Player(data, downloads);
    sync.onMerged = () => {
      void player.refreshSpeed();
      void downloads.cleanup().then(() => downloads.runAutoDownloads());
    };
    sync.start();
    void player.restore();
    const instance = { db, data, sync, downloads, player };
    setAppRef(instance);
    setApp(instance);
    return () => {
      setAppRef(null);
      sync.dispose();
      player.dispose();
      db.close();
      setApp(null);
    };
  }, [userId]);

  return <Ctx.Provider value={app}>{children}</Ctx.Provider>;
}

export function useApp(): App {
  const a = useContext(Ctx);
  if (!a) throw new Error('useApp outside AppDataProvider');
  return a;
}
export const useMaybeApp = (): App | null => useContext(Ctx);

export function useSyncStatus(): SyncStatus {
  const { sync } = useApp();
  return useSyncExternalStore(sync.subscribe, sync.getSnapshot);
}

export function useMemoApp<T>(fn: (a: App) => T): T {
  const a = useApp();
  return useMemo(() => fn(a), [a, fn]);
}
