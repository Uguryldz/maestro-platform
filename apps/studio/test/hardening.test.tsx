import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { Session } from "../src/auth/types.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { catalogKeys, translate } from "../src/i18n/catalog.ts";
import { ErrorBoundary } from "../src/app/ErrorBoundary.tsx";
import { SandboxScreen } from "../src/screens/Sandbox.tsx";
import { SecurityScreen } from "../src/screens/Security.tsx";
import { SettingsScreen } from "../src/screens/Settings.tsx";
import { TemplateScreen } from "../src/screens/Template.tsx";
import { UsersScreen } from "../src/screens/Users.tsx";
import { MissingReasonError, useGateDecision } from "../src/screens/shared/signals.ts";
import { slugify } from "../src/screens/template/model.ts";
import { ToastProvider } from "../src/ui/Toast.tsx";

/**
 * Regressions for the three defects the Wave 4 audit found in this package.
 * Each test is written to fail if the specific guard is removed, not merely if
 * the screen stops rendering — the audit's finding Y2 was precisely that a test
 * claimed to cover a guard while actually covering a different layer.
 */

const ADMIN: Session = {
  userId: "ugur.yildiz@ugurbank.local",
  username: "ugur.yildiz",
  roles: ["admin"],
  groups: ["maestro-admins"],
  delegated: false,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wrapper(fetchImpl: typeof fetch) {
  return function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    return (
      <I18nProvider initialLocale="tr">
        <QueryClientProvider client={queryClient}>
          <AuthProvider fetchImpl={fetchImpl} initialSession={ADMIN} initialToken="tok">
            <ToastProvider>
              <MemoryRouter>{children}</MemoryRouter>
            </ToastProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    );
  };
}

function renderScreen(ui: ReactNode, fetchImpl: typeof fetch): void {
  const Wrapper = wrapper(fetchImpl);
  render(<Wrapper>{ui}</Wrapper>);
}

// ── Y2: the reject-without-reason gate, tested where it actually lives ────────

