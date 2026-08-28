import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { BrowserRouter } from "react-router";
import { AuthProvider } from "../auth/AuthProvider.tsx";
import { I18nProvider } from "../i18n/I18nProvider.tsx";
import { makeQueryClient } from "../lib/query-client.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { AppRoutes } from "./routes.tsx";
import "../ui/tokens.css";

/**
 * Provider stack, outermost first:
 *   ErrorBoundary  — turns a missing catalog key into a visible panel
 *   I18n           — locale + t()
 *   QueryClient    — server cache
 *   Auth           — session + the ApiClient every screen uses
 *   Toast          — notifications
 *   Router         — routes
 * Auth sits inside QueryClient because a 401 must be able to clear cached
 * queries, and inside I18n because the login screen is translated.
 */
export interface AppProps {
  readonly queryClient?: QueryClient;
}

export function App({ queryClient }: AppProps = {}): ReactNode {
  const client = queryClient ?? makeQueryClient();
  return (
    <ErrorBoundary>
      <I18nProvider>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <ToastProvider>
              <BrowserRouter>
                <AppRoutes />
              </BrowserRouter>
            </ToastProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}
