import { QueryClient } from "@tanstack/react-query";

/**
 * The shared TanStack Query client for the app.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /**
         * Retry only what a retry can actually fix.
         *
         * 401 clears the session and routes to /login; retrying would spam the
         * BFF with a dead token. 403 is a settled answer about authority.
         *
         * 404 and 501 are the same kind of settled: the route does not exist in
         * this build of the BFF, and asking twice more will not bring it into
         * being. Retrying them produced three identical console errors per
         * unbuilt screen, which trains an operator to ignore the console — and
         * the console is where a REAL fault has to be visible.
         *
         * 5xx and network failures are the transient cases, and those still
         * retry.
         */
        retry: (failureCount, error) => {
          const status = (error as { status?: number }).status;
          if (status === 401 || status === 403 || status === 404 || status === 501) return false;
          return failureCount < 2;
        },
        staleTime: 15_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}
