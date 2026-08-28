import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, afterEach } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { Session } from "../src/auth/types.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { ToastProvider } from "../src/ui/Toast.tsx";
import { ListeningScreen } from "../src/screens/Listening.tsx";

/**
 * Listening rules screen — status/issuetype → flow-type CRUD.
 *
 * The behaviours under test: the table renders the rules the endpoint returns,
 * the add-form is visible only to an admin (a viewer sees the read-only table),
 * creating a rule POSTs the typed fields, and the Jira status map round-trips
 * between the form and the wire without ever turning comment-only mode into
 * something else by accident (see the "Jira status map" block below).
 */

const ADMIN: Session = {
  userId: "ayse@x",
  username: "ayse",
  roles: ["admin"],
  groups: [],
  expiresAt: "2099-01-01T00:00:00.000Z",
  delegated: false,
  mustChangePassword: false,
};
const VIEWER: Session = { ...ADMIN, username: "can", roles: ["developer"] };

const SEED = {
  ruleId: "lr_1",
  projectKey: "OPS",
  assigneeAccountId: "712020:bot",
  matchKind: "issuetype",
  matchValue: "Hata",
  flowType: "duzeltme",
  priority: 100,
  enabled: true,
};

function renderScreen(session: Session): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <I18nProvider>
          <ToastProvider>
            <AuthProvider initialSession={session}>
              <ListeningScreen />
            </AuthProvider>
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** What the stub answers on POST /studio/listening-rules/seed-defaults. */
interface SeedAnswer {
  readonly status?: number;
  readonly body?: object;
}

