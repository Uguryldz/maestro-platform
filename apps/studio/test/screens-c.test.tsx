import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, type Mock } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { Session } from "../src/auth/types.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { AuditScreen } from "../src/screens/Audit.tsx";
import { HelpScreen } from "../src/screens/Help.tsx";
import { KnowledgeScreen } from "../src/screens/Knowledge.tsx";
import { PiiScreen } from "../src/screens/Pii.tsx";
import { TemplateScreen } from "../src/screens/Template.tsx";
import { ToastProvider } from "../src/ui/index.ts";

/**
 * Screen-level tests for cluster C. No test reaches the network: every one
 * injects its own fetch stub (test/setup.ts makes the global fetch throw), so a
 * screen that forgot to go through the ApiClient would fail here rather than
 * silently hitting a real port.
 */

/**
 * user-event with its inter-key delay disabled. The default delay makes a
 * multi-click or typing test take seconds of wall clock, which turns into
 * flaky timeouts on a loaded CI machine; the delay buys nothing here because
 * these screens have no debounce to wait out.
 */
const user = userEvent.setup({ delay: null });

/** Build a fetch stub that answers one route with one JSON body. */
function stubFetch(routes: Readonly<Record<string, unknown>>, status = 200): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Longest path first, so a stub for "/studio/audit" never shadows one for
    // "/studio/audit/verification".
    const match = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((path) => url.includes(path));
    if (match === undefined) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(routes[match]), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const SESSION: Session = {
  userId: "u1",
  username: "test@corp",
  roles: ["admin"],
  groups: [],
  delegated: false,
  expiresAt: "2026-08-09T23:00:00Z",
};

/**
 * Renders inside <StrictMode>, because main.tsx does. StrictMode double-invokes
 * effects in development, so a screen that seeds editable state from a query in
 * an effect must be idempotent — rendering the tests any other way would hide
 * exactly that class of bug.
 */
function renderScreen(ui: ReactNode, fetchImpl: typeof fetch, client?: QueryClient): void {
  const queryClient =
    client ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  render(
    <StrictMode>
      <I18nProvider initialLocale="tr" storage={undefined}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider fetchImpl={fetchImpl} initialSession={SESSION} initialToken="test-token">
            <ToastProvider>
              <MemoryRouter>{ui}</MemoryRouter>
            </ToastProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </StrictMode>,
  );
}

const TEMPLATE_BODY = {
  template: {
    name: "Kurumsal analiz şablonu",
    version: 3,
    sections: [
      {
        key: "amac",
        title: "Amaç",
        description: "",
        aiInstruction: "",
        required: true,
        format: "free_text",
        example: "",
      },
      {
        key: "kapsam",
        title: "Kapsam",
        description: "",
        aiInstruction: "",
        required: true,
        format: "bullet_list",
        example: "",
      },
    ],
  },
  history: [],
  projects: [],
};

