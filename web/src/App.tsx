import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { AdminLayout } from './components/AdminLayout';
import { Loading } from './components/ui';
import { useAuth } from './lib/auth';
import { LoginPage, RegisterPage, ResetPasswordPage } from './pages/Auth';
import { AppDataProvider } from './player/AppData';
import { PlayerShell } from './player/components/Shell';
import { BookmarksPage } from './player/pages/Bookmarks';
import { DiscoverPage } from './player/pages/Discover';
import { DownloadsPage } from './player/pages/Downloads';
import { EpisodePage } from './player/pages/Episode';
import { LibraryPage } from './player/pages/Library';
import { PodcastPage } from './player/pages/Podcast';
import { ProfilePage } from './player/pages/Profile';
import { PlaylistPage, QueuePage, SmartPlaylistPage } from './player/pages/Queue';
import { SmartEditorPage } from './player/pages/SmartEditor';

// The admin dashboard is code-split so the player bundle stays small.
const lazyPage = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const OverviewPage = lazyPage(() => import('./pages/admin/Overview'), 'OverviewPage');
const UsersPage = lazyPage(() => import('./pages/admin/Users'), 'UsersPage');
const FeedsPage = lazyPage(() => import('./pages/admin/Feeds'), 'FeedsPage');
const JobsPage = lazyPage(() => import('./pages/admin/Jobs'), 'JobsPage');
const UsagePage = lazyPage(() => import('./pages/admin/Usage'), 'UsagePage');
const AuditPage = lazyPage(() => import('./pages/admin/Audit'), 'AuditPage');
const SettingsPage = lazyPage(() => import('./pages/admin/Settings'), 'SettingsPage');

function RequireAdmin() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (user.role !== 'admin')
    return (
      <div className="mx-auto max-w-md px-6 py-24 text-center">
        <h1 className="font-display text-2xl font-bold">Admins only</h1>
        <p className="mt-2 text-sm text-muted">Your account doesn't have access to the admin dashboard.</p>
      </div>
    );
  return (
    <Suspense fallback={<Loading />}>
      <AdminLayout />
    </Suspense>
  );
}

/** The player: only for signed-in users; opens the local-first database for that user. */
function RequireUser() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="flex h-dvh items-center justify-center bg-p-bg text-p-muted">Loading…</div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  return (
    <AppDataProvider>
      <AppReady />
    </AppDataProvider>
  );
}
import { useMaybeApp } from './player/AppData';
function AppReady() {
  const app = useMaybeApp();
  if (!app) return <div className="flex h-dvh items-center justify-center bg-p-bg text-p-muted">Opening your library…</div>;
  return <PlayerShell />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/admin" element={<RequireAdmin />}>
        <Route index element={<OverviewPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="feeds" element={<FeedsPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route element={<RequireUser />}>
        <Route index element={<LibraryPage />} />
        <Route path="podcast/:id" element={<PodcastPage />} />
        <Route path="episode/:id" element={<EpisodePage />} />
        <Route path="queue" element={<QueuePage />} />
        <Route path="playlist/:id" element={<PlaylistPage />} />
        <Route path="smart/new" element={<SmartEditorPage />} />
        <Route path="smart/:id" element={<SmartPlaylistPage />} />
        <Route path="smart/:id/edit" element={<SmartEditorPage />} />
        <Route path="discover" element={<DiscoverPage />} />
        <Route path="bookmarks" element={<BookmarksPage />} />
        <Route path="downloads" element={<DownloadsPage />} />
        <Route path="profile" element={<ProfilePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