/** A fetch stub that records POSTs and answers GET with the seeded rule. */
function stubFetch(rules: object[], seedAnswer: SeedAnswer = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    // Must be matched BEFORE the generic listening-rules POST — the seed URL
    // contains "/studio/listening-rules" as a substring.
    if (u.includes("/studio/listening-rules/seed-defaults")) {
      return Response.json(seedAnswer.body ?? { created: 4, skipped: 1, rules: [] }, {
        status: seedAnswer.status ?? 200,
      });
    }
    if (u.includes("/studio/listening-rules") && method === "GET") {
      return Response.json({ rules });
    }
    if (u.includes("/studio/listening-rules") && method === "POST") {
      return Response.json({ rule: { ...SEED, ruleId: "lr_new" } }, { status: 201 });
    }
    if (u.includes("/studio/listening-rules") && method === "PUT") {
      return Response.json({ rule: { ...SEED } }, { status: 200 });
    }
    // The assignee field pre-fills from a tested Jira connection's botAccountId.
    if (u.includes("/onboarding/jira-connections")) {
      return Response.json({ connections: [] });
    }
    // The project dropdown reads bound projects from /routing.
    if (u.includes("/routing")) {
      return Response.json({ projects: [{ projectKey: "OPS", trigger: "auto", apps: [], noteKey: "" }], rules: [], policy: null });
    }
    // The two agent dropdowns read the variant catalogue, filtered by role.
    if (u.includes("/variants")) {
      return Response.json({
        variants: [
          { variantId: "analyst-node-v2", role: "analyst", platform: "node", model: "m", activeVersion: 1, knowledgeFiles: 0, evalScore: null },
          { variantId: "engineer-node-v1", role: "engineer", platform: "node", model: "m", activeVersion: 1, knowledgeFiles: 0, evalScore: null },
          { variantId: "intake-v1", role: "intake", platform: "node", model: "m", activeVersion: 1, knowledgeFiles: 0, evalScore: null },
        ],
      });
    }
    return Response.json({}, { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("ListeningScreen", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the rules from the endpoint", async () => {
    stubFetch([SEED]);
    renderScreen(ADMIN);
    expect(await screen.findByText("Hata")).toBeTruthy();
    // The flow type is localized — it appears in the row badge (and also in the
    // admin form's dropdown), so assert at least one occurrence.
    expect(screen.getAllByText("Düzeltme").length).toBeGreaterThan(0);
  });

  it("shows the add-form to an admin", async () => {
    stubFetch([]);
    renderScreen(ADMIN);
    expect(await screen.findByText("Yeni kural ekle")).toBeTruthy();
  });

  it("hides the add-form from a viewer", async () => {
    stubFetch([SEED]);
    renderScreen(VIEWER);
    // The table still renders (read), but the form card does not.
    await waitFor(() => expect(screen.getByText("Hata")).toBeTruthy());
    expect(screen.queryByText("Yeni kural ekle")).toBeNull();
  });

  it("POSTs the typed fields when a rule is added", async () => {
    const fn = stubFetch([]);
    renderScreen(ADMIN);
    await screen.findByText("Yeni kural ekle");

    // Project is now a dropdown of bound projects, filled from /routing. Wait for
    // the option to arrive, then pick OPS. The two text fields (bot user + value)
    // are the first two textboxes once the project is a Select.
    await screen.findByRole("option", { name: "OPS" });
    await userEvent.selectOptions(screen.getByLabelText("Proje"), "OPS");
    const inputs = screen.getAllByRole("textbox");
    await userEvent.type(inputs[0]!, "712020:bot");
    await userEvent.type(inputs[1]!, "Hata");
    await userEvent.click(screen.getByRole("button", { name: "Kural ekle" }));

    await waitFor(() => {
      const posted = fn.mock.calls.find(
        (c) => String(c[0]).includes("/studio/listening-rules") && (c[1] as RequestInit)?.method === "POST",
      );
      expect(posted).toBeTruthy();
      const body = JSON.parse((posted![1] as RequestInit).body as string);
      expect(body.projectKey).toBe("OPS"); // picked from the dropdown, not typed
      expect(body.matchValue).toBe("Hata");
      expect(body.assigneeAccountId).toBe("712020:bot");
      // No agent picked → the "default agent" choice is sent as null, not "".
      expect(body.analystVariantId).toBeNull();
      expect(body.engineerVariantId).toBeNull();
    });
  });

  it("fills the agent selects from the variant catalogue, filtered by role", async () => {
    stubFetch([]);
    renderScreen(ADMIN);
    await screen.findByText("Yeni kural ekle");

    const analystSelect = (await screen.findByLabelText("Analiz ajanı")) as HTMLSelectElement;
    const engineerSelect = screen.getByLabelText("Geliştirme ajanı") as HTMLSelectElement;
    await waitFor(() => {
      // Each select: the "default agent" option plus ONLY its own role's variants.
      const analystValues = [...analystSelect.options].map((o) => o.value);
      expect(analystValues).toEqual(["", "analyst-node-v2"]);
      const engineerValues = [...engineerSelect.options].map((o) => o.value);
      expect(engineerValues).toEqual(["", "engineer-node-v1"]);
    });
  });

  it("POSTs the chosen agent variants when a rule is added", async () => {
    const fn = stubFetch([]);
    renderScreen(ADMIN);
    await screen.findByText("Yeni kural ekle");

    await screen.findByRole("option", { name: "OPS" });
    await userEvent.selectOptions(screen.getByLabelText("Proje"), "OPS");
    const inputs = screen.getAllByRole("textbox");
    await userEvent.type(inputs[0]!, "712020:bot");
    await userEvent.type(inputs[1]!, "Hata");
    await screen.findByRole("option", { name: "analyst-node-v2" });
    await userEvent.selectOptions(screen.getByLabelText("Analiz ajanı"), "analyst-node-v2");
    await userEvent.selectOptions(screen.getByLabelText("Geliştirme ajanı"), "engineer-node-v1");
    await userEvent.click(screen.getByRole("button", { name: "Kural ekle" }));

    await waitFor(() => {
      const posted = fn.mock.calls.find(
        (c) => String(c[0]).includes("/studio/listening-rules") && (c[1] as RequestInit)?.method === "POST",
      );
      expect(posted).toBeTruthy();
      const body = JSON.parse((posted![1] as RequestInit).body as string);
      expect(body.analystVariantId).toBe("analyst-node-v2");
      expect(body.engineerVariantId).toBe("engineer-node-v1");
    });
  });

  it("seeds the ready-made rules for the chosen project and reports the counts", async () => {
    const fn = stubFetch([]);
    renderScreen(ADMIN);
    await screen.findByText("Yeni kural ekle");

    // Pick the project explicitly, then load the defaults for it.
    await screen.findByRole("option", { name: "OPS" });
    await userEvent.selectOptions(screen.getByLabelText("Proje"), "OPS");
    await userEvent.click(screen.getByRole("button", { name: "Hazır kuralları yükle" }));

    await waitFor(() => {
      const posted = fn.mock.calls.find(
        (c) =>
          String(c[0]).includes("/studio/listening-rules/seed-defaults") &&
          (c[1] as RequestInit)?.method === "POST",
      );
      expect(posted).toBeTruthy();
      const body = JSON.parse((posted![1] as RequestInit).body as string);
      expect(body).toEqual({ projectKey: "OPS" });
    });
    // The result toast spells out what actually happened.
    expect(await screen.findByText("4 kural eklendi, 1 zaten vardı.")).toBeTruthy();
  });

  it("seeds without an explicit pick when exactly one project is bound", async () => {
    const fn = stubFetch([]);
    renderScreen(ADMIN);
    await screen.findByText("Yeni kural ekle");

    // OPS is the only bound project — no selection needed, it is used as-is.
    await screen.findByRole("option", { name: "OPS" });
    await userEvent.click(screen.getByRole("button", { name: "Hazır kuralları yükle" }));

    await waitFor(() => {
      const posted = fn.mock.calls.find(
        (c) =>
          String(c[0]).includes("/studio/listening-rules/seed-defaults") &&
          (c[1] as RequestInit)?.method === "POST",
      );
      expect(posted).toBeTruthy();
      expect(JSON.parse((posted![1] as RequestInit).body as string).projectKey).toBe("OPS");
    });
  });

  it("warns instead of celebrating when Jira's type list could not be read", async () => {
    // The fail-soft 200: nothing was seeded and the response names why.
    stubFetch([], { body: { created: 0, skipped: 0, rules: [], reason: "issue_types_unavailable" } });
    renderScreen(ADMIN);
    await screen.findByText("Yeni kural ekle");

    await screen.findByRole("option", { name: "OPS" });
    await userEvent.click(screen.getByRole("button", { name: "Hazır kuralları yükle" }));

    expect(
      await screen.findByText(/Jira iş türleri okunamadı.*Bağlantıyı test edip yeniden deneyin/),
    ).toBeTruthy();
    // Never the cheerful "0 kural eklendi" success line.
    expect(screen.queryByText(/kural eklendi/)).toBeNull();
  });

  it("shows the named 409 (no Jira connection) as an actionable Turkish message", async () => {
    stubFetch([], { status: 409, body: { error: "no_jira_connection" } });
    renderScreen(ADMIN);
    await screen.findByText("Yeni kural ekle");

    await screen.findByRole("option", { name: "OPS" });
    await userEvent.click(screen.getByRole("button", { name: "Hazır kuralları yükle" }));

    expect(await screen.findByText(/Etkin bir Jira bağlantısı yok/)).toBeTruthy();
  });

  /**
   * The silent half-setup, made loud (Bulgu B). A bound project with ZERO
   * rules listens to no ticket at all — the state a failed default seed leaves
   * behind, previously invisible: the binding looked green and this screen
   * just showed an empty table. The warning must name the project, and the
   * one-click way out must re-run the seed for exactly that project.
   */
  describe("bound project with no rules at all", () => {
    it("warns by name and re-seeds that project on click", async () => {
      const fn = stubFetch([]);
      renderScreen(ADMIN);

      // OPS is bound (the /routing stub) and the rule list is empty.
      expect(
        await screen.findByText(/OPS bağlı ama hiç dinleme kuralı yok/),
      ).toBeTruthy();
      expect(screen.getByText(/hiçbir ticket dinlenmiyor/)).toBeTruthy();

      await userEvent.click(
        screen.getByRole("button", { name: "Varsayılan kuralları yükle (OPS)" }),
      );
      await waitFor(() => {
        const posted = fn.mock.calls.find(
          (c) =>
            String(c[0]).includes("/studio/listening-rules/seed-defaults") &&
            (c[1] as RequestInit)?.method === "POST",
        );
        expect(posted).toBeTruthy();
        expect(JSON.parse((posted![1] as RequestInit).body as string).projectKey).toBe("OPS");
      });
    });

    it("does not warn when the bound project has a rule", async () => {
      stubFetch([SEED]); // SEED listens on OPS
      renderScreen(ADMIN);
      await screen.findByText("Hata");
      expect(screen.queryByText(/hiç dinleme kuralı yok/)).toBeNull();
    });

    it("shows the warning to a viewer too, but without the seed action", async () => {
      stubFetch([]);
      renderScreen(VIEWER);
      expect(
        await screen.findByText(/OPS bağlı ama hiç dinleme kuralı yok/),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Varsayılan kuralları yükle (OPS)" }),
      ).toBeNull();
    });
  });

  it("hides the seed button from a viewer", async () => {
    stubFetch([SEED]);
    renderScreen(VIEWER);
    await waitFor(() => expect(screen.getByText("Hata")).toBeTruthy());
    expect(screen.queryByText("Hazır kuralları yükle")).toBeNull();
  });

  /**
   * The Jira status map (durum eşlemesi).
   *
   * Until this landed the map could only be set by writing jsonb into Postgres
   * by hand, so the behaviours that matter are exactly the ones an operator
   * cannot verify from the outside: that the DEFAULT stays comment-only (the
   * key sends `statusMap: null`, never a map nobody asked for), that only the
   * points actually filled in are sent, that an existing rule's map comes BACK
   * into the form, and that emptying it returns the rule to comment-only rather
   * than leaving a `{}` that reads as "configured" in the table.
   */
  describe("Jira status map", () => {
    /** Fill the two required text fields and pick the project. */
    async function fillRequired(): Promise<void> {
      await screen.findByRole("option", { name: "OPS" });
      await userEvent.selectOptions(screen.getByLabelText("Proje"), "OPS");
      const inputs = screen.getAllByRole("textbox");
      await userEvent.type(inputs[0]!, "712020:bot");
      await userEvent.type(inputs[1]!, "Hata");
    }

    /**
     * Open the collapsed section and tick the opt-in — the two separate acts an
     * operator performs, in that order, before any status field exists.
     */
    async function optIn(): Promise<void> {
      await userEvent.click(screen.getByText("Jira durumunu da değiştir (isteğe bağlı)"));
      await userEvent.click(
        screen.getByLabelText("Bu kuralda ticket'ın Jira durumunu da değiştir"),
      );
    }

    /** The body of the one write the screen made, POST or PUT. */
    async function writtenBody(fn: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
      let body: Record<string, unknown> | undefined;
      await waitFor(() => {
        const call = fn.mock.calls.find((c) => {
          const method = (c[1] as RequestInit | undefined)?.method;
          return (
            String(c[0]).includes("/studio/listening-rules") &&
            (method === "POST" || method === "PUT") &&
            !String(c[0]).includes("seed-defaults")
          );
        });
        expect(call).toBeTruthy();
        body = JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
      });
      return body!;
    }

    it("sends no map at all when the operator never opts in", async () => {
      const fn = stubFetch([]);
      renderScreen(ADMIN);
      await screen.findByText("Yeni kural ekle");
      await fillRequired();
      await userEvent.click(screen.getByRole("button", { name: "Kural ekle" }));

      const body = await writtenBody(fn);
      // null, not {} and not a half-filled map: comment-only is the default and
      // the wire has to say so in the one shape the store recognises.
      expect(body.statusMap).toBeNull();
    });

    it("keeps the five status fields hidden until the toggle is on", async () => {
      stubFetch([]);
      renderScreen(ADMIN);
      await screen.findByText("Yeni kural ekle");
      // The section's summary is always there, and it starts CLOSED — the
      // default a rule gets is comment-only, so the map is not in the way.
      const summary = screen.getByText("Jira durumunu da değiştir (isteğe bağlı)");
      expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
      expect(screen.queryByLabelText("İş başladığında")).toBeNull();

      // Opening the disclosure explains the feature but does NOT enable it —
      // reading about moving tickets must not be the same act as opting in.
      await userEvent.click(summary);
      expect(screen.queryByLabelText("İş başladığında")).toBeNull();

      await userEvent.click(
        screen.getByLabelText("Bu kuralda ticket'ın Jira durumunu da değiştir"),
      );
      expect(await screen.findByLabelText("İş başladığında")).toBeTruthy();
      expect(screen.getByLabelText("İş bittiğinde")).toBeTruthy();
    });

    it("sends exactly the points that were filled in, and no key for the blank ones", async () => {
      const fn = stubFetch([]);
      renderScreen(ADMIN);
      await screen.findByText("Yeni kural ekle");
      await fillRequired();

      await optIn();
      await userEvent.type(await screen.findByLabelText("İş başladığında"), "Devam Ediyor");
      await userEvent.type(screen.getByLabelText("Analiz onaya çıktığında"), "İNCELEMEDE");
      await userEvent.type(screen.getByLabelText("İş bittiğinde"), "Tamam");
      await userEvent.click(screen.getByRole("button", { name: "Kural ekle" }));

      const body = await writtenBody(fn);
      // Three of five: the untouched points are ABSENT, not "" — an empty
      // string is a 400 from StatusMapSchema, not "leave the ticket alone".
      expect(body.statusMap).toEqual({
        onStart: "Devam Ediyor",
        onReview: "İNCELEMEDE",
        onDone: "Tamam",
      });
    });

    it("sends reassignOnNeedInfo on its own, without any status name", async () => {
      const fn = stubFetch([]);
      renderScreen(ADMIN);
      await screen.findByText("Yeni kural ekle");
      await fillRequired();

      await optIn();
      await userEvent.click(
        await screen.findByLabelText("Bilgi eksikken ticket'ı rapor edene geri ata"),
      );
      await userEvent.click(screen.getByRole("button", { name: "Kural ekle" }));

      // Handing the ticket back without moving it on the board is a real
      // configuration, so it must not collapse to "no map".
      expect((await writtenBody(fn)).statusMap).toEqual({ reassignOnNeedInfo: true });
    });

    it("loads an existing rule's map back into the form when it is edited", async () => {
      stubFetch([
        {
          ...SEED,
          statusMap: {
            onStart: "Devam Ediyor",
            onNeedInfo: "Yapılacaklar",
            onDone: "Tamam",
            reassignOnNeedInfo: true,
          },
        },
      ]);
      renderScreen(ADMIN);
      await screen.findByText("Hata");
      await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));

      // The disclosure springs open by itself — a configured map hidden behind
      // a closed summary is exactly the invisibility this screen exists to fix.
      const details = screen
        .getByText("Jira durumunu da değiştir (isteğe bağlı)")
        .closest("details") as HTMLDetailsElement;
      expect(details.open).toBe(true);

      const onStart = (await screen.findByLabelText("İş başladığında")) as HTMLInputElement;
      expect(onStart.value).toBe("Devam Ediyor");
      expect((screen.getByLabelText("Bilgi eksik olduğunda") as HTMLInputElement).value).toBe(
        "Yapılacaklar",
      );
      expect((screen.getByLabelText("İş bittiğinde") as HTMLInputElement).value).toBe("Tamam");
      // Points the stored map never had come back blank, not filled with junk.
      expect((screen.getByLabelText("Ret gelince") as HTMLInputElement).value).toBe("");
      expect(
        (screen.getByLabelText("Bilgi eksikken ticket'ı rapor edene geri ata") as HTMLInputElement)
          .checked,
      ).toBe(true);
    });

    it("returns a rule to comment-only mode when every field is cleared", async () => {
      const fn = stubFetch([
        { ...SEED, statusMap: { onStart: "Devam Ediyor", onDone: "Tamam" } },
      ]);
      renderScreen(ADMIN);
      await screen.findByText("Hata");
      await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));

      await userEvent.clear(await screen.findByLabelText("İş başladığında"));
      await userEvent.clear(screen.getByLabelText("İş bittiğinde"));
      await userEvent.click(screen.getByRole("button", { name: "Kuralı kaydet" }));

      const body = await writtenBody(fn);
      // null, NOT {}. An empty object would be a second way of saying
      // "comment-only" and the table would have to guess which one it is.
      expect(body.statusMap).toBeNull();
      expect(body.matchValue).toBe("Hata"); // the PUT is a full replace: the rest survives
    });

    it("also drops the map when the toggle itself is switched back off", async () => {
      const fn = stubFetch([{ ...SEED, statusMap: { onStart: "Devam Ediyor" } }]);
      renderScreen(ADMIN);
      await screen.findByText("Hata");
      await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));
      await screen.findByLabelText("İş başladığında");

      await userEvent.click(
        screen.getByLabelText("Bu kuralda ticket'ın Jira durumunu da değiştir"),
      );
      await userEvent.click(screen.getByRole("button", { name: "Kuralı kaydet" }));

      expect((await writtenBody(fn)).statusMap).toBeNull();
    });

    it("tells mapped rules from comment-only ones in the list", async () => {
      stubFetch([
        {
          ...SEED,
          ruleId: "lr_mapped",
          matchValue: "Hata",
          statusMap: { onStart: "Devam Ediyor", onDone: "Tamam" },
        },
        { ...SEED, ruleId: "lr_plain", matchValue: "Görev", statusMap: null },
      ]);
      renderScreen(VIEWER); // read-only: only the table renders, no form to confuse the query
      await screen.findByText("Hata");

      // The mapped rule shows the statuses it walks, in flow order.
      expect(screen.getByText("Devam Ediyor → Tamam")).toBeTruthy();
      // The unmapped one says so outright rather than leaving a blank cell.
      expect(screen.getByText("yorum")).toBeTruthy();
    });

    /**
     * The per-flow truth (audit finding #5). `planFor` gives `duzeltme` no
     * analysis gate, and the engine only calls `moveStatus("review"|"rejected")`
     * around that gate — on a düzeltme rule those two moments never occur, so a
     * status mapped there moves nothing, ever. The form used to offer all five
     * points for every flow anyway. These tests pin the honest form: the dead
     * points are disabled with the reason, the gating follows the flow SELECT
     * live, a stored dead value (written before this gating existed) is shown
     * and warned about rather than silently dropped, and the table cell tells
     * the walk from the values that will never fire.
     */
    describe("the moments a düzeltme flow can never reach", () => {
      const DEAD_REASON =
        "Hata düzeltme akışında analiz onayı adımı yoktur; bu an hiç gerçekleşmez.";

      it("disables the analysis-approval points while düzeltme is selected, and revives them on switch back", async () => {
        stubFetch([]);
        renderScreen(ADMIN);
        await screen.findByText("Yeni kural ekle");
        await optIn();

        // The default flow (analiz) walks the gate: all five points are live.
        const onReview = (await screen.findByLabelText(
          "Analiz onaya çıktığında",
        )) as HTMLInputElement;
        expect(onReview.disabled).toBe(false);
        expect(screen.queryByText(DEAD_REASON)).toBeNull();

        await userEvent.selectOptions(screen.getByLabelText("Ne yapılsın (akış)"), "duzeltme");
        expect(
          (screen.getByLabelText("Analiz onaya çıktığında") as HTMLInputElement).disabled,
        ).toBe(true);
        expect((screen.getByLabelText("Ret gelince") as HTMLInputElement).disabled).toBe(true);
        // Disabled WITH the reason, once per dead field — not a grey box the
        // operator has to explain to themselves.
        expect(screen.getAllByText(DEAD_REASON).length).toBe(2);
        expect((screen.getByLabelText("İş başladığında") as HTMLInputElement).disabled).toBe(
          false,
        );

        // The gating follows the flow select live, in both directions.
        await userEvent.selectOptions(screen.getByLabelText("Ne yapılsın (akış)"), "analiz");
        expect(
          (screen.getByLabelText("Analiz onaya çıktığında") as HTMLInputElement).disabled,
        ).toBe(false);
        expect(screen.queryByText(DEAD_REASON)).toBeNull();
      });

      it("shows — not silently drops — a stored onReview on a düzeltme rule, then saves without it", async () => {
        // A rule written BEFORE the forms gated by flow: `SEED.flowType` is
        // düzeltme, and its map carries the moment that flow can never reach.
        const fn = stubFetch([
          {
            ...SEED,
            statusMap: { onStart: "Devam Ediyor", onReview: "İNCELEMEDE", onDone: "Tamam" },
          },
        ]);
        renderScreen(ADMIN);
        await screen.findByText("Hata");
        await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));

        // Loads without crashing, and the stored value is VISIBLE — disabled
        // with the reason, not swallowed on the way into the form.
        const onReview = (await screen.findByLabelText(
          "Analiz onaya çıktığında",
        )) as HTMLInputElement;
        expect(onReview.value).toBe("İNCELEMEDE");
        expect(onReview.disabled).toBe(true);

        // The warning names the exact value and says what saving will do, so
        // the save that follows is the operator's informed confirmation.
        expect(
          screen.getByText(/Analiz onaya çıktığında: İNCELEMEDE/),
        ).toBeTruthy();
        expect(screen.getByText(/kaydederseniz bu değerler kurala yazılmaz/)).toBeTruthy();

        await userEvent.click(screen.getByRole("button", { name: "Kuralı kaydet" }));
        const body = await writtenBody(fn);
        // The dead value is gone from the wire; the live moments survive.
        expect(body.statusMap).toEqual({ onStart: "Devam Ediyor", onDone: "Tamam" });
      });

      it("marks the dead value in the table instead of showing it as part of the walk", async () => {
        stubFetch([
          {
            ...SEED,
            ruleId: "lr_dead",
            statusMap: { onStart: "Devam Ediyor", onReview: "İNCELEMEDE", onDone: "Tamam" },
          },
          {
            ...SEED,
            ruleId: "lr_live",
            matchValue: "Görev",
            flowType: "analiz",
            statusMap: { onStart: "Devam Ediyor", onReview: "İNCELEMEDE", onDone: "Tamam" },
          },
        ]);
        renderScreen(VIEWER); // read-only: only the table renders
        await screen.findByText("Hata");

        // The düzeltme rule's walk holds only the moments its flow can reach …
        expect(screen.getByText("Devam Ediyor → Tamam")).toBeTruthy();
        // … its stored dead value stays visible, marked as never occurring …
        expect(screen.getByText(/gerçekleşmez: İNCELEMEDE/)).toBeTruthy();
        // … while the SAME map on an analiz rule keeps its full walk.
        expect(screen.getByText("Devam Ediyor → İNCELEMEDE → Tamam")).toBeTruthy();
      });
    });
  });

  it("shows the rule's chosen agents in the list, or 'varsayılan' when unset", async () => {
    stubFetch([
      { ...SEED, analystVariantId: "analyst-node-v2", engineerVariantId: null },
    ]);
    renderScreen(VIEWER); // read-only: the table alone renders the agents cell
    await screen.findByText("Hata");
    expect(screen.getByText("analyst-node-v2")).toBeTruthy();
    expect(screen.getByText("varsayılan")).toBeTruthy();
  });

  /**
   * The English name beside the Turkish one.
   *
   * Half the bank runs the Jira UI in English and goes looking for `Task` and
   * `Bug`; the rules only ever said `Görev` and `Hata`. The aside is the fix —
   * and it is a LABEL, never a value. `flow-decision.ts` compares `matchValue`
   * to `fields.issuetype.name` verbatim (OPS-66 really does carry `Görev`), so
   * a rule holding `Task` matches nothing, silently, forever. That is the bug
   * fixed today and the one these tests exist to keep fixed.
   */
  describe("the English name beside the Turkish one", () => {
    it("shows both names in the table while the stored value stays Turkish", async () => {
      stubFetch([SEED, { ...SEED, ruleId: "lr_2", matchValue: "Görev", flowType: "analiz" }]);
      renderScreen(VIEWER); // read-only: no form dropdown to confuse the query

      // The stored value is its own element, so what a reader copies out of the
      // cell is exactly what the rule holds …
      expect(await screen.findByText("Hata")).toBeTruthy();
      expect(screen.getByText("Görev")).toBeTruthy();
      // … and the English name sits beside it, never inside it.
      expect(screen.getByText("(İngilizce: Bug)")).toBeTruthy();
      expect(screen.getByText("(İngilizce: Task)")).toBeTruthy();
      // Nothing anywhere merged the two into one string.
      expect(screen.queryByText("Hata (Bug)")).toBeNull();
    });

    it("says nothing extra for a name outside the standard set", async () => {
      stubFetch([{ ...SEED, matchValue: "Talep" }]);
      renderScreen(VIEWER);

      // A bank's own custom type. Inventing "Request" here would be exactly the
      // confident wrong answer the mapping refuses to make.
      expect(await screen.findByText("Talep")).toBeTruthy();
      expect(screen.queryByText(/İngilizce:/)).toBeNull();
    });
  });

  /**
   * "Bota atanan her ticket" (migration 0020) on the expert screen.
   *
   * The wizard's tests cover the guided path; this one covers the screen an
   * admin uses to write the same rule by hand, and the two things that must be
   * true there: the value field disappears, and the rule still saves.
   */
  describe("every ticket assigned to the bot", () => {
    it("POSTs matchKind assigned with the placeholder value, and no value field is asked for", async () => {
      const fn = stubFetch([]);
      renderScreen(ADMIN);
      await screen.findByText("Yeni kural ekle");

      await screen.findByRole("option", { name: "OPS" });
      await userEvent.selectOptions(screen.getByLabelText("Proje"), "OPS");
      await userEvent.type(
        screen.getByLabelText("Bot kullanıcısı"),
        "712020:bot",
      );
      // Present for a conditioned kind …
      expect(screen.getByLabelText("Değer")).toBeTruthy();
      await userEvent.selectOptions(screen.getByLabelText("Neye göre eşleşsin"), "assigned");
      // … and gone for the catch-all, which has no second question to ask.
      expect(screen.queryByLabelText("Değer")).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Kural ekle" }));

      await waitFor(() => {
        const post = fn.mock.calls.find(
          ([u, init]) =>
            String(u).includes("/studio/listening-rules") &&
            (init as RequestInit | undefined)?.method === "POST",
        );
        expect(post, "no rule was POSTed").toBeTruthy();
        const body = JSON.parse(String((post![1] as RequestInit).body)) as Record<string, unknown>;
        expect(body.matchKind).toBe("assigned");
        // The literal the BFF pins anyway — sent so the client is not asking
        // the server to fix up its payload. It is never compared to a ticket.
        expect(body.matchValue).toBe("*");
      });
    });

    it("renders such a rule by what it does, never by its placeholder value", async () => {
      stubFetch([{ ...SEED, matchKind: "assigned", matchValue: "*" }]);
      renderScreen(VIEWER);

      expect(await screen.findByText("Bota atanan her ticket")).toBeTruthy();
      // Printing `*` would invite an operator to go looking for a Jira status
      // named "*" — it is storage, not a trigger anybody set.
      expect(screen.queryByText("*")).toBeNull();
    });
  });
});
