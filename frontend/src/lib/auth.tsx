import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api, setUnauthorizedHandler } from "../api/client";
import type { User } from "../api/types";
import { useI18n } from "../i18n";

interface AuthValue {
  user: User | null;
  needsSetup: boolean;
  loading: boolean;
  /** Administrator contact configured on the server (ADMIN_CONTACT), if any. */
  helpContact: string | null;
  /** Largest file the server accepts (MAX_UPLOAD_MB); null until known. */
  uploadLimitBytes: number | null;
  setUser: (u: User | null) => void;
}

type AuthState = Awaited<ReturnType<typeof api.authState>>;
const emptyState: AuthState = { needsSetup: false, user: null, helpContact: null, uploadLimitBytes: null };

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

  const value: AuthValue = {
    user,
    needsSetup: q.data?.needsSetup ?? false,
    loading: q.isLoading,
    helpContact: q.data?.helpContact ?? null,
    uploadLimitBytes: q.data?.uploadLimitBytes ?? null,
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
