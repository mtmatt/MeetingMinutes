import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/fraunces/full-italic.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/pages.css";
import "./styles/meeting.css";
import "./styles/prose.css";
import "./styles/billing.css";
import "./styles/usage.css";
import "./styles/announcements.css";
import "./lib/theme";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { preloadPages, router } from "./App";
import { installImeGuard } from "./lib/imeGuard";
import { ConfirmProvider } from "./components/Modal";
import { OriginHandoff } from "./components/OriginHandoff";
import { ToastProvider } from "./components/Toast";
import { I18nProvider } from "./i18n";
import { AuthProvider } from "./lib/auth";
import { ApiError } from "./api/client";
import { prefetchPageData } from "./lib/prefetch";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

// Enter and Escape typed into an input method are not the page's.
installImeGuard();
preloadPages(window.location.pathname);
prefetchPageData(queryClient, window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ConfirmProvider>
            <AuthProvider>
              <OriginHandoff />
              <RouterProvider router={router} />
            </AuthProvider>
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