describe("useGateDecision (signals.ts) — the client-side reject gate", () => {
  /**
   * The audit deleted the `MissingReasonError` throw in `signals.ts` and all 177
   * tests still passed: the only coverage was `GatePanel` disabling its button,
   * a different layer entirely. These tests call the mutation DIRECTLY, so
   * deleting that line fails them and nothing else can mask it.
   */
  function setup() {
    const fetchImpl = vi.fn(async () =>
      json({ accepted: true, step: "12", signatureSeq: 1 }),
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useGateDecision(), { wrapper: wrapper(fetchImpl) });
    return { result, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn> };
  }

  it("rejects a rejection with no reason at all, before any request is sent", async () => {
    const { result, fetchImpl } = setup();

    await expect(
      result.current.mutateAsync({ ticket: "UGURPAY-501", decision: "reject" }),
    ).rejects.toBeInstanceOf(MissingReasonError);

    // The point of the guard: nothing left the browser.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a rejection whose reason is only whitespace", async () => {
    const { result, fetchImpl } = setup();

    await expect(
      result.current.mutateAsync({ ticket: "UGURPAY-501", decision: "reject", reason: "   \n\t " }),
    ).rejects.toBeInstanceOf(MissingReasonError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("carries the error's catalog key so the UI never prints the raw message", async () => {
    const { result } = setup();

    await expect(
      result.current.mutateAsync({ ticket: "UGURPAY-501", decision: "reject" }),
    ).rejects.toMatchObject({ messageKey: "error.reject_needs_reason" });
  });

  it("sends the rejection once a reason is present, trimmed", async () => {
    const { result, fetchImpl } = setup();

    await result.current.mutateAsync({
      ticket: "UGURPAY-501",
      decision: "reject",
      reason: "  kapsam eksik  ",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/runs/UGURPAY-501/signals/gateDecision");
    expect(JSON.parse(init.body as string)).toEqual({
      decision: "reject",
      reason: "kapsam eksik",
    });
  });

  it("does not require a reason to approve", async () => {
    const { result, fetchImpl } = setup();

    await result.current.mutateAsync({ ticket: "UGURPAY-501", decision: "approve" });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // No reason key at all, and above all no actor: identity is the server's.
    expect(JSON.parse(init.body as string)).toEqual({ decision: "approve" });
  });
});

// ── Y1: an unrecognised server enum must not blank the screen ─────────────────

describe("unknown server enum values", () => {
  /**
   * `DirectoryUser.roles` is typed as the contract's closed `Role` union, but
   * the BFF's own type is `readonly string[]` and the directory's group names
   * pass through unfiltered (apps/bff/src/deps.ts:95). Before this fix, one such
   * name threw MissingMessageError out of `t()` and the ErrorBoundary blanked
   * the entire users screen — hiding the roles the operator CAN read.
   */
  it("keeps the users screen up when the directory returns a role outside the contract", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        items: [
          {
            username: "ayse.kaya",
            userId: "ayse.kaya@ugurbank.local",
            roles: ["admin", "release-manager"],
            groups: ["maestro-admins"],
            active: true,
          },
        ],
      }),
    ) as unknown as typeof fetch;

    renderScreen(<UsersScreen />, fetchImpl);

    // The known role still renders — this is what the crash used to destroy.
    await waitFor(() => expect(screen.getByText("ayse.kaya")).toBeInTheDocument());
    expect(screen.getAllByText("admin").length).toBeGreaterThan(0);

    // The unknown one is SHOWN and MARKED, not swallowed and not translated.
    expect(screen.getByText("tanınmayan: release-manager")).toBeInTheDocument();

    // The ErrorBoundary's panel must be absent.
    expect(screen.queryByText("Bir şeyler ters gitti")).not.toBeInTheDocument();
  });

  it("keeps the sandbox fleet visible when a new state appears", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        items: [
          {
            ticketKey: "UGURPAY-501",
            runnerId: "runner-a",
            state: "active",
            sizeBytes: 1024,
            idleMinutes: 3,
            lastUsedAt: "2026-08-01T09:00:00.000Z",
          },
          {
            ticketKey: "UGURPAY-478",
            runnerId: "runner-b",
            state: "archived",
            sizeBytes: 2048,
            idleMinutes: 900,
            lastUsedAt: "2026-07-01T09:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    ) as unknown as typeof fetch;

    renderScreen(<SandboxScreen />, fetchImpl);

    // The row with the KNOWN state survives — that is the regression.
    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());
    expect(screen.getByText("çalışıyor")).toBeInTheDocument();

    expect(screen.getByText("UGURPAY-478")).toBeInTheDocument();
    expect(screen.getByText("tanınmayan: archived")).toBeInTheDocument();
  });
});

// ── Y3: raw scanner prose is not printed on sight ─────────────────────────────

describe("security findings — raw scanner text", () => {
  const GITLEAKS_ROW = {
    ticketKey: "UGURPAY-501",
    finding: {
      tool: "gitleaks",
      ruleId: "aws-access-key",
      severity: "critical",
      message: "aws key detected: AKIAIOSFODNN7EXAMPLE in config/prod.env",
      file: "config/prod.env",
      line: 12,
    },
    outcome: "fail",
    at: "2026-08-01T09:00:00.000Z",
  };

  /**
   * A Gitleaks message can quote the secret it found. The screen that reports a
   * leak must not become a second copy of it merely by being opened.
   */
  it("does not render the scanner's prose until an operator asks for it", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ items: [GITLEAKS_ROW], nextCursor: null }),
    ) as unknown as typeof fetch;

    renderScreen(<SecurityScreen />, fetchImpl);

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());

    // The row is present and triageable...
    expect(screen.getByText("kritik")).toBeInTheDocument();
    expect(screen.getByText("gitleaks")).toBeInTheDocument();

    // ...but the secret is NOT on the page.
    expect(document.body.textContent).not.toContain("AKIAIOSFODNN7EXAMPLE");

    // Revealing it is a deliberate act, and it is labelled as scanner output.
    await userEvent.click(screen.getByRole("button", { name: "Tarayıcı metnini göster" }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("AKIAIOSFODNN7EXAMPLE"),
    );
    expect(
      screen.getByText("Tarayıcı çıktısı (çevrilmemiş, sır içerebilir)"),
    ).toBeInTheDocument();
  });

  it("never tones an unrecognised scan outcome as a pass", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        items: [{ ...GITLEAKS_ROW, outcome: "skipped" }],
        nextCursor: null,
      }),
    ) as unknown as typeof fetch;

    renderScreen(<SecurityScreen />, fetchImpl);

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());

    const badge = screen.getByText("tanınmayan: skipped");
    expect(badge).toBeInTheDocument();
    // A scanner result nobody recognises is not a clean one.
    expect(badge.className).not.toContain("green");
    expect(screen.queryByText("geçti")).not.toBeInTheDocument();
  });
});

// ── O2: an unbuilt endpoint says so, instead of "record not found" ────────────