describe("TemplateScreen (M108 designer)", () => {
  it("lists the sections the server returned, in order", async () => {
    renderScreen(<TemplateScreen />, stubFetch({ "/template": TEMPLATE_BODY }));
    expect(await screen.findByText("Amaç")).toBeInTheDocument();
    expect(screen.getByText("Kapsam")).toBeInTheDocument();
  });

  it("wears the honest wiring strip at the top (overlay reality)", async () => {
    renderScreen(<TemplateScreen />, stubFetch({ "/template": TEMPLATE_BODY }));
    // The strip renders unconditionally and tells the OVERLAY truth: titles +
    // AI instructions are wired (per run, restart-free); the section structure
    // stays the engine's fixed corporate skeleton.
    expect(
      await screen.findByText(/BAŞLIKLARI ve AI TALİMATLARI motora bağlıdır/),
    ).toBeInTheDocument();
  });

  /** The section list is the only <ol> on the screen. */
  function listItems(): readonly HTMLElement[] {
    return within(screen.getByRole("list")).getAllByRole("listitem");
  }

  it("adds a section without colliding with an existing key", async () => {
    renderScreen(<TemplateScreen />, stubFetch({ "/template": TEMPLATE_BODY }));
    await screen.findByText("Amaç");

    // Resolved once: re-querying by accessible name after each click rescans a
    // growing tree and makes this test an order of magnitude slower.
    const add = screen.getByRole("button", { name: "+ Bölüm ekle" });
    await user.click(add);
    await user.click(add);

    const keys = listItems().map((item) => item.querySelector("code")?.textContent);
    expect(keys).toEqual(["amac", "kapsam", "yeni_bolum", "yeni_bolum_2"]);
  });

  it("reorders sections when the move control is used", async () => {
    renderScreen(<TemplateScreen />, stubFetch({ "/template": TEMPLATE_BODY }));
    await screen.findByText("Amaç");

    expect(within(listItems()[0]!).getByText("Amaç")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: '"Amaç" bölümünü aşağı taşı' }));

    const reordered = listItems();
    expect(within(reordered[0]!).getByText("Kapsam")).toBeInTheDocument();
    expect(within(reordered[1]!).getByText("Amaç")).toBeInTheDocument();
  });

  it("renaming a section re-derives its key and avoids a collision", async () => {
    renderScreen(<TemplateScreen />, stubFetch({ "/template": TEMPLATE_BODY }));
    await screen.findByText("Amaç");

    // Select the second section (the row's own pick button, not its ↑ ↓ ✕
    // controls, which also carry the title in their labels).
    await user.click(
      within(listItems()[1]!).getByRole("button", { name: /^2\s*Kapsam/ }),
    );
    const titleField = await screen.findByLabelText("Bölüm başlığı");
    await user.clear(titleField);
    await user.type(titleField, "Amaç");

    await waitFor(() => {
      const keys = listItems().map((item) => item.querySelector("code")?.textContent);
      expect(keys).toEqual(["amac", "amac_2"]);
    });
  });

  it("refuses to remove the last remaining section", async () => {
    const single = {
      ...TEMPLATE_BODY,
      template: { ...TEMPLATE_BODY.template, sections: [TEMPLATE_BODY.template.sections[0]] },
    };
    renderScreen(<TemplateScreen />, stubFetch({ "/template": single }));
    await screen.findByText("Amaç");

    expect(screen.getByRole("button", { name: '"Amaç" bölümünü çıkar' })).toBeDisabled();
  });

  it("keeps in-progress edits when a refetch reports the same version", async () => {
    // The draft is seeded from the server copy and re-seeded ONLY when the
    // published version changes. A refetch that still reports version 3 must
    // leave the author's unsaved work alone — re-seeding there silently
    // discards whatever was being typed.
    //
    // Note this test renders under StrictMode like the rest of the file, so the
    // seed is also being checked for idempotence under React's double
    // invocation: a seed written as a naive effect fails here.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    renderScreen(<TemplateScreen />, stubFetch({ "/template": TEMPLATE_BODY }), queryClient);
    await screen.findByText("Amaç");

    await user.click(screen.getByRole("button", { name: "+ Bölüm ekle" }));
    expect(listItems()).toHaveLength(3);

    // A real refetch of the same version, as a window refocus would trigger.
    await queryClient.refetchQueries({ queryKey: ["template"] });

    await waitFor(() => {
      const keys = listItems().map((item) => item.querySelector("code")?.textContent);
      expect(keys).toEqual(["amac", "kapsam", "yeni_bolum"]);
    });
  });

  it("says 'not published yet' for a route the BFF does not serve", async () => {
    // Several cluster C endpoints do not exist yet, so they answer 404. That
    // must NOT read as "record not found" — the record is not missing, the read
    // model was never built. Anything else stays a normal translated error.
    const missing = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    renderScreen(<TemplateScreen />, missing);

    expect(await screen.findAllByText("Bu bölüm henüz yayında değil")).not.toHaveLength(0);
    expect(screen.queryByText("Kayıt bulunamadı.")).not.toBeInTheDocument();
  });

  it("shows a translated failure, never the raw server body", async () => {
    const failing = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "internal_error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    renderScreen(<TemplateScreen />, failing);
    // Both cards on the screen report the same failure, hence getAllByText.
    expect((await screen.findAllByText("Sunucuda bir hata oluştu.")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/internal_error/)).not.toBeInTheDocument();
  });
});

