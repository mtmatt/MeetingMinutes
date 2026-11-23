import { Navigate, Outlet, createBrowserRouter, useLocation } from "react-router";
import { Masthead } from "./components/Masthead";
import { Seal } from "./components/Seal";
import { useAuth } from "./lib/auth";
import { useLiveUpdates } from "./lib/useLiveUpdates";
import { InvitePage, LoginPage, SetupPage } from "./pages/Auth";
import { LibraryPage } from "./pages/Library";
import { NotFoundPage } from "./pages/NotFound";

/**
 * Pages other than the library and sign-in are separate downloads, fetched
 * when first needed: the library no longer waits for the Markdown renderer,
 * the recorder or the admin screens. import() is cached, so calling these
 * early (preloadPages) only starts the download sooner.
 */
const pages = {
  meeting: () => import("./pages/Meeting"),
  upload: () => import("./pages/Upload"),
  templates: () => import("./pages/Templates"),
  voices: () => import("./pages/Voices"),
  settings: () => import("./pages/Settings"),
  admin: () => import("./pages/Admin"),
};

/**
 * Starts the download of the page the address opens on, in parallel with the
 * app's own start-up, then, once the browser is idle, the meeting page, which
 * is usually next.
 */
export function preloadPages(pathname: string) {
  const first = pathname.startsWith("/m/")
    ? pages.meeting
    : pathname === "/new"
      ? pages.upload
      : ({ "/templates": pages.templates, "/voices": pages.voices, "/settings": pages.settings, "/admin": pages.admin } as Record<string, () => Promise<unknown>>)[pathname];
  first?.().catch(() => {});
  const later = () => void pages.meeting().catch(() => {});
  if ("requestIdleCallback" in window) window.requestIdleCallback(later, { timeout: 4000 });
  else setTimeout(later, 2000);
}

function Splash() {
  return (
    <div className="splash">
      <Seal size={44} className="splash-seal" />
    </div>
  );
}

function Protected() {
  const { user, needsSetup, loading } = useAuth();
  const location = useLocation();
  useLiveUpdates(!!user);
  if (loading) return <Splash />;
  if (needsSetup) return <Navigate to="/setup" replace />;
  if (!user) {
    const next = location.pathname + location.search;
    return <Navigate to={next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return (
    <>
      <Masthead />
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}

function AdminOnly() {
  const { user } = useAuth();
  if (user?.role !== "admin") return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Where to go after signing in: the page asked for (?next=), if it is one of ours. */
function nextPage(search: string): string {
  const next = new URLSearchParams(search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function PublicOnly() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Splash />;
  // Signing in sets the user before the sign-in form navigates, so this redirect
  // runs first: it must honour ?next= as well, or a shared meeting link lands on the library.
  if (user) return <Navigate to={nextPage(location.search)} replace />;
  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    element: <Protected />,
    children: [
      { path: "/", element: <LibraryPage /> },
      { path: "/new", lazy: async () => ({ Component: (await pages.upload()).UploadPage }) },
      { path: "/m/:id", lazy: async () => ({ Component: (await pages.meeting()).MeetingPage }) },
      { path: "/templates", lazy: async () => ({ Component: (await pages.templates()).TemplatesPage }) },
      { path: "/voices", lazy: async () => ({ Component: (await pages.voices()).VoicesPage }) },
      { path: "/settings", lazy: async () => ({ Component: (await pages.settings()).SettingsPage }) },
      { element: <AdminOnly />, children: [{ path: "/admin", lazy: async () => ({ Component: (await pages.admin()).AdminPage }) }] },
    ],
  },
  {
    element: <PublicOnly />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/setup", element: <SetupPage /> },
    ],
  },
  { path: "/invite/:token", element: <InvitePage /> },
  { path: "*", element: <NotFoundPage /> },
]);
