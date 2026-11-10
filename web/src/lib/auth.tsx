import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { UserDto } from '@homecast/shared';
import { useQueryClient } from '@tanstack/react-query';
import * as api from './api';

interface AuthState {
  user: UserDto | null;
  /** True until the first session restore attempt finishes. */
  loading: boolean;
  signIn: (username: string, password: string) => Promise<UserDto>;
  signUp: (input: { username: string; password: string; inviteCode?: string; bootstrapToken?: string }) => Promise<UserDto>;
  signOut: () => Promise<void>;
}

const LAST_KEY = 'homecast.lastUser';
function readLastUser(): UserDto | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null') as UserDto | null;
    return v?.id && v.username ? v : null;
  } catch {
    return null;
  }
}
const writeLastUser = (u: UserDto) => {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(u));
  } catch {
    /* storage unavailable */
  }
};
const clearLastUser = () => {
  try {
    localStorage.removeItem(LAST_KEY);
  } catch {
    /* storage unavailable */
  }
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    let live = true;
    api.setSessionLostHandler(() => {
      clearLastUser();
      setUser(null);
      qc.clear();
    });
    const restore = () =>
      api.refreshSession().then((r) => {
        if (!live) return;
        if (r === 'offline') {
          // Local-first: keep working from the local database with the last known user.
          const last = readLastUser();
          if (last) setUser((u) => u ?? last);
        } else {
          setUser(r?.user ?? null);
          if (r?.user) writeLastUser(r.user);
          else clearLastUser();
        }
        setLoading(false);
      });
    void restore();
    // Back online after starting offline: obtain an access token so sync can resume.
    const onOnline = () => {
      if (!api.hasAccessToken()) void restore();
    };
    window.addEventListener('online', onOnline);
    return () => {
      live = false;
      window.removeEventListener('online', onOnline);
      api.setSessionLostHandler(null);
    };
  }, [qc]);

  const signIn = useCallback(async (username: string, password: string) => {
    const r = await api.login(username, password);
    writeLastUser(r.user);
    setUser(r.user);
    return r.user;
  }, []);
  const signUp = useCallback(async (input: Parameters<AuthState['signUp']>[0]) => {
    const r = await api.register(input);
    writeLastUser(r.user);
    setUser(r.user);
    return r.user;
  }, []);
  const signOut = useCallback(async () => {
    await api.logout();
    clearLastUser();
    setUser(null);
    qc.clear();
  }, [qc]);

  const value = useMemo(() => ({ user, loading, signIn, signUp, signOut }), [user, loading, signIn, signUp, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
