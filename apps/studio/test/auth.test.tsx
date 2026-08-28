import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../src/app/routes.tsx";
import type { AuthStatus } from "../src/auth/AuthProvider.tsx";
import { AuthProvider, useAuth } from "../src/auth/AuthProvider.tsx";
import type { Session } from "../src/auth/types.ts";
import { hasAnyRole, hasRole, sessionFromLogin } from "../src/auth/types.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { ToastProvider } from "../src/ui/Toast.tsx";

const SESSION: Session = {
  userId: "ayse.kaya@ugurbank.local",
  username: "ayse.kaya",
  roles: ["tech-lead"],
  groups: ["maestro-ugurpay"],
  delegated: false,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function renderApp(options: {
  route?: string;
  session?: Session | null;
  token?: string | null;
  fetchImpl?: typeof fetch;
}): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const fetchImpl =
    options.fetchImpl ??
    ((async () => new Response(JSON.stringify({ level: "off" }), { status: 200 })) as typeof fetch);

  render(
    <I18nProvider initialLocale="tr">
      <QueryClientProvider client={queryClient}>
        <AuthProvider
          fetchImpl={fetchImpl}
          initialSession={options.session ?? null}
          initialToken={options.token ?? null}
        >
          <ToastProvider>
            <MemoryRouter initialEntries={[options.route ?? "/dash"]}>
              <AppRoutes />
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("session redirect", () => {
  it("sends an anonymous visitor to the login screen", async () => {
    renderApp({ route: "/dash", session: null });
    expect(await screen.findByLabelText("Kullanıcı adı")).toBeInTheDocument();
  });

  it("guards a deep link too, not just the root", async () => {
    renderApp({ route: "/params", session: null });
    expect(await screen.findByLabelText("Parola")).toBeInTheDocument();
  });

  it("lets an authenticated user reach a screen", async () => {
    renderApp({ route: "/dash", session: SESSION, token: "tok" });
    expect(await screen.findAllByText("Panel")).not.toHaveLength(0);
  });

  it("shows a translated 404 for an unknown in-shell route", async () => {
    renderApp({ route: "/nope", session: SESSION, token: "tok" });
    expect(await screen.findByText("Sayfa bulunamadı")).toBeInTheDocument();
  });
});

/**
 * COLD LOAD — the path the real app takes and every test above skips.
 *
 * `renderApp` passes `initialSession`, which short-circuits the provider's boot
 * probe entirely. The browser never does: it mounts with `initialSession`
 * undefined, reads the bearer out of `sessionStorage` and asks `/auth/session`
 * whether it is still alive. That round trip is the window in which an operator
 * who IS signed in was being bounced to /login, so it needs its own harness —
 * one that mounts under <StrictMode>, because the double-invoked effect is half
 * of what made the bug fire.
 */
describe("cold load of a deep link", () => {
  const TOKEN_KEY = "maestro.token";

  beforeEach(() => {
    globalThis.sessionStorage.clear();
  });

  /**
   * Answers `/auth/session`, with the timing that makes the race deterministic.
   *
   * The FIRST probe settles on the next tick and the SECOND takes far longer.
   * That ordering is the whole point, and it is not artificial — it is what a
   * warm local BFF does to StrictMode's double-invoked effect: probe 1 has
   * already resolved when the effect's cleanup aborts it, so its AbortError is
   * delivered while probe 2 is still outstanding, and the catch that treats an
   * abort as a verdict has nothing but that abort to go on.
   *
   * Timing-dependent tests are usually a smell, so it is worth saying why this
   * one is not flaky: it does not race the scheduler, it PINS the order. Give
   * both probes the same delay and they finish together, the success overtakes
   * the abort, and the defect becomes invisible — which is exactly how it hid
   * from this suite until now.
   */
  function sessionFetch(answer: () => Response): typeof fetch {
    let probes = 0;
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/session")) {
        probes += 1;
        const slow = probes > 1;
        await new Promise((resolve) => setTimeout(resolve, slow ? 40 : 0));
        // The provider aborts its own probe on effect cleanup; a real fetch
        // rejects in that case rather than resolving, so the stub must too.
        if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
        return answer();
      }
      return new Response(JSON.stringify({ level: "off" }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  /** Records every DISTINCT status the provider commits, in order. */
  function StatusRecorder({ into }: { readonly into: AuthStatus[] }): ReactNode {
    const { status } = useAuth();
    if (into[into.length - 1] !== status) into.push(status);
    return null;
  }

  function renderCold(route: string, fetchImpl: typeof fetch): AuthStatus[] {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const statuses: AuthStatus[] = [];
    render(
      <StrictMode>
        <I18nProvider initialLocale="tr">
          <QueryClientProvider client={queryClient}>
            {/* No initialSession: this is a real boot, probe and all. */}
            <AuthProvider fetchImpl={fetchImpl}>
              {/* OUTSIDE the router on purpose: <Navigate> unmounts and
                  remounts whatever sits inside it, and a recorder that dies
                  with the redirect loses the very render it exists to catch. */}
              <StatusRecorder into={statuses} />
              <ToastProvider>
                <MemoryRouter initialEntries={[route]}>
                  <AppRoutes />
                </MemoryRouter>
              </ToastProvider>
            </AuthProvider>
          </QueryClientProvider>
        </I18nProvider>
      </StrictMode>,
    );
    return statuses;
  }

  it("never reports `anonymous` for a stored token that turns out to be valid", async () => {
    globalThis.sessionStorage.setItem(TOKEN_KEY, "tok");
    const statuses = renderCold(
      "/change-password",
      sessionFetch(() => new Response(JSON.stringify(SESSION), { status: 200 })),
    );

    // The deep-linked screen renders, which is the user-visible half.
    expect(await screen.findByText("Parolanızı belirleyin")).toBeInTheDocument();
    expect(screen.queryByLabelText("Kullanıcı adı")).not.toBeInTheDocument();

    // The half that actually pins the bug, and the reason this test asserts on
    // a status sequence rather than on the DOM: the bad state lasts one round
    // trip, and `findBy*`/`waitFor` retry straight past it — the suite went
    // green against the unfixed provider because the login form it briefly
    // rendered was gone by the time the first retry looked.
    //
    // Before the fix this read ["loading", "anonymous", "authenticated"]. The
    // `anonymous` in the middle is a committed render, and it is the one in
    // which RequireSession fires <Navigate to="/login"> at an operator holding
    // a perfectly good token. "loading" must lead straight to "authenticated".
    await waitFor(() => {
      expect(statuses).toContain("authenticated");
    });
    expect(statuses).toEqual(["loading", "authenticated"]);
  });

  it("DOES send a visitor with no stored token to /login", async () => {
    renderCold("/change-password", sessionFetch(() => new Response(JSON.stringify(SESSION), { status: 200 })));
    // Nothing in sessionStorage: there is no token to check, so the verdict is
    // immediate and the login form is correct.
    expect(await screen.findByLabelText("Kullanıcı adı")).toBeInTheDocument();
  });

  it("sends a visitor whose stored token the BFF rejects to /login", async () => {
    globalThis.sessionStorage.setItem(TOKEN_KEY, "stale");
    renderCold(
      "/change-password",
      sessionFetch(() => new Response(JSON.stringify({ error: "session_expired" }), { status: 401 })),
    );
    // A real 401 IS a verdict — an 8-hour session that lapsed lands here — and
    // it must still reach the login form rather than hanging on the skeleton.
    expect(await screen.findByLabelText("Kullanıcı adı")).toBeInTheDocument();
  });
});

describe("login", () => {
  it("stores the session and shows the app after a successful sign-in", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return new Response(
          JSON.stringify({
            token: "new-token",
            expiresAt: SESSION.expiresAt,
            user: {
              userId: SESSION.userId,
              username: SESSION.username,
              roles: SESSION.roles,
              groups: SESSION.groups,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ level: "off" }), { status: 200 });
    });

    renderApp({ route: "/login", session: null, fetchImpl: fetchImpl as unknown as typeof fetch });

    await userEvent.type(await screen.findByLabelText("Kullanıcı adı"), "ayse.kaya");
    await userEvent.type(screen.getByLabelText("Parola"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Giriş yap" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Parola")).not.toBeInTheDocument();
    });
  });

  it("shows a translated message, never the raw code, on bad credentials", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "invalid_credentials" }), { status: 401 }),
    );

    renderApp({ route: "/login", session: null, fetchImpl: fetchImpl as unknown as typeof fetch });

    await userEvent.type(await screen.findByLabelText("Kullanıcı adı"), "ayse.kaya");
    await userEvent.type(screen.getByLabelText("Parola"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Giriş yap" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Kullanıcı adı veya parola hatalı.");
    expect(alert).not.toHaveTextContent("invalid_credentials");
  });
});

