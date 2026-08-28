import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SetupScreen } from "../src/screens/Setup.tsx";
import { ADMIN, VIEWER, renderScreen, stubFetch, type Route } from "./harness.tsx";

/**
 * The guided setup wizard (Kurulum sihirbazı).
 *
 * `/projects` can already set everything this screen sets; the wizard exists
 * because a bank operator cannot be expected to know WHICH of its three tabs
 * they need, or that the Jira status map is buried inside one of the forms. So
 * the behaviours worth testing are not "does a select render" but the promises
 * the wizard makes to that operator:
 *
 *  · the happy path actually writes the rule it summarised, with the flow they
 *    picked and — because they never opted in — no status map at all;
 *  · turning the map on sends ONLY the points they filled, never `""` for the
 *    blank ones (which the BFF answers with a 400 for the whole rule);
 *  · going back does not eat what was typed, which is the single failure that
 *    makes a wizard worse than the form it replaced;
 *  · a duplicate rule comes back as a sentence about what already exists, not
 *    as `duplicate_listening_rule`;
 *  · a missing prerequisite is NAMED, so the operator knows they need a Jira
 *    connection rather than that "something went wrong".
 */

const JIRA_CONN = {
  id: "jira-1",
  kind: "jira_cloud",
  displayName: "UgurBank Jira",
  botAccountId: "712020:bot",
};
const SCM_CONN = { id: "scm-1", kind: "github", displayName: "UgurBank GitHub" };

/** The live OPS project's real status names, as the endpoint returns them. */
const OPS_STATUSES = ["İNCELEMEDE", "Yapılacaklar", "Tamam", "Devam Ediyor"];
const OPS_ISSUE_TYPES = ["Hata", "Görev", "Alt görev"];

/**
 * The endpoints the wizard reads on mount and as the operator advances.
 *
 * `/onboarding/jira-match-values` answers by `kind`, which the stub cannot see
 * (the harness matches on pathname only), so the tests that care about the
 * distinction override this route with their own body.
 */
function baseRoutes(overrides: readonly Route[] = []): Route[] {
  const routes: Route[] = [
    { path: "/onboarding/options", body: { jiraProjects: [], adoRepos: [], platforms: ["linux-node"] } },
    { path: "/onboarding/jira-connections", body: { connections: [JIRA_CONN] } },
    { path: "/onboarding/scm-connections", body: { connections: [SCM_CONN] } },
    {
      path: "/onboarding/jira-projects",
      body: { ok: true, projects: [{ key: "OPS", name: "Operasyon" }] },
    },
    {
      path: "/onboarding/scm-repos",
      body: { ok: true, repos: [{ id: "r1", fullName: "Uguryldz/maestro-pilot" }] },
    },
    { path: "/onboarding/jira-match-values", body: { ok: true, values: OPS_ISSUE_TYPES } },
    { path: "/routing", body: { projects: [], rules: [], policy: null } },
    { path: "/studio/listening-rules", method: "POST", status: 201, body: { rule: { ruleId: "lr_1" } } },
    { path: "/onboarding", method: "POST", body: { proposalId: "pr_1" } },
  ];
  // An override REPLACES the route with the same path+method rather than being
  // appended: the harness matches the first hit, so appending would be ignored.
  const result = routes.filter(
    (r) =>
      !overrides.some((o) => o.path === r.path && (o.method ?? "GET") === (r.method ?? "GET")),
  );
  return [...overrides, ...result];
}

/** Walk step 1 → step 2 by accepting the default flow, or picking another. */
async function chooseFlow(flow?: "duzeltme" | "gelistirme"): Promise<void> {
  await screen.findByText("Ne yapmak istiyorsunuz?");
  if (flow !== undefined) {
    const label = flow === "duzeltme" ? "Hata düzeltme" : "Yeni özellik geliştirme";
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(label) }));
  }
  await userEvent.click(screen.getByRole("button", { name: "İleri" }));
}

/** Fill step 2 (project + repo + platform) and move on. */
async function fillProject(): Promise<void> {
  await screen.findByText("Hangi Jira projesi, hangi uygulama?");
  await userEvent.selectOptions(screen.getByLabelText("Jira bağlantısı"), "jira-1");
  await screen.findByRole("option", { name: "OPS · Operasyon" });
  await userEvent.selectOptions(screen.getByLabelText("Jira projesi"), "OPS");
  await userEvent.selectOptions(screen.getByLabelText("Kod deposu bağlantısı"), "scm-1");
  await screen.findByRole("option", { name: "Uguryldz/maestro-pilot" });
  await userEvent.selectOptions(screen.getByLabelText("Kod deposu"), "Uguryldz/maestro-pilot");
  await userEvent.selectOptions(screen.getByLabelText("Uygulamanın teknolojisi"), "linux-node");
  await userEvent.click(screen.getByRole("button", { name: "İleri" }));
}

/**
 * Fill step 3 (which tickets) and move on.
 *
 * `value` is the LOCALISED name Jira serves and the rule stores; `label` is
 * what the operator reads, which now carries the English name beside it. The
 * two are looked up separately on purpose — selecting by value while finding by
 * label is the round trip that proves the dropdown shows one string and sends
 * another.
 */
async function fillTickets(value = "Hata", label = "Hata (Bug)"): Promise<void> {
  await screen.findByText("Hangi ticket'ları alsın?");
  // The value list is read live off the project, so it is a dropdown.
  await screen.findByRole("option", { name: label });
  await userEvent.selectOptions(screen.getByLabelText("Hangi değer?"), value);
  await userEvent.click(screen.getByRole("button", { name: "İleri" }));
}