describe("screens whose read model the BFF has not built", () => {
  /**
   * `GET /settings` is now LIVE (apps/bff/src/routes/settings.ts). The screen no
   * longer pretends a failure is an unbuilt endpoint — a 404 here is a genuine
   * failure and renders through the ordinary error path, the same as any other
   * broken read. The "not published yet" fallback was correct only while the
   * endpoint was still a request.
   */
  it("shows a failing settings read as a failure, not as 'unpublished'", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: "not_found" }, 404),
    ) as unknown as typeof fetch;

    renderScreen(<SettingsScreen />, fetchImpl);

    await waitFor(() => expect(screen.getByText("Veri alınamadı")).toBeInTheDocument());
    // The screen must not claim the section was never built — the endpoint is real.
    expect(screen.queryByText("Bu bölüm henüz yayında değil")).not.toBeInTheDocument();
  });

  it("still shows a 500 as a real failure", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: "internal" }, 500),
    ) as unknown as typeof fetch;

    renderScreen(<SettingsScreen />, fetchImpl);

    await waitFor(() => expect(screen.getByText("Veri alınamadı")).toBeInTheDocument());
    expect(screen.queryByText("Bu bölüm henüz yayında değil")).not.toBeInTheDocument();
  });
});

// ── EK-1: the template designer must never render as a blank panel ────────────

describe("template designer against an unbuilt endpoint", () => {
  /**
   * Reported from the running stack: `/template` answers 404, the screen showed
   * a heading and two paragraphs of prose and nothing else, and the request was
   * repeated three times in the console.
   *
   * The screen is the most-requested feature in the product; rendering it blank
   * leaves the operator unable to tell "no template yet" from "system broken"
   * from "not my permission".
   */
  it("says the section is not published instead of rendering an empty panel", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: "not_found" }, 404),
    ) as unknown as typeof fetch;

    renderScreen(<TemplateScreen />, fetchImpl);

    await waitFor(() =>
      expect(screen.getAllByText("Bu bölüm henüz yayında değil").length).toBeGreaterThan(0),
    );
  });

  it("does not retry an endpoint that does not exist", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "not_found" }, 404));

    // The production retry policy, not the test default — that is the thing
    // under test here.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: (failureCount: number, error: unknown) => {
            const status = (error as { status?: number }).status;
            if (status === 401 || status === 403 || status === 404 || status === 501) return false;
            return failureCount < 2;
          },
          gcTime: 0,
        },
      },
    });

    render(
      <I18nProvider initialLocale="tr">
        <QueryClientProvider client={queryClient}>
          <AuthProvider
            fetchImpl={fetchImpl as unknown as typeof fetch}
            initialSession={ADMIN}
            initialToken="tok"
          >
            <ToastProvider>
              <MemoryRouter>
                <TemplateScreen />
              </MemoryRouter>
            </ToastProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>,
    );

    await waitFor(() =>
      expect(screen.getAllByText("Bu bölüm henüz yayında değil").length).toBeGreaterThan(0),
    );

    // Exactly one attempt: three identical console errors per unbuilt screen
    // teaches an operator to ignore the console.
    const templateCalls = (fetchImpl.mock.calls as unknown as readonly unknown[][]).filter(
      (call) => String(call[0]).includes("/template"),
    );
    expect(templateCalls).toHaveLength(1);
  });
});

// ── O3: a revoked account must not look privileged ────────────────────────────

describe("users screen — a disabled account's roles", () => {
  function disabledUser(): typeof fetch {
    return vi.fn(async () =>
      json({
        items: [
          {
            username: "eski.calisan",
            userId: "eski.calisan@ugurbank.local",
            roles: ["admin"],
            groups: ["maestro-admins"],
            active: false,
          },
        ],
      }),
    ) as unknown as typeof fetch;
  }

  /**
   * The warning text already said the account was revoked, but the `admin`
   * badge kept its normal purple register — colour and text disagreeing, with
   * colour read first. "Does this account still look privileged?" is the exact
   * question the screen is opened to answer.
   */
  it("strikes through and mutes the roles of a revoked account", async () => {
    renderScreen(<UsersScreen />, disabledUser());

    await waitFor(() => expect(screen.getByText("pasif")).toBeInTheDocument());

    // The role is still listed (an auditor needs to see it) but struck through.
    const struck = document.querySelector("s");
    expect(struck).not.toBeNull();
    expect(struck!.textContent).toBe("admin");

    // And it must not carry the live "admin" tone.
    const badge = struck!.closest("[class*='badge'], span");
    expect(badge?.className ?? "").not.toContain("purple");
  });

  it("leaves an active account's roles in their normal register", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        items: [
          {
            username: "ayse.kaya",
            userId: "ayse.kaya@ugurbank.local",
            roles: ["admin"],
            groups: ["maestro-admins"],
            active: true,
          },
        ],
      }),
    ) as unknown as typeof fetch;

    renderScreen(<UsersScreen />, fetchImpl);

    await waitFor(() => expect(screen.getByText("etkin")).toBeInTheDocument());
    expect(document.querySelector("s")).toBeNull();
  });
});