describe("KnowledgeScreen (data class fails closed)", () => {
  /**
   * `/studio/knowledge` is a SEARCH: the BFF requires `q` and already filters by
   * data class, returning `withheld` for what it removed. These rows are what
   * survives that filter — the screen's own fail-closed pass is a second layer
   * over whatever still arrives.
   */
  const RESULTS = {
    items: [
      {
        id: "1",
        title: "api-tasarim.md",
        snippet: "…",
        source: "conventions",
        score: 0.9,
        appId: "ugurpay",
        updatedBy: "Mert D.",
        updatedAt: "8 gün önce",
        dataClass: "dahili",
      },
      {
        id: "2",
        title: "gizli-politika.md",
        snippet: "…",
        source: "rules",
        score: 0.8,
        appId: null,
        updatedBy: "Uyum",
        updatedAt: "1 ay önce",
        dataClass: "gizli",
      },
      {
        id: "3",
        title: "etiketsiz.md",
        snippet: "…",
        source: "rules",
        score: 0.7,
        appId: null,
        updatedBy: "—",
        updatedAt: "—",
        // dataClass absent: must be read as gizli, never as public.
      },
    ],
    nextCursor: null,
    withheld: 1,
  };

  it("asks for nothing until there is a search term", async () => {
    const fetchImpl = stubFetch({ "/studio/knowledge": RESULTS, "/studio/guidance": { notes: [] } });
    renderScreen(<KnowledgeScreen />, fetchImpl);
    expect(await screen.findByText("Aramak için bir kelime yaz.")).toBeInTheDocument();
    // The SEARCH endpoint is not called with an empty box (it is a search, not a
    // listing). The guidance library above it loads independently, so assert the
    // search specifically was never hit rather than "no fetch at all".
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some(([u]) => String(u).includes("/studio/knowledge"))).toBe(false);
  });

  it("drops confidential and untagged documents from the results", async () => {
    renderScreen(<KnowledgeScreen />, stubFetch({ "/studio/knowledge": RESULTS, "/studio/guidance": { notes: [] } }));
    await user.type(screen.getByLabelText("Ara"), "limit");

    expect(await screen.findByText("api-tasarim.md")).toBeInTheDocument();
    expect(screen.queryByText("gizli-politika.md")).not.toBeInTheDocument();
    expect(screen.queryByText("etiketsiz.md")).not.toBeInTheDocument();
  });

  it("counts both what the server withheld and what it dropped itself", async () => {
    renderScreen(<KnowledgeScreen />, stubFetch({ "/studio/knowledge": RESULTS, "/studio/guidance": { notes: [] } }));
    await user.type(screen.getByLabelText("Ara"), "limit");

    // 1 withheld by the BFF + 2 dropped here (gizli, and the untagged one).
    expect(await screen.findByText("3 kayıt gösterilmiyor")).toBeInTheDocument();
  });
});

describe("PiiScreen", () => {
  it("shows counts and rules but never a masked value", async () => {
    const body = {
      summary: {
        maskedCalls: 38,
        totalCalls: 41,
        maskedFields: 112,
        exemptVariants: [],
        onPremCalls: 3,
        archiveMasked: true,
      },
      rules: [
        { ruleId: "r1", kind: "field", matcher: "customer_email", strategy: "hash", hits: 24 },
        { ruleId: "r2", kind: "regex", matcher: "TCKN [0-9]{11}", strategy: "redact", hits: 9 },
      ],
    };
    renderScreen(<PiiScreen />, stubFetch({ "/pii": body }));

    expect(await screen.findByText("38 / 41")).toBeInTheDocument();
    expect(screen.getByText("customer_email")).toBeInTheDocument();

    // The screen must not render an example of a masked value, in either form.
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d{11}/)).not.toBeInTheDocument();
    expect(screen.queryByText(/GİZLENDİ/)).not.toBeInTheDocument();
  });
});

