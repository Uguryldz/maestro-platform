import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { Session } from "../src/auth/types.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { ToastProvider } from "../src/ui/Toast.tsx";

export const ADMIN: Session = {
  userId: "ugur.yildiz@ugurbank.local",
  username: "ugur.yildiz",
  roles: ["admin"],
  groups: ["maestro-admins"],
  delegated: false,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

export const VIEWER: Session = { ...ADMIN, roles: ["viewer"], groups: [] };

/** An admin whose token is held by an AI on their behalf (M101). */
export const DELEGATED_ADMIN: Session = { ...ADMIN, delegated: true };

export interface Route {
  /** Matched against the request path with `endsWith` on the pathname. */
  readonly path: string;
  readonly method?: string;
  readonly status?: number;
  readonly body: unknown;
}

export interface FetchLogEntry {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

export interface StubFetch {
  readonly fetchImpl: typeof fetch;
  /** Every request the screen made, in order. */
  readonly calls: FetchLogEntry[];
}

/**
 * A fetch stub that answers a fixed route table and RECORDS every call, so a
 * test can assert both what was rendered and what was actually sent. Anything
 * unmatched answers 404 `not_found` rather than throwing, which is what the BFF
 * would do for an endpoint that does not exist yet.
 */
export function stubFetch(routes: readonly Route[]): StubFetch {
  const calls: FetchLogEntry[] = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const rawBody = init?.body;
    calls.push({
      url,
      method,
      body: typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : undefined,
    });

    const pathname = url.split("?")[0] ?? url;
    const match = routes.find(
      (route) => pathname.endsWith(route.path) && (route.method ?? "GET") === method,
    );
    if (match === undefined) {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    return new Response(JSON.stringify(match.body), { status: match.status ?? 200 });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

export function renderScreen(
  ui: ReactNode,
  options: {
    session?: Session;
    fetchImpl?: typeof fetch;
    locale?: "tr" | "en";
    /** Router entry, so a screen that reads `?id=` (e.g. the variant detail) has one. */
    initialEntries?: readonly string[];
  } = {},
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  render(
    <I18nProvider initialLocale={options.locale ?? "tr"}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider
          {...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})}
          initialSession={options.session ?? ADMIN}
          initialToken="test-token"
        >
          <ToastProvider>
            <MemoryRouter initialEntries={options.initialEntries ? [...options.initialEntries] : ["/"]}>
              {ui}
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