describe("first-run bootstrap change-password (banking standard)", () => {
  const BOOTSTRAP: Session = { ...SESSION, roles: ["admin"], mustChangePassword: true };

  it("routes a must-change session to the change-password screen, blocking the app", async () => {
    renderApp({ route: "/dash", session: BOOTSTRAP, token: "tok" });
    // The change-password screen is shown; the dashboard is not reachable.
    expect(await screen.findByText("Parolanızı belirleyin")).toBeInTheDocument();
    expect(screen.queryByText("Panel")).not.toBeInTheDocument();
  });

  it("even a deep link is bounced to change-password while restricted", async () => {
    renderApp({ route: "/params", session: BOOTSTRAP, token: "tok" });
    expect(await screen.findByText("Parolanızı belirleyin")).toBeInTheDocument();
  });

  it("shows the policy violations the BFF returns, in Turkish", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/change-password")) {
        return new Response(
          JSON.stringify({ error: "password_policy", details: { violations: ["too_short", "no_symbol"] } }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ level: "off" }), { status: 200 });
    });

    renderApp({
      route: "/change-password",
      session: BOOTSTRAP,
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await userEvent.type(await screen.findByLabelText("Mevcut parola"), "admin123");
    await userEvent.type(screen.getByLabelText("Yeni parola"), "admin123");
    await userEvent.type(screen.getByLabelText("Yeni parola (tekrar)"), "admin123");
    await userEvent.click(screen.getByRole("button", { name: "Parolayı değiştir" }));

    expect(await screen.findByText("Çok kısa (en az 8 karakter)")).toBeInTheDocument();
    expect(screen.getByText("En az bir simge gerekli")).toBeInTheDocument();
  });

  it("signs the user out to /login after a successful change", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/change-password")) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ level: "off" }), { status: 200 });
    });

    renderApp({
      route: "/change-password",
      session: BOOTSTRAP,
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await userEvent.type(await screen.findByLabelText("Mevcut parola"), "admin123");
    await userEvent.type(screen.getByLabelText("Yeni parola"), "Maestro!First-2026");
    await userEvent.type(screen.getByLabelText("Yeni parola (tekrar)"), "Maestro!First-2026");
    await userEvent.click(screen.getByRole("button", { name: "Parolayı değiştir" }));

    // The session is cleared, so the login screen appears.
    expect(await screen.findByLabelText("Kullanıcı adı")).toBeInTheDocument();
  });
});