describe("AuditScreen", () => {
  const EVENTS = {
    items: [
      {
        seq: 1,
        at: "2026-08-09T03:00:00Z",
        actor: "maestro-worker",
        action: "RUN_STARTED",
        subject: "UGURPAY-501",
        prevHash: "genesis",
        hash: "b".repeat(64),
        meta: {},
      },
    ],
    nextCursor: null,
  };

  it("does not show a bare server ok as a verified chain", async () => {
    renderScreen(
      <AuditScreen />,
      stubFetch({
        // Most specific route first: /studio/audit/verification also contains
        // /studio/audit.
        "/studio/audit/verification": { ok: true, checked: 0, brokenAtSeq: null },
        "/studio/audit": EVENTS,
      }),
    );

    expect(await screen.findByText("Doğrulama dayanaksız")).toBeInTheDocument();
    expect(screen.queryByText("Zincir tutarlı (yeniden hesaplandı)")).not.toBeInTheDocument();
    expect(screen.getByText(/Hiçbir kayıt yeniden hash'lenmedi/)).toBeInTheDocument();
  });

  it("shows a pass only when records were actually re-hashed", async () => {
    renderScreen(
      <AuditScreen />,
      stubFetch({
        "/studio/audit/verification": { ok: true, checked: 81_422, brokenAtSeq: null },
        "/studio/audit": EVENTS,
      }),
    );
    expect(await screen.findByText("Zincir tutarlı (yeniden hesaplandı)")).toBeInTheDocument();
  });

  it("still renders the trail when the chain is broken", async () => {
    // The events are the evidence an auditor came for; a failing integrity check
    // must not hide them.
    renderScreen(
      <AuditScreen />,
      stubFetch({
        "/studio/audit/verification": { ok: false, checked: 500, brokenAtSeq: 42 },
        "/studio/audit": EVENTS,
      }),
    );

    expect(await screen.findByText("Zincir bozuk")).toBeInTheDocument();
    expect(screen.getByText("UGURPAY-501")).toBeInTheDocument();
  });

  /** The fetch stub records string URLs — the ApiClient always calls with one. */
  const calledUrls = (fetchImpl: typeof fetch): string[] =>
    (fetchImpl as unknown as Mock).mock.calls.map((call) => String(call[0]));

  it("sends the applied filters with the trail query, widening dates to full days", async () => {
    const fetchImpl = stubFetch({
      "/studio/audit/verification": { ok: true, checked: 5, brokenAtSeq: null },
      "/studio/audit": EVENTS,
    });
    renderScreen(<AuditScreen />, fetchImpl);
    await screen.findByText("UGURPAY-501");

    await user.type(screen.getByLabelText("Aktör"), "ayse@corp");
    await user.type(screen.getByLabelText("Ara"), "ugurpay");
    fireEvent.change(screen.getByLabelText("Başlangıç"), { target: { value: "2026-08-09" } });
    // Typing alone must not query: the draft is applied only by "Getir".
    expect(calledUrls(fetchImpl).some((u) => u.includes("actor="))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Getir" }));

    await waitFor(() => {
      const filtered = calledUrls(fetchImpl).find((u) => u.includes("actor="));
      expect(filtered).toBeDefined();
      expect(filtered).toContain("actor=ayse%40corp");
      expect(filtered).toContain("q=ugurpay");
      // The date input's YYYY-MM-DD is widened to the day's first instant.
      expect(filtered).toContain(`from=${encodeURIComponent("2026-08-09T00:00:00.000Z")}`);
    });
  });

  it("downloads the applied window as one CSV through the authenticated client", async () => {
    const fetchImpl = stubFetch({
      "/studio/audit/verification": { ok: true, checked: 5, brokenAtSeq: null },
      "/studio/audit.csv": "seq,at,actor,action,subject,hash\n",
      "/studio/audit": EVENTS,
    });
    // jsdom implements neither object URLs nor anchor navigation; both are
    // stubbed so the test can assert the wiring rather than the browser.
    const createObjectURL = vi.fn(() => "blob:denetim");
    const revokeObjectURL = vi.fn();
    (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    try {
      renderScreen(<AuditScreen />, fetchImpl);
      await screen.findByText("UGURPAY-501");

      await user.type(screen.getByLabelText("Aktör"), "ayse@corp");
      await user.click(screen.getByRole("button", { name: "Getir" }));
      await user.click(screen.getByRole("button", { name: "CSV indir" }));

      await waitFor(() => {
        const csvCall = calledUrls(fetchImpl).find((u) => u.includes("/studio/audit.csv"));
        // The export carries the SAME applied filter the table shows.
        expect(csvCall).toContain("actor=ayse%40corp");
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:denetim");
        expect(click).toHaveBeenCalled();
      });
    } finally {
      click.mockRestore();
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    }
  });
});

describe("HelpScreen", () => {
  it("mirrors the sidebar's four groups as tabs, with the old ones gone", () => {
    renderScreen(<HelpScreen />, stubFetch({}));

    for (const name of ["İşler", "Ajanlar", "Denetim", "Kurulum"]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    // The start tab (default) now explains the daily-work pages. "Canlı akış"
    // is NOT among them any more: that guide described the retired pilot
    // engine's screen, and a guide to a page that no longer exists is worse
    // than no guide at all.
    expect(screen.getByText("Canlı oturumlar")).toBeInTheDocument();
    expect(screen.queryByText("Canlı akış")).not.toBeInTheDocument();
  });

  it("moves a group's pages with it — agents own the knowledge and template pages", async () => {
    renderScreen(<HelpScreen />, stubFetch({}));

    await user.click(screen.getByRole("tab", { name: "Ajanlar" }));

    expect(screen.getByText("Ajan tanımları")).toBeInTheDocument();
    expect(screen.getByText("Analiz şablonu")).toBeInTheDocument();
  });

  it("walks through the newer capabilities", () => {
    renderScreen(<HelpScreen />, stubFetch({}));

    expect(screen.getByText("Öne çıkan yetenekler")).toBeInTheDocument();
    expect(screen.getByText("Oto-başlatma ve hazır kurallar")).toBeInTheDocument();
    expect(screen.getByText("Onayın iki yolu: /approve yorumu ya da botla atama")).toBeInTheDocument();
    expect(screen.getByText("Ajan eğitimi: ajana özel ya da ortak bilgi")).toBeInTheDocument();
    expect(screen.getByText("Netleştirme döngüsü: bot sorar, sen cevaplarsın")).toBeInTheDocument();
    expect(screen.getByText("Denetim raporu: süz ve CSV indir")).toBeInTheDocument();
  });
});