// ── D1: the Turkish fold actually runs ────────────────────────────────────────

describe("slugify — Turkish folding", () => {
  /**
   * HONEST NOTE ON WHAT THESE TESTS ARE.
   *
   * D1 was a readability defect, not a behaviour defect. `"İ".toLowerCase()` is
   * `"i"` + U+0307, so a fold running AFTER lowercasing never saw an `İ` and its
   * dictionary entry was dead code — but the NFD pass stripped the combining
   * mark anyway, so every output was already correct. Reordering the fold makes
   * the dictionary the thing that actually does the work.
   *
   * That means these are CHARACTERIZATION tests: they pin the outputs so the
   * refactor is provably behaviour-preserving and so a future change to the fold
   * cannot drift silently. They are NOT mutation-provable against the original
   * bug, because the original bug had no observable output. Reverting the fix
   * leaves them green, by design and by the nature of the defect.
   */
  it("folds İ to a plain ASCII i", () => {
    expect(slugify("İstanbul Şubesi")).toBe("istanbul_subesi");
    expect(slugify("İŞ AKIŞI")).toBe("is_akisi");
  });

  it("folds dotless I to i, not to ı, so the key stays ASCII", () => {
    // "I" lowercases to "i" in JS (not Turkish "ı"), and a section key is an
    // ASCII identifier — both paths must land on "i".
    expect(slugify("IŞIK")).toBe("isik");
    expect(slugify("Işık ölçümü")).toBe("isik_olcumu");
  });

  it("keeps every previously-correct result unchanged", () => {
    expect(slugify("Kapsam (dahil / hariç)")).toBe("kapsam_dahil_haric");
    expect(slugify("Ürün Şablonu")).toBe("urun_sablonu");
    expect(slugify("Çıkış / Giriş")).toBe("cikis_giris");
  });
});

// ── EK-2: Turkish suffixes must not be glued to a variable placeholder ────────

describe("catalog — Turkish suffix agreement", () => {
  /**
   * `dash.attention.age` was `"{age}tir açık"`, which rendered "16 güntir açık".
   * Turkish vowel harmony picks the suffix from the preceding word, and `{age}`
   * can be "16 gün" (wants -dür), "3 saat" (wants -tir) or "2 gün 4 saat". No
   * single literal suffix is correct for a variable substitution, so the only
   * right answer is to build the sentence without one.
   *
   * This test generalises the rule to the whole catalog rather than pinning the
   * one string, because the next person to write "{n}de" will not read this
   * comment.
   */
  it("never glues a Turkish case/copula suffix onto a placeholder", () => {
    // A placeholder immediately followed by a suffix-shaped lowercase cluster.
    // `v{n}` and friends are a PREFIX, not a suffix, and are unaffected.
    const glued = /\{[a-zA-Z_]+\}(d[ıiuü]r|t[ıiuü]r|[dt][ae]|[dt][ae]n|l[ıiuü]k)\b/;

    // `t()` leaves an unsupplied placeholder in place (`params[name] ?? whole`),
    // so translating with no params yields the raw template — exactly what this
    // rule needs to inspect.
    const offenders = catalogKeys("tr")
      .map((key) => [key, translate("tr", key)] as const)
      .filter(([, raw]) => glued.test(raw))
      .map(([key, raw]) => `${key}: ${raw}`);

    expect(offenders).toEqual([]);
  });
});

// ── D2: the error panel does not leak HTTP codes to end users ─────────────────

describe("ErrorBoundary detail", () => {
  function Boom({ error }: { readonly error: Error }): ReactNode {
    throw error;
  }

  it("shows a MissingMessageError's message — the missing key is the only fix", () => {
    const error = new Error('missing message "users.card.roles" for locale "tr"');
    error.name = "MissingMessageError";
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom error={error} />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert").textContent).toContain("users.card.roles");
  });

  it("hides any other error's message, which may carry an HTTP status and code", () => {
    const error = new Error("api 403 role_required");
    error.name = "ApiError";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom error={error} />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("ApiError");
    // The status and the server's error code are not an end user's business.
    expect(alert.textContent).not.toContain("403");
    expect(alert.textContent).not.toContain("role_required");

    // But an operator with devtools open still gets the whole thing.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
