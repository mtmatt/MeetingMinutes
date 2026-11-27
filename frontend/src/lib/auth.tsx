import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api, setUnauthorizedHandler } from "../api/client";
import type { MediaPolicy, SummarizerInfo, TranscriberInfo, User } from "../api/types";
import { useI18n } from "../i18n";
import { currentTheme, isThemePref, setTheme, setThemePersister } from "./theme";

interface AuthValue {
  user: User | null;
  needsSetup: boolean;
  loading: boolean;
  /** Administrator contact configured on the server (ADMIN_CONTACT), if any. */
  helpContact: string | null;
  /** Largest file the server accepts (MAX_UPLOAD_MB); null until known. */
  uploadLimitBytes: number | null;
  /** Google OAuth client ID (GOOGLE_CLIENT_ID) for exporting straight to Google Docs; null when not set up. */
  googleClientId: string | null;
  /** Which model writes summaries (and so where a transcript goes); null until signed in. */
  summarizer: SummarizerInfo | null;
  /** Where recordings are transcribed (this server, or a transcription API); null until signed in. */
  transcriber: TranscriberInfo | null;
  /** Whether originals are later kept as audio only; null until signed in. */
  mediaPolicy: MediaPolicy | null;
  /** Recordings may be processed on other machines an administrator connected. */
  externalWorkers: boolean;
  /** The site's address; a page opened at an earlier one moves there. */
  siteOrigin: string | null;
  /** People may create their own accounts. */
  registration: boolean;
  /** "Forgot password" emails a link (else: ask the administrator). */
  passwordReset: boolean;
  /** The terms of sale: "/terms" on this site, an outside address, or null. */
  termsUrl: string | null;
  setUser: (u: User | null) => void;
}

type AuthState = Awaited<ReturnType<typeof api.authState>>;
const emptyState: AuthState = { needsSetup: false, user: null, helpContact: null, uploadLimitBytes: null, googleClientId: null, summarizer: null, transcriber: null, mediaPolicy: null, externalWorkers: null };

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { setLocale } = useI18n();
  const q = useQuery({ queryKey: ["auth"], queryFn: api.authState, staleTime: 60_000, retry: 1 });

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(["auth"], (old: AuthState | undefined) => ({ ...emptyState, ...old, user: null }));
    });
  }, [qc]);

  const user = q.data?.user ?? null;
  useEffect(() => {
    if (user?.locale) setLocale(user.locale);
  }, [user?.locale, setLocale]);

  // The new interface is a preview a person turns on in Settings: its styles apply under <html data-ui="next">.
  useEffect(() => {
    if (user?.newUi) document.documentElement.dataset.ui = "next";
    else delete document.documentElement.dataset.ui;
  }, [user?.newUi]);

  // The theme follows the account: its saved choice applies here, and a choice made here is saved to it.
  const signedIn = !!user;
  useEffect(() => {
    if (isThemePref(user?.theme)) setTheme(user.theme, false);
  }, [user?.theme]);
  useEffect(() => {
    if (!signedIn) return setThemePersister(null);
    setThemePersister((theme) => {
      void api.updateMe({ theme }).then(
        ({ user: u }) => qc.setQueryData(["auth"], (old: AuthState | undefined) => (old ? { ...old, user: u } : old)),
        () => undefined,
      );
    });
    return () => setThemePersister(null);
  }, [signedIn, qc]);
  // An account from before themes were kept with it: this browser's choice becomes the account's.
  const themeUnset = signedIn && user?.theme == null;
  useEffect(() => {
    if (themeUnset && currentTheme() !== "system") setTheme(currentTheme());
  }, [themeUnset]);

  const value: AuthValue = {
    user,
    needsSetup: q.data?.needsSetup ?? false,
    loading: q.isLoading,
    helpContact: q.data?.helpContact ?? null,
    uploadLimitBytes: q.data?.uploadLimitBytes ?? null,
    googleClientId: q.data?.googleClientId ?? null,
    summarizer: q.data?.summarizer ?? null,
    transcriber: q.data?.transcriber ?? null,
    mediaPolicy: q.data?.mediaPolicy ?? null,
    externalWorkers: !!q.data?.externalWorkers,
    siteOrigin: q.data?.siteOrigin ?? null,
    registration: !!q.data?.registration,
    passwordReset: !!q.data?.passwordReset,
    termsUrl: q.data?.termsUrl ?? null,
    setUser: (u) => {
      qc.setQueryData(["auth"], (old: AuthState | undefined) => ({ ...emptyState, ...old, needsSetup: false, user: u }));
      if (!u) qc.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" });
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth outside provider");
  return v;
}
