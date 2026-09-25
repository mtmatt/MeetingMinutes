import { Navigate, Outlet, createBrowserRouter, useLocation } from "react-router";
import { Masthead } from "./components/Masthead";
import { Seal } from "./components/Seal";
import { useAuth } from "./lib/auth";
import { useLiveUpdates } from "./lib/useLiveUpdates";
import { AdminPage } from "./pages/Admin";
import { InvitePage, LoginPage, SetupPage } from "./pages/Auth";
import { LibraryPage } from "./pages/Library";
import { MeetingPage } from "./pages/Meeting";
import { NotFoundPage } from "./pages/NotFound";
import { SettingsPage } from "./pages/Settings";
import { TemplatesPage } from "./pages/Templates";
import { UploadPage } from "./pages/Upload";

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

function PublicOnly() {
  const { user, loading } = useAuth();
  if (loading) return <Splash />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    element: <Protected />,
    children: [
      { path: "/", element: <LibraryPage /> },
      { path: "/new", element: <UploadPage /> },
      { path: "/m/:id", element: <MeetingPage /> },
      { path: "/templates", element: <TemplatesPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { element: <AdminOnly />, children: [{ path: "/admin", element: <AdminPage /> }] },
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