describe("role helpers", () => {
  it("reads roles off the session", () => {
    expect(hasRole(SESSION, "tech-lead")).toBe(true);
    expect(hasRole(SESSION, "admin")).toBe(false);
    expect(hasRole(null, "admin")).toBe(false);
  });

  it("treats an empty requirement as open to everyone", () => {
    expect(hasAnyRole(SESSION, [])).toBe(true);
    expect(hasAnyRole(null, [])).toBe(true);
    expect(hasAnyRole(SESSION, ["admin", "tech-lead"])).toBe(true);
    expect(hasAnyRole(SESSION, ["admin"])).toBe(false);
  });

  it("normalises the login shape into a session", () => {
    const normalised = sessionFromLogin({
      token: "t",
      expiresAt: "2099-01-01T00:00:00.000Z",
      user: { userId: "u@corp", username: "u", roles: ["admin"], groups: [] },
    });
    expect(normalised.username).toBe("u");
    expect(normalised.delegated).toBe(false);
  });
});

describe("navigation role filtering", () => {
  it("hides an admin-only entry from a tech-lead (usability, not security)", async () => {
    renderApp({ route: "/dash", session: SESSION, token: "tok" });
    await screen.findAllByText("Panel");
    // users is admin-only: hidden from a tech-lead. params is menu-hidden for
    // everyone (no navKey until it is wired to the engine), role or not.
    expect(screen.queryByText("Kullanıcılar & roller")).not.toBeInTheDocument();
    expect(screen.queryByText("Parametreler (DB)")).not.toBeInTheDocument();
  });

  it("shows admin entries to an admin", async () => {
    renderApp({
      route: "/dash",
      session: { ...SESSION, roles: ["admin"] },
      token: "tok",
    });
    await screen.findAllByText("Panel");
    expect(screen.getByText("Kullanıcılar & roller")).toBeInTheDocument();
  });

  it("still routes to a hidden screen when typed directly, because the BFF is the real guard", async () => {
    renderApp({ route: "/users", session: SESSION, token: "tok" });
    // Reachable in the client; authorisation happens server-side on fetch.
    expect(await screen.findAllByText("Kullanıcılar & roller")).not.toHaveLength(0);
  });
});