/** The body of the POST that created the listening rule. */
function ruleBody(calls: readonly { url: string; method: string; body: unknown }[]): Record<string, unknown> {
  const call = calls.find(
    (c) => c.url.includes("/studio/listening-rules") && c.method === "POST",
  );
  expect(call, "the wizard never POSTed a listening rule").toBeTruthy();
  return call!.body as Record<string, unknown>;
}

describe("setup wizard", () => {
  it("opens on the flow question, described by outcome rather than by jargon", async () => {
    const { fetchImpl } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await screen.findByText("Ne yapmak istiyorsunuz?");
    // The three flows, each with the sentence that says what it DOES. Nothing
    // on this screen says "risk_tiered" or "opt_in" — that is the whole point.
    expect(
      screen.getByText("Maestro talebi inceleyip analiz belgesi hazırlasın; kod yazmasın."),
    ).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Hata düzeltme/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Yeni özellik geliştirme/ })).toBeTruthy();
    // Analysis leads: a first-time operator clicking straight through must end
    // up with the flow that cannot touch a repository.
    expect((screen.getByRole("radio", { name: /Yalnızca analiz/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("creates the rule with the chosen flow and no status map on the happy path", async () => {
    const { fetchImpl, calls } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await chooseFlow("duzeltme");
    await fillProject();
    await fillTickets();

    // Step 4 is skipped without touching it — the wizard says so on the button.
    await screen.findByText("Jira durumlarını da değiştirsin mi?");
    expect(screen.getByText("Bu adım isteğe bağlı; dokunmadan geçebilirsiniz.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));

    // Step 5 spells the configuration back as sentences, not as a field dump.
    await screen.findByText("Özet");
    expect(
      screen.getByText(
        "OPS projesinde, bota atanmış ve İş tipi değeri \"Hata (Bug)\" olan ticket'lar Hata düzeltme akışıyla çalışacak.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Maestro ticket'a yalnızca yorum yazacak; panodaki durumunu hiç değiştirmeyecek.",
      ),
    ).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    await waitFor(() => {
      const body = ruleBody(calls);
      expect(body.projectKey).toBe("OPS");
      expect(body.matchKind).toBe("issuetype");
      expect(body.matchValue).toBe("Hata");
      expect(body.flowType).toBe("duzeltme");
      // The bot account pre-filled itself from the tested connection — the
      // operator never hand-copied a 40-char GUID.
      expect(body.assigneeAccountId).toBe("712020:bot");
      // Comment-only is the default, and `null` is the ONE shape that says so.
      expect(body.statusMap).toBeNull();
    });
  });

  it("files the binding proposal with the defaults the chosen flow implies", async () => {
    const { fetchImpl, calls } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await chooseFlow("gelistirme");
    await fillProject();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST");
      expect(call, "no binding proposal was filed").toBeTruthy();
      // The operator answered ONE question ("yeni özellik geliştirme"); the
      // three the expert screen would have asked fall out of it.
      expect(call!.body).toEqual({
        jiraProject: "OPS",
        adoRepo: "Uguryldz/maestro-pilot",
        platform: "linux-node",
        triggerMode: "opt_in",
        gateSet: "always_six",
        mergeMode: "human",
        // The data class the operator was ASKED for, defaulted to the
        // safe-but-workable class rather than left to the server's fail-closed
        // `gizli` — the assumption that silently disabled SAM1's analysis.
        dataClass: "dahili",
      });
    });
  });

  it("says the binding waits for a second admin rather than looking like a failure", async () => {
    const { fetchImpl } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await chooseFlow();
    await fillProject();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));

    // Stated BEFORE the button, so the wait is expected rather than discovered.
    await screen.findByText("Özet");
    expect(screen.getByText(/ikinci bir yöneticinin onayını bekler/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    // And again afterwards, with the two concrete next actions.
    expect(await screen.findByText("Kurulum tamam")).toBeTruthy();
    expect(screen.getByText(/ikinci bir yöneticinin onayını bekliyor/)).toBeTruthy();
    expect(
      screen.getByText(
        "OPS projesinde İş tipi değeri \"Hata (Bug)\" olan bir ticket açın (ya da mevcut birini o değere getirin).",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Ticket'ı Maestro botuna atayın/)).toBeTruthy();
  });

  it("skips the binding proposal when the project is already bound, and says so", async () => {
    const { fetchImpl, calls } = stubFetch(
      baseRoutes([
        {
          path: "/routing",
          body: {
            projects: [{ projectKey: "OPS", trigger: "label", apps: [], noteKey: "" }],
            rules: [],
            policy: null,
          },
        },
      ]),
    );
    renderScreen(<SetupScreen />, { fetchImpl });

    await chooseFlow();
    await fillProject();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await screen.findByText("Özet");

    // Promising a four-eyes approval for a live binding sends the operator
    // looking for an approval queue that has nothing in it.
    expect(
      screen.getByText(/OPS projesi zaten bağlı; yeni bir bağlama önerisi oluşturulmayacak/),
    ).toBeTruthy();
    expect(screen.queryByText(/ikinci bir yöneticinin onayını bekler/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
    await screen.findByText("Kurulum tamam");
    expect(calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST")).toBeUndefined();
  });

  describe("the optional status map", () => {
    /** Step 4 with the live status list, which needs kind=status to answer. */
    function statusRoutes(): Route[] {
      return baseRoutes([
        // Both kinds come off one path, and the harness cannot see `kind`. The
        // free-text fallback is what these tests exercise, so answer `ok:false`
        // and let both fields fall back — the behaviour when Jira is unreadable
        // is the one an operator is most likely to meet on a fresh install.
        { path: "/onboarding/jira-match-values", body: { ok: false, messageKey: "error.unexpected" } },
      ]);
    }

    async function reachStatusStep(flow?: "duzeltme" | "gelistirme"): Promise<void> {
      await chooseFlow(flow);
      await fillProject();
      // With no live list the value is a free-text field.
      await screen.findByText("Hangi ticket'ları alsın?");
      await userEvent.type(screen.getByLabelText("Hangi değer?"), "Hata");
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await screen.findByText("Jira durumlarını da değiştirsin mi?");
    }

    it("keeps the five points hidden until the operator turns the map on", async () => {
      const { fetchImpl } = stubFetch(statusRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await reachStatusStep();

      // Reading the step must not be the same act as opting into it.
      expect(screen.queryByLabelText("İş başladığında")).toBeNull();
      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
      expect(await screen.findByLabelText("İş başladığında")).toBeTruthy();
      expect(screen.getByLabelText("İş bittiğinde")).toBeTruthy();
    });

    it("sends only the points that were filled in, never \"\" for the blank ones", async () => {
      const { fetchImpl, calls } = stubFetch(statusRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await reachStatusStep();

      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
      await userEvent.type(await screen.findByLabelText("İş başladığında"), "Devam Ediyor");
      await userEvent.type(screen.getByLabelText("İş bittiğinde"), "Tamam");
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));

      // The summary lists exactly the two points, in flow order.
      await screen.findByText("Özet");
      const list = screen.getByText("Ticket panoda ne olacak").nextElementSibling as HTMLElement;
      expect(within(list).getByText("Devam Ediyor")).toBeTruthy();
      expect(within(list).getByText("Tamam")).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
      await waitFor(() => {
        // Two of five. The other three are ABSENT, not "": an empty string is a
        // 400 from StatusMapSchema for the whole rule, not "leave the ticket
        // alone at this step".
        expect(ruleBody(calls).statusMap).toEqual({ onStart: "Devam Ediyor", onDone: "Tamam" });
      });
    });

    it("folds an opted-in but empty map back to comment-only", async () => {
      const { fetchImpl, calls } = stubFetch(statusRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await reachStatusStep();

      // Ticking the box and filling nothing is not a configuration; it must not
      // become a `{}` that reads as "this rule moves tickets".
      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
      await screen.findByLabelText("İş başladığında");
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));

      await screen.findByText("Özet");
      expect(
        screen.getByText(
          "Maestro ticket'a yalnızca yorum yazacak; panodaki durumunu hiç değiştirmeyecek.",
        ),
      ).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
      await waitFor(() => expect(ruleBody(calls).statusMap).toBeNull());
    });

    it("sends reassignOnNeedInfo on its own, with no status name at all", async () => {
      const { fetchImpl, calls } = stubFetch(statusRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await reachStatusStep();

      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
      await userEvent.click(
        await screen.findByLabelText("Bilgi eksikken ticket'ı rapor edene geri ata"),
      );
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await screen.findByText("Özet");
      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

      // Handing the ticket back without moving it on the board IS a real
      // configuration, so it must not collapse to "no map".
      await waitFor(() =>
        expect(ruleBody(calls).statusMap).toEqual({ reassignOnNeedInfo: true }),
      );
    });

    it("offers the project's real statuses when Jira can be read", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([
          { path: "/onboarding/jira-match-values", body: { ok: true, values: OPS_STATUSES } },
        ]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
      await fillProject();
      // With a live list every value is picked, never spelled.
      await fillTickets("İNCELEMEDE", "İNCELEMEDE (In Review)");
      await screen.findByText("Jira durumlarını da değiştirsin mi?");
      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));

      const onStart = (await screen.findByLabelText("İş başladığında")) as HTMLSelectElement;
      expect([...onStart.options].map((o) => o.value)).toEqual(["", ...OPS_STATUSES]);
    });

    /**
     * The per-flow truth (audit finding #5). `planFor` gives `duzeltme` no
     * analysis gate, and the engine only calls `moveStatus("review"|"rejected")`
     * around that gate — so on a düzeltme rule those two moments simply never
     * occur. The wizard used to offer all five points anyway, the summary
     * confirmed the mapping, and the ticket never moved, with no warning ever.
     * These tests pin the honest rendering: dead points are DISABLED with the
     * reason (never silently offered as live), absent from the summary the
     * operator signs off on, and absent from the wire.
     */
    describe("the moments a düzeltme flow can never reach", () => {
      const DEAD_REASON =
        "Hata düzeltme akışında analiz onayı adımı yoktur; bu an hiç gerçekleşmez.";

      it("disables the two analysis-approval points with the reason, and keeps them off the summary and the wire", async () => {
        const { fetchImpl, calls } = stubFetch(statusRoutes());
        renderScreen(<SetupScreen />, { fetchImpl });
        await reachStatusStep("duzeltme");

        await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));

        // Disabled, not hidden: an operator who saw five points on an analiz
        // rule must read WHY this rule has three, not wonder where two went.
        const onReview = (await screen.findByLabelText(
          "Analiz onaya çıktığında",
        )) as HTMLInputElement;
        const onRejected = screen.getByLabelText("Ret gelince") as HTMLInputElement;
        expect(onReview.disabled).toBe(true);
        expect(onRejected.disabled).toBe(true);
        // Each dead field carries the reason in place of its usual hint.
        expect(screen.getAllByText(DEAD_REASON).length).toBe(2);
        // The three moments the flow DOES reach stay usable.
        expect((screen.getByLabelText("İş başladığında") as HTMLInputElement).disabled).toBe(false);
        expect(
          (screen.getByLabelText("Bilgi eksik olduğunda") as HTMLInputElement).disabled,
        ).toBe(false);
        expect((screen.getByLabelText("İş bittiğinde") as HTMLInputElement).disabled).toBe(false);

        await userEvent.type(screen.getByLabelText("İş başladığında"), "Devam Ediyor");
        await userEvent.type(screen.getByLabelText("İş bittiğinde"), "Tamam");
        await userEvent.click(screen.getByRole("button", { name: "İleri" }));

        // The summary lists only the moments that will actually fire.
        await screen.findByText("Özet");
        const list = screen.getByText("Ticket panoda ne olacak").nextElementSibling as HTMLElement;
        expect(within(list).getByText("Devam Ediyor")).toBeTruthy();
        expect(within(list).getByText("Tamam")).toBeTruthy();
        expect(within(list).queryByText(/Analiz onaya çıktığında|Ret gelince/)).toBeNull();

        await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
        await waitFor(() =>
          expect(ruleBody(calls).statusMap).toEqual({ onStart: "Devam Ediyor", onDone: "Tamam" }),
        );
      });

      it("keeps a value typed under analiz visible but off the wire after a switch to düzeltme", async () => {
        const { fetchImpl, calls } = stubFetch(statusRoutes());
        renderScreen(<SetupScreen />, { fetchImpl });
        await reachStatusStep();

        // Typed while the flow was analiz, where the moment is live.
        await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
        await userEvent.type(
          await screen.findByLabelText("Analiz onaya çıktığında"),
          "İNCELEMEDE",
        );
        await userEvent.type(screen.getByLabelText("İş bittiğinde"), "Tamam");

        // Walk back to step 1 and change the one answer that decides what can fire.
        await userEvent.click(screen.getByRole("button", { name: "Geri" }));
        await userEvent.click(screen.getByRole("button", { name: "Geri" }));
        await userEvent.click(screen.getByRole("button", { name: "Geri" }));
        await screen.findByText("Ne yapmak istiyorsunuz?");
        await userEvent.click(screen.getByRole("radio", { name: /Hata düzeltme/ }));
        await userEvent.click(screen.getByRole("button", { name: "İleri" }));
        await screen.findByText("Hangi Jira projesi, hangi uygulama?");
        await userEvent.click(screen.getByRole("button", { name: "İleri" }));
        await screen.findByText("Hangi ticket'ları alsın?");
        await userEvent.click(screen.getByRole("button", { name: "İleri" }));
        await screen.findByText("Jira durumlarını da değiştirsin mi?");

        // What was typed is not eaten — it is visible, disabled, explained …
        const onReview = (await screen.findByLabelText(
          "Analiz onaya çıktığında",
        )) as HTMLInputElement;
        expect(onReview.value).toBe("İNCELEMEDE");
        expect(onReview.disabled).toBe(true);

        await userEvent.click(screen.getByRole("button", { name: "İleri" }));
        // … but the summary the operator signs off on does not promise it …
        await screen.findByText("Özet");
        const list = screen.getByText("Ticket panoda ne olacak").nextElementSibling as HTMLElement;
        expect(within(list).queryByText("İNCELEMEDE")).toBeNull();

        await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
        // … and the wire carries only the moment düzeltme can reach.
        await waitFor(() => expect(ruleBody(calls).statusMap).toEqual({ onDone: "Tamam" }));
      });

      it("gates nothing for analiz, whose flow walks every moment", async () => {
        const { fetchImpl } = stubFetch(statusRoutes());
        renderScreen(<SetupScreen />, { fetchImpl });
        await reachStatusStep();

        await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
        await screen.findByLabelText("İş başladığında");
        // All five, live — the fix must not shrink the flows it never applied to.
        for (const label of [
          "İş başladığında",
          "Bilgi eksik olduğunda",
          "Analiz onaya çıktığında",
          "Ret gelince",
          "İş bittiğinde",
        ]) {
          expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(false);
        }
        expect(screen.queryByText(DEAD_REASON)).toBeNull();
      });

      it("gates nothing for gelistirme either", async () => {
        const { fetchImpl } = stubFetch(statusRoutes());
        renderScreen(<SetupScreen />, { fetchImpl });
        await reachStatusStep("gelistirme");

        await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
        await screen.findByLabelText("İş başladığında");
        expect(
          (screen.getByLabelText("Analiz onaya çıktığında") as HTMLInputElement).disabled,
        ).toBe(false);
        expect((screen.getByLabelText("Ret gelince") as HTMLInputElement).disabled).toBe(false);
        expect(screen.queryByText(DEAD_REASON)).toBeNull();
      });
    });
  });

  describe("navigation", () => {
    it("preserves every answer when the operator walks back through the steps", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([
          { path: "/onboarding/jira-match-values", body: { ok: false, messageKey: "error.unexpected" } },
        ]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow("gelistirme");
      await fillProject();
      await screen.findByText("Hangi ticket'ları alsın?");
      await userEvent.type(screen.getByLabelText("Hangi değer?"), "Özellik");
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));

      // Turn the map on and type into it, so there is state on FOUR steps.
      await screen.findByText("Jira durumlarını da değiştirsin mi?");
      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
      await userEvent.type(await screen.findByLabelText("İş başladığında"), "Devam Ediyor");

      // All the way back to step 1 …
      const back = screen.getByRole("button", { name: "Geri" });
      await userEvent.click(back);
      await userEvent.click(screen.getByRole("button", { name: "Geri" }));
      await userEvent.click(screen.getByRole("button", { name: "Geri" }));
      await screen.findByText("Ne yapmak istiyorsunuz?");
      expect(
        (screen.getByRole("radio", { name: /Yeni özellik geliştirme/ }) as HTMLInputElement).checked,
      ).toBe(true);

      // … and forward again. Nothing was dropped by the round trip: "geri
      // gidince yazdıklarım gitti" is what makes a wizard worse than a form.
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await screen.findByText("Hangi Jira projesi, hangi uygulama?");
      expect((screen.getByLabelText("Jira projesi") as HTMLSelectElement).value).toBe("OPS");
      expect((screen.getByLabelText("Kod deposu") as HTMLSelectElement).value).toBe(
        "Uguryldz/maestro-pilot",
      );
      expect((screen.getByLabelText("Uygulamanın teknolojisi") as HTMLSelectElement).value).toBe(
        "linux-node",
      );

      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await screen.findByText("Hangi ticket'ları alsın?");
      expect((screen.getByLabelText("Hangi değer?") as HTMLInputElement).value).toBe("Özellik");

      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await screen.findByText("Jira durumlarını da değiştirsin mi?");
      expect(
        (screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin") as HTMLInputElement)
          .checked,
      ).toBe(true);
      expect((screen.getByLabelText("İş başladığında") as HTMLInputElement).value).toBe(
        "Devam Ediyor",
      );
    });

    it("says WHICH answer is missing instead of just disabling the button", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
      await screen.findByText("Hangi Jira projesi, hangi uygulama?");

      // Nothing picked yet: the first thing that is missing, named.
      expect(
        await screen.findByText("Devam etmek için bir Jira bağlantısı seçin."),
      ).toBeTruthy();
      expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(
        true,
      );

      // Answering it moves the complaint to the NEXT missing answer rather than
      // leaving a stale one on screen.
      await userEvent.selectOptions(screen.getByLabelText("Jira bağlantısı"), "jira-1");
      expect(
        await screen.findByText(
          "Devam etmek için Maestro'nun çalışacağı Jira projesini seçin.",
        ),
      ).toBeTruthy();
    });
  });

  describe("things the operator cannot fix from here", () => {
    it("names the missing Jira connection and links to where it is added", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([{ path: "/onboarding/jira-connections", body: { connections: [] } }]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      // The NOUN is in the sentence — "bir şeyler eksik" is what generates a
      // support ticket instead of resolving one.
      expect(await screen.findByText(/Hiç Jira bağlantısı tanımlı değil/)).toBeTruthy();
      const link = screen.getByRole("link", { name: "Ayarlar & bağlantılar'a git" });
      expect(link.getAttribute("href")).toBe("/settings");
    });

    it("names the missing repository connection once a code-writing flow is picked", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([{ path: "/onboarding/scm-connections", body: { connections: [] } }]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      // On the default flow (analiz) the card must NOT appear: the repository
      // is an offer there, and "kurulum yapılamaz" would be a false sentence
      // for the analysis-only team this install may well be.
      await screen.findByText("Ne yapmak istiyorsunuz?");
      expect(screen.queryByText(/Hiç kod deposu bağlantısı tanımlı değil/)).toBeNull();

      // Pick a flow that genuinely needs the repository, and the prerequisite
      // is named — noun, fix, and where.
      await userEvent.click(screen.getByRole("radio", { name: /Hata düzeltme/ }));
      expect(await screen.findByText(/Hiç kod deposu bağlantısı tanımlı değil/)).toBeTruthy();
    });

    /**
     * The wizard must not offer a flow this install cannot serve.
     *
     * This is the failure the whole change is about, seen from the operator's
     * side: pick "Yeni özellik geliştirme", save the rule, and the run walks
     * intake → analysis → publication → a human's approval before dying at the
     * step that needed a repository. Every one of those steps was real work,
     * and the missing piece was knowable before the first click.
     */
    it("stops a code-writing flow while no repository connection exists, and says why", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([{ path: "/onboarding/scm-connections", body: { connections: [] } }]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await userEvent.click(await screen.findByRole("radio", { name: /Yeni özellik geliştirme/ }));

      // The NOUN and the fix, not "bir şeyler eksik". It appears on BOTH
      // code-writing choices and again beside the dead "İleri" — an operator
      // reading either place learns the same thing, so this asserts the count
      // rather than pretending there is one.
      const said = await screen.findAllByText(
        /bir kod deposu bağlantısı gerekir ve bu kurulumda henüz tanımlı değil/,
      );
      expect(said.length).toBe(3);
      // And "İleri" does not walk them four steps toward a run that cannot finish.
      expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("still lets analysis through on that same install", async () => {
      // The prerequisite is per-FLOW, not a wall across the wizard: an install
      // with no repository can still be set up to produce analysis documents,
      // which is the one thing it genuinely can do.
      const { fetchImpl } = stubFetch(
        baseRoutes([{ path: "/onboarding/scm-connections", body: { connections: [] } }]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await screen.findByText("Ne yapmak istiyorsunuz?");
      expect((screen.getByRole("radio", { name: /Yalnızca analiz/ }) as HTMLInputElement).checked).toBe(
        true,
      );
      expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("offers every flow once a repository connection exists", async () => {
      // The default fixtures HAVE an SCM connection, so nothing is blocked —
      // the guard must not fire on a properly configured install.
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await userEvent.click(await screen.findByRole("radio", { name: /Yeni özellik geliştirme/ }));
      expect(screen.queryByText(/bir kod deposu bağlantısı gerekir/)).toBeNull();
      expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("does not call a flow unavailable while the connection list is still in flight", async () => {
      // Same rule the prerequisite banner already follows: an unanswered
      // request is not evidence of an empty list, and telling an operator to
      // go and add a connection they already have is its own bug.
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await screen.findByText("Ne yapmak istiyorsunuz?");
      expect(screen.queryByText(/bir kod deposu bağlantısı gerekir/)).toBeNull();
    });

    it("does not accuse an empty list while the request is still in flight", async () => {
      // A never-resolving connections call: the warning must not appear on the
      // strength of "the array is empty so far".
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await screen.findByText("Ne yapmak istiyorsunuz?");
      expect(screen.queryByText(/Hiç Jira bağlantısı tanımlı değil/)).toBeNull();
      expect(screen.queryByText(/Hiç kod deposu bağlantısı tanımlı değil/)).toBeNull();
    });

    it("tells a non-admin they may look but not save", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl, session: VIEWER });

      expect(await screen.findByText(/Kurulum yapmak için yönetici yetkisi gerekir/)).toBeTruthy();
    });
  });

  it("explains a duplicate rule instead of printing the error code", async () => {
    const { fetchImpl } = stubFetch(
      baseRoutes([
        {
          path: "/studio/listening-rules",
          method: "POST",
          status: 400,
          body: { error: "duplicate_listening_rule" },
        },
      ]),
    );
    renderScreen(<SetupScreen />, { fetchImpl, session: ADMIN });

    await chooseFlow();
    await fillProject();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    // A sentence about what already exists and what to do about it — not the
    // raw code, and not the generic "beklenmeyen bir hata".
    expect(
      await screen.findByText(/Bu ticket'lar için zaten bir dinleme kuralı var/),
    ).toBeTruthy();
    expect(screen.queryByText(/duplicate_listening_rule/)).toBeNull();
    expect(screen.queryByText(/Beklenmeyen/)).toBeNull();
    // The operator is left ON the summary step, able to change the value —
    // not thrown back to the start of the wizard.
    expect(screen.getByText("Özet")).toBeTruthy();
  });

  it("names the violated fields when the binding proposal is refused with a validation 400 (Bulgu A)", async () => {
    // The BFF's strict DraftBody now answers `invalid_onboarding_body` WITH
    // `details.issues` — the field-level violations. The wizard must render
    // them under its translated sentence: the bare code left the operator
    // diffing an eight-field payload against a schema they cannot see.
    const { fetchImpl } = stubFetch(
      baseRoutes([
        {
          path: "/onboarding",
          method: "POST",
          status: 400,
          body: {
            error: "invalid_onboarding_body",
            details: { issues: ["triggerMode: Required", "platform: String must contain at least 1 character(s)"] },
          },
        },
      ]),
    );
    renderScreen(<SetupScreen />, { fetchImpl, session: ADMIN });

    await chooseFlow();
    await fillProject();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    // The catalog sentence AND the named fields, on screen rather than in a
    // four-second toast.
    expect(await screen.findByText("triggerMode: Required")).toBeTruthy();
    expect(
      screen.getByText("platform: String must contain at least 1 character(s)"),
    ).toBeTruthy();
  });

  it("does not file a binding proposal when the rule write failed", async () => {
    const { fetchImpl, calls } = stubFetch(
      baseRoutes([
        {
          path: "/studio/listening-rules",
          method: "POST",
          status: 400,
          body: { error: "duplicate_listening_rule" },
        },
      ]),
    );
    renderScreen(<SetupScreen />, { fetchImpl });

    await chooseFlow();
    await fillProject();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
    await screen.findByText(/Bu ticket'lar için zaten bir dinleme kuralı var/);

    // A pending four-eyes approval for a setup that never completed is worse
    // than no approval at all: somebody would approve a binding whose rule
    // does not exist.
    expect(calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST")).toBeUndefined();
  });

  /**
   * The English name beside the Turkish one.
   *
   * The whole feature is one rule with one failure mode, and it is the failure
   * mode we shipped and fixed today: the SAVED value must stay the localised
   * name Jira serves. `Görev` is what OPS-66 carries; a rule holding `Task` — or
   * `Görev (Task)` — matches nothing, silently, forever. So every test here
   * asserts BOTH halves in the same breath: what the operator read, and what
   * went on the wire.
   */
  describe("the English name beside the Turkish one", () => {
    it("labels the dropdown with both names while keeping the option's value Turkish", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
      await fillProject();
      await screen.findByText("Hangi ticket'ları alsın?");

      const select = (await screen.findByLabelText("Hangi değer?")) as HTMLSelectElement;
      const options = [...select.options].filter((o) => o.value !== "");
      // The label is what a bank employee running Jira in English can find…
      expect(options.map((o) => o.textContent)).toEqual([
        "Hata (Bug)",
        "Görev (Task)",
        // Jira serves this one untranslated, so there is nothing to add. An
        // invented aside here would be the module's one forbidden behaviour.
        "Alt görev (Subtask)",
      ]);
      // …and the value is what the rule will hold, untouched.
      expect(options.map((o) => o.value)).toEqual(OPS_ISSUE_TYPES);
    });

    it("saves the Turkish value even though the operator read the English one", async () => {
      const { fetchImpl, calls } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
      await fillProject();
      // Picked through the label `Görev (Task)` — the exact pair that produced
      // the live bug when a rule was written from the English list.
      await fillTickets("Görev", "Görev (Task)");
      await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
      await screen.findByText("Özet");
      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

      await waitFor(() => {
        // `Görev`, not `Task`, and not `Görev (Task)`. This single assertion is
        // the reason the whole feature is presentation-only.
        expect(ruleBody(calls).matchValue).toBe("Görev");
      });
    });

    it("adds nothing for a name outside the standard set", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([
          { path: "/onboarding/jira-match-values", body: { ok: true, values: ["Talep", "Hata"] } },
        ]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
      await fillProject();
      await screen.findByText("Hangi ticket'ları alsın?");

      // A bank's own custom type. Guessing "Request" for it would be exactly
      // the confident wrong answer this screen must never produce.
      expect(await screen.findByRole("option", { name: "Talep" })).toBeTruthy();
      expect(screen.queryByRole("option", { name: /Talep \(/ })).toBeNull();
      // …while the name we HAVE measured still gets its aside.
      expect(screen.getByRole("option", { name: "Hata (Bug)" })).toBeTruthy();
    });
  });

  /**
   * "Bota atanan her ticket" — the third answer step 3 could not give.
   *
   * The measured gap: `ListeningRule.matchKind` allowed only status|issuetype,
   * so an operator whose real rule is "if a human hands it to the bot, work it"
   * had to invent a condition. Migration 0020 adds the third kind; these tests
   * pin the wizard's half of the round trip.
   */
  describe("every ticket assigned to the bot", () => {
    async function chooseAnyAssigned(): Promise<void> {
      await screen.findByText("Hangi ticket'ları alsın?");
      await userEvent.selectOptions(
        screen.getByLabelText("Ticket'ın nesine baksın?"),
        "assigned",
      );
    }

    it("drops the value question entirely rather than greying it out", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
      await fillProject();
      await screen.findByText("Hangi ticket'ları alsın?");
      // Present for the conditioned kinds …
      expect(screen.getByLabelText("Hangi değer?")).toBeTruthy();

      await chooseAnyAssigned();
      // … and GONE, not disabled, for the catch-all: a greyed box reads as a
      // form the operator failed to finish.
      expect(screen.queryByLabelText("Hangi değer?")).toBeNull();
    });

    it("lets the operator past step 3 with no value to give", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
      await fillProject();
      await chooseAnyAssigned();

      // The blocker that used to demand a match value must not fire here.
      expect(
        screen.queryByText("Devam etmek için Maestro'yu hangi değerin tetikleyeceğini belirtin."),
      ).toBeNull();
      const next = screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement;
      expect(next.disabled).toBe(false);
    });

    it("summarises it as a rule with no condition, then saves it that way", async () => {
      const { fetchImpl, calls } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
      await fillProject();
      await chooseAnyAssigned();
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await userEvent.click(await screen.findByRole("button", { name: "İleri" }));

      // Its OWN sentence — the conditioned one with an empty value spliced in
      // (`değeri "" olan ticket'lar`) would describe nothing.
      await screen.findByText("Özet");
      expect(
        screen.getByText(
          "OPS projesinde bota atanan her ticket Yalnızca analiz akışıyla çalışacak; başka bir koşul aranmayacak.",
        ),
      ).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
      await waitFor(() => {
        const body = ruleBody(calls);
        expect(body.matchKind).toBe("assigned");
        // The placeholder both sides agree on. It is never compared to a
        // ticket; it exists so the unique trigger index keeps ONE catch-all
        // per (project, bot).
        expect(body.matchValue).toBe("*");
        expect(body.assigneeAccountId).toBe("712020:bot");
      });
    });
  });

  /**
   * The data class — the question that was never asked, and the measured cost
   * of not asking it.
   *
   * The wizard used to send no `dataClass` at all, so every binding it filed
   * came out `gizli`, and `packages/llm-gateway/src/policy.ts` then correctly
   * refused to send the content to a cloud model. SAM1-12 stalled with "modeli
   * kullanamadım, elle tamamlayın" and nothing on any screen named the cause;
   * moving SAM1 to `dahili` let SAM1-13 run analysis normally.
   */
  describe("the data class", () => {
    it("defaults to the safe-but-workable class, not the one that stops analysis", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
      await screen.findByText("Hangi Jira projesi, hangi uygulama?");

      // Scoped to the group: several options mention "kurum içi" in their prose
      // (that is the point — they explain each other), so the assertion is
      // about which radio is CHECKED, by its own value.
      const group = screen.getByRole("radiogroup", {
        name: "Bu uygulamanın verisi ne kadar gizli?",
      });
      const checked = within(group)
        .getAllByRole("radio")
        .filter((r) => (r as HTMLInputElement).checked)
        .map((r) => (r as HTMLInputElement).value);
      // Exactly one, and it is the class that is safe AND lets Maestro work.
      // `gizli` was the old implicit answer and is the one that stalled SAM1.
      expect(checked).toEqual(["dahili"]);
    });

    it("describes the consequence rather than the policy name", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
      await screen.findByText("Hangi Jira projesi, hangi uygulama?");

      // The sentence the operator needed and never had.
      expect(
        screen.getByText(
          "Yapay zekâ bulut modeli KULLANILAMAZ. Kurum içi (on-prem) model kurulu değilse Maestro bu projede analiz üretemez.",
        ),
      ).toBeTruthy();
      // And no jargon standing in for it.
      expect(screen.queryByText(/degrade_ai_assist|ai_assist|M18/)).toBeNull();
    });

    it("makes the gizli consequence unmissable, and only once it is chosen", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
      await screen.findByText("Hangi Jira projesi, hangi uygulama?");
      expect(screen.queryByText(/modeli kullanamadım, elle tamamlayın/)).toBeNull();

      await userEvent.click(screen.getByRole("radio", { name: /Gizli/ }));

      // The exact message the operator saw on SAM1-12, now quoted back BEFORE
      // they can cause it rather than after.
      expect(
        await screen.findByText(/modeli kullanamadım, elle tamamlayın/),
      ).toBeTruthy();
    });

    it("carries the operator's choice into the binding payload", async () => {
      const { fetchImpl, calls } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
      await screen.findByText("Hangi Jira projesi, hangi uygulama?");
      await userEvent.click(screen.getByRole("radio", { name: /Açık/ }));
      await fillProject();
      await fillTickets();
      await userEvent.click(await screen.findByRole("button", { name: "İleri" }));

      // Stated on the summary before it is sent — the class decides whether a
      // cloud model may see the tickets, so it is not a hidden field.
      await screen.findByText("Özet");
      expect(
        screen.getByText("Veri sınıfı: Açık — ticket içeriği her modele gönderilebilir."),
      ).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
      await waitFor(() => {
        const call = calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST");
        expect((call!.body as Record<string, unknown>).dataClass).toBe("acik");
      });
    });
  });

  /**
   * The start guide, moved here from the Panel.
   *
   * `screens-dash-start.test.tsx` asserts the other half — that the Panel no
   * longer renders it. This is where it now has to appear, and the dismissal
   * has to keep meaning what it always did.
   */
  describe("the start guide", () => {
    /** Routes for the guide's own reads; nothing is set up, so it shows. */
    function guideRoutes(): Route[] {
      return baseRoutes([
        { path: "/onboarding/scm-connections", body: { connections: [SCM_CONN] } },
        { path: "/variants", body: { variants: [] } },
      ]);
    }

    it("renders the five-step checklist on the wizard while setup is open", async () => {
      const { fetchImpl } = stubFetch(guideRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      expect(
        await screen.findByText("Hoş geldiniz — Maestro'yu 5 adımda çalışır hale getirin"),
      ).toBeTruthy();
      expect(screen.getByText("Ticket girişini aç")).toBeTruthy();
      // The wizard is still a wizard: the guide sits ABOVE the first question,
      // it does not replace it.
      expect(screen.getByText("Ne yapmak istiyorsunuz?")).toBeTruthy();
    });

    it("honours the dismissal the Panel used to own, under the same key", async () => {
      globalThis.localStorage.setItem("maestro.setup.guideDismissed", "1");
      const { fetchImpl } = stubFetch(guideRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await screen.findByText("Ne yapmak istiyorsunuz?");
      expect(
        screen.queryByText("Hoş geldiniz — Maestro'yu 5 adımda çalışır hale getirin"),
      ).toBeNull();
      globalThis.localStorage.removeItem("maestro.setup.guideDismissed");
    });
  });
});

/**
 * The analysis-only setup (repo optional for the `analiz` flow).
 *
 * The audience this exists for is the first pilot's actual shape: a team that
 * wants analysis documents on its Jira tickets and owns no code repository.
 * Until this change the wizard demanded an SCM connection, a repository and a
 * platform for every flow — "Maestro'nun kodu nereye yazacağını bilmeden
 * kurulum yapılamaz", a sentence that is simply false for `analiz`.
 */
describe("setup wizard — analysis without a repository", () => {
  /** An install with NO repository connection at all. */
  const noScm = () =>
    baseRoutes([{ path: "/onboarding/scm-connections", body: { connections: [] } }]);

  /** Step 2 with only the Jira half filled — the analysis-only walk. */
  async function fillProjectJiraOnly(): Promise<void> {
    await screen.findByText("Hangi Jira projesi, hangi uygulama?");
    await userEvent.selectOptions(screen.getByLabelText("Jira bağlantısı"), "jira-1");
    await screen.findByRole("option", { name: "OPS · Operasyon" });
    await userEvent.selectOptions(screen.getByLabelText("Jira projesi"), "OPS");
  }

  it("walks step 2 without a repository, says the offer is optional, and files a repo-less binding", async () => {
    const { fetchImpl, calls } = stubFetch(noScm());
    renderScreen(<SetupScreen />, { fetchImpl });

    // Step 1: analiz is the default and İleri is live despite zero SCM
    // connections — the prerequisite is per-flow.
    await chooseFlow();

    // Step 2: the repo fields are an OFFER, named as such, and the empty
    // selects do not hold the operator hostage.
    await fillProjectJiraOnly();
    expect(
      screen.getByText(/İsteğe bağlı: bir kod deposu bağlarsanız etki analizi dosyalara bakılarak yazılır/),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));

    await fillTickets();
    await screen.findByText("Jira durumlarını da değiştirsin mi?");
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));

    // The summary says WHICH MODE the binding is in — ticket-text — instead of
    // a repo sentence with a hole in it.
    await screen.findByText("Özet");
    expect(
      screen.getByText(/OPS projesine kod deposu bağlanmayacak: analiz belgesi yalnızca ticket metninden üretilecek/),
    ).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    await waitFor(() => {
      // The rule carries the analiz flow…
      const body = ruleBody(calls);
      expect(body.flowType).toBe("analiz");
      // …and the binding proposal carries NO repo half at all — omitted, not "".
      const call = calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST");
      expect(call, "no binding proposal was filed").toBeTruthy();
      expect(call!.body).toEqual({
        jiraProject: "OPS",
        triggerMode: "opt_in",
        gateSet: "risk_tiered",
        mergeMode: "human",
        dataClass: "dahili",
      });
    });
  });

  it("keeps repo mode when the analiz operator DOES pick a repository (regression)", async () => {
    const { fetchImpl, calls } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await chooseFlow(); // analiz
    await fillProject(); // picks repo + platform as before
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await screen.findByText("Özet");
    // Repo mode's own sentence, not the ticket-text one: picking the repo
    // accepted the offer.
    expect(screen.getByText(/Uguryldz\/maestro-pilot deposuna bağlanacak/)).toBeTruthy();
    expect(screen.queryByText(/kod deposu bağlanmayacak/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST");
      expect(call!.body).toMatchObject({
        adoRepo: "Uguryldz/maestro-pilot",
        platform: "linux-node",
      });
    });
  });

  it("does not accept HALF a repository: a started pick must be finished", async () => {
    const { fetchImpl } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await chooseFlow(); // analiz
    await fillProjectJiraOnly();
    // The operator starts the offer — picks the connection — then stops.
    await userEvent.selectOptions(screen.getByLabelText("Kod deposu bağlantısı"), "scm-1");
    await screen.findByRole("option", { name: "Uguryldz/maestro-pilot" });

    expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Devam etmek için kodun yazılacağı depoyu seçin."),
    ).toBeTruthy();
  });

  it("still blocks düzeltme without a repository connection on the same install (regression)", async () => {
    const { fetchImpl } = stubFetch(noScm());
    renderScreen(<SetupScreen />, { fetchImpl });

    await screen.findByText("Ne yapmak istiyorsunuz?");
    await userEvent.click(screen.getByRole("radio", { name: /Hata düzeltme/ }));
    await screen.findAllByText(/bir kod deposu bağlantısı gerekir ve bu kurulumda henüz tanımlı değil/);
    expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
