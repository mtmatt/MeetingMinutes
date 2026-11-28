import { Navigate, Outlet, createBrowserRouter, useLocation } from "react-router";
import { AnnouncementBanners } from "./components/Announcements";
import { Masthead } from "./components/Masthead";
import { Seal } from "./components/Seal";
import { RouteError } from "./components/RouteError";
import { useAuth } from "./lib/auth";
import { useLiveUpdates } from "./lib/useLiveUpdates";
import { ForgotPasswordPage, InvitePage, LoginPage, RegisterPage, SetupPage, VerifyEmailPage } from "./pages/Auth";
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
  glossaries: () => import("./pages/Glossaries"),
  voices: () => import("./pages/Voices"),
  settings: () => import("./pages/Settings"),
  admin: () => import("./pages/Admin"),
  billing: () => import("./pages/Billing"),
  terms: () => import("./pages/Terms"),
  pricing: () => import("./pages/Pricing"),
  usage: () => import("./pages/Usage"),
  announcements: () => import("./pages/Announcements"),
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
      : ({ "/templates": pages.templates, "/glossaries": pages.glossaries, "/voices": pages.voices, "/settings": pages.settings, "/admin": pages.admin, "/billing": pages.billing, "/usage": pages.usage } as Record<string, () => Promise<unknown>>)[pathname];
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
      <AnnouncementBanners />
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
    // Any page that fails to load or render: after an update, a reload into the new version.
    errorElement: <RouteError />,
    children: [
    {
      element: <Protected />,
      children: [
        { path: "/", element: <LibraryPage /> },
        { path: "/new", lazy: async () => ({ Component: (await pages.upload()).UploadPage }) },
        { path: "/m/:id", lazy: async () => ({ Component: (await pages.meeting()).MeetingPage }) },
        { path: "/templates", lazy: async () => ({ Component: (await pages.templates()).TemplatesPage }) },
        { path: "/glossaries", lazy: async () => ({ Component: (await pages.glossaries()).GlossariesPage }) },
        { path: "/voices", lazy: async () => ({ Component: (await pages.voices()).VoicesPage }) },
        { path: "/settings", lazy: async () => ({ Component: (await pages.settings()).SettingsPage }) },
        { path: "/billing", lazy: async () => ({ Component: (await pages.billing()).BillingPage }) },
        { path: "/usage", lazy: async () => ({ Component: (await pages.usage()).UsagePage }) },
        { path: "/announcements", lazy: async () => ({ Component: (await pages.announcements()).AnnouncementsPage }) },
        { element: <AdminOnly />, children: [{ path: "/admin", lazy: async () => ({ Component: (await pages.admin()).AdminPage }) }] },
      ],
    },
    {
      element: <PublicOnly />,
      children: [
        { path: "/login", element: <LoginPage /> },
        { path: "/setup", element: <SetupPage /> },
        { path: "/register", element: <RegisterPage /> },
        { path: "/forgot", element: <ForgotPasswordPage /> },
      ],
    },
    { path: "/invite/:token", element: <InvitePage /> },
    // Opened from an email, signed in or not (it may confirm a changed address).
    { path: "/verify-email/:token", element: <VerifyEmailPage /> },
    // The terms of sale: for anyone, signed in or not (buyers, and payment providers reviewing the site).
    { path: "/terms", lazy: async () => ({ Component: (await pages.terms()).TermsPage }) },
    // What is sold and for how much (NT$): for anyone, signed in or not.
    { path: "/pricing", lazy: async () => ({ Component: (await pages.pricing()).PricingPage }) },
    { path: "*", element: <NotFoundPage /> },
  ],
  },
]);
