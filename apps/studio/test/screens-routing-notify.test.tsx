import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NotifyScreen } from "../src/screens/Notify.tsx";
import { RoutingScreen } from "../src/screens/Routing.tsx";
import { renderScreen, stubFetch, VIEWER } from "./harness.tsx";

function routingBody(whenOnpremMissing: string, gizliOutcome: string) {
  return {
    path: "/routing",
    body: {
      projects: [
        {
          projectKey: "UGURPAY",
          trigger: "auto",
          apps: ["ugurpay-core"],
          noteKey: "routing.note.active_auto",
        },
      ],
      rules: [
        { ruleId: "dataclass:acik", conditionKey: "routing.policy.condition.data_class", conditionParams: { dataClass: "acik" }, backend: "api", model: "api", outcome: "ok" },
        { ruleId: "dataclass:dahili", conditionKey: "routing.policy.condition.data_class", conditionParams: { dataClass: "dahili" }, backend: "api", model: "api", outcome: "ok" },
        { ruleId: "dataclass:gizli", conditionKey: "routing.policy.condition.data_class", conditionParams: { dataClass: "gizli" }, backend: "onprem", model: "onprem", outcome: "ok" },
        { ruleId: "dataclass:onprem_missing", conditionKey: "routing.policy.condition.backend_unavailable", conditionParams: { backend: "onprem" }, backend: "onprem", model: "onprem", outcome: gizliOutcome },
      ],
      // The RAW stored policy — the only safe thing to edit against. The rules
      // above are lossy (`degraded` hides `degrade_ai_assist` vs `masked_cloud`).
      policy: {
        backendByClass: { acik: "api", dahili: "api", gizli: "onprem" },
        whenOnpremMissing,
      },
    },
  };
}

// Default fixture: a lenient degraded fallback.
const ROUTING_BODY = routingBody("degrade_ai_assist", "degraded");

const APPS_BODY = {
  path: "/studio/apps",
  body: {
    items: [
      {
        appId: "ugurpay-core",
        displayName: "UgurPay Core",
        adoProject: "Payments",
        adoRepo: "ugurpay-core",
        platform: "linux-node",
        jiraComponent: null,
        maestroYamlPresent: true,
        createdVia: "onboarding",
      },
    ],
    nextCursor: null,
  },
};

describe("routing screen", () => {
  it("shows the Application Registry target of a match (M100)", async () => {
    const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    expect(await screen.findByText("UgurPay Core")).toBeInTheDocument();
    expect(screen.getByText("Payments/_git/ugurpay-core")).toBeInTheDocument();
  });

  it("hides the guarded policy editor from a non-admin", async () => {
    const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
    renderScreen(<RoutingScreen />, { fetchImpl, session: VIEWER });

    await screen.findByText("UgurPay Core");
    expect(screen.queryByRole("button", { name: /Politikayı düzenle/ })).not.toBeInTheDocument();
  });

  it("saves the data-class policy as a four-eyes proposal, not a live change", async () => {
    const { fetchImpl, calls } = stubFetch([
      ROUTING_BODY,
      APPS_BODY,
      {
        path: "/routing",
        method: "PUT",
        body: { status: "pending", pending: { key: "dataclass.policy", scopeRef: null, value: {}, proposedBy: "someone.else", at: "2026-08-10T00:00:00.000Z" } },
      },
    ]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    await screen.findByText("UgurPay Core");
    await userEvent.click(screen.getByRole("button", { name: /Politikayı düzenle/ }));
    // The guarded warning is shown before the operator types.
    expect(await screen.findByText(/korumalıdır/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Onaya gönder/ }));

    const put = calls.find((call) => call.method === "PUT" && call.url.endsWith("/routing"));
    expect(put).toBeDefined();
    const payload = put!.body as { policy: { backendByClass: Record<string, string> } };
    // Backends are prefilled from the raw stored policy.
    expect(payload.policy.backendByClass.gizli).toBe("onprem");
    // A guarded save reports pending, never "applied".
    expect(await screen.findByText(/dört-göz onayına gönderildi/)).toBeInTheDocument();
  });

  /**
   * The security regression the verifier caught: a no-op save must NOT downgrade
   * the stored fallback. With `whenOnpremMissing: "block"` in the database, an
   * admin who opens the editor (to change something else, or nothing) and never
   * touches the fallback dropdown must PUT `block` back — not the lenient
   * `degrade_ai_assist` the screen once hardcoded, which would silently let a
   * `gizli` ticket that should be BLOCKED fall through to AI-assist, past two
   * approvers who only ever saw the fabricated value.
   */
  it("round-trips the stored fallback verbatim on an untouched save (no silent downgrade)", async () => {
    const { fetchImpl, calls } = stubFetch([
      routingBody("block", "blocked"),
      APPS_BODY,
      {
        path: "/routing",
        method: "PUT",
        body: { status: "applied", change: {} },
      },
    ]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    await screen.findByText("UgurPay Core");
    await userEvent.click(screen.getByRole("button", { name: /Politikayı düzenle/ }));
    await screen.findByText(/korumalıdır/);
    // Deliberately touch NOTHING, then save.
    await userEvent.click(screen.getByRole("button", { name: /Onaya gönder/ }));

    const put = calls.find((call) => call.method === "PUT" && call.url.endsWith("/routing"));
    expect(put).toBeDefined();
    const payload = put!.body as { policy: { whenOnpremMissing: string } };
    expect(payload.policy.whenOnpremMissing).toBe("block");
    expect(payload.policy.whenOnpremMissing).not.toBe("degrade_ai_assist");
  });

  // The onboarding approval queue (M93): a submitted package is now visible here
  // and an admin can approve it, which is the step that turns a proposal into a
  // live binding. Before this the queue had no reader at all.
  const PENDING_BODY = {
    path: "/onboarding/pending",
    body: {
      items: [
        {
          projectKey: "OPS",
          appId: "Uguryldz/maestro-pilot",
          adoRepo: "Uguryldz/maestro-pilot",
          platform: "linux-node",
          triggerMode: "opt_in",
          gateSet: "risk_tiered",
          mergeMode: "human",
          proposedBy: "ayse.kaya@ugurbank.local",
          at: "2026-08-13T10:00:00.000Z",
        },
      ],
    },
  };

  it("shows a submitted onboarding package and approves it into a binding", async () => {
    const { fetchImpl, calls } = stubFetch([
      ROUTING_BODY,
      APPS_BODY,
      PENDING_BODY,
      { path: "/onboarding/approve", method: "POST", body: { status: "bound", projectKey: "OPS", nextStep: "listening_rule" } },
    ]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    // The package is listed with its repo and proposer.
    expect(await screen.findByText("Uguryldz/maestro-pilot")).toBeInTheDocument();
    expect(screen.getByText("ayse.kaya@ugurbank.local")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Onayla" }));

    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/onboarding/approve"));
    expect(post).toBeDefined();
    expect((post!.body as { projectKey: string }).projectKey).toBe("OPS");
    // After approval the operator is offered the chain's next step.
    expect(await screen.findByRole("button", { name: "Dinleme kuralı ekle" })).toBeInTheDocument();
  });

  it("warns — with the reason — when the approval bound the project but the default rules could not be seeded", async () => {
    // The fail-soft seed: `listeningSeed: null` used to render as the same
    // cheerful "bağlandı" while zero tickets were listened to. The response now
    // names why (`seedSkipped.reason`) and the screen must say it out loud.
    const { fetchImpl } = stubFetch([
      ROUTING_BODY,
      APPS_BODY,
      PENDING_BODY,
      {
        path: "/onboarding/approve",
        method: "POST",
        body: {
          status: "bound",
          projectKey: "OPS",
          nextStep: "listening_rule",
          listeningSeed: null,
          seedSkipped: { reason: "issue_types_unavailable" },
        },
      },
    ]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    await screen.findByText("Uguryldz/maestro-pilot");
    await userEvent.click(screen.getByRole("button", { name: "Onayla" }));

    // The warning names the project, the reason and the way out.
    expect(
      await screen.findByText(/varsayılan dinleme kuralları kurulamadı/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Jira iş türü listesi okunamadı/)).toBeInTheDocument();
    // Never the celebratory "otomatik kuruldu" line for a seed that did not run.
    expect(screen.queryByText(/otomatik kuruldu/)).not.toBeInTheDocument();
  });

  it("names an analysis-only package's missing repo instead of showing an empty cell", async () => {
    // The BFF sends explicit nulls for a repo-less (analysis-only) proposal.
    // The approver is confirming precisely that no repository is in scope, so
    // the cell must SAY it — a blank would read as data loss on the one screen
    // where the second human decides.
    const noRepoPending = {
      path: "/onboarding/pending",
      body: {
        items: [
          {
            ...PENDING_BODY.body.items[0],
            appId: null,
            adoRepo: null,
            platform: null,
          },
        ],
      },
    };
    const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY, noRepoPending]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    expect(
      await screen.findByText("depo yok — yalnızca analiz (belge ticket metninden üretilir)"),
    ).toBeInTheDocument();
  });

  it("hides the approval queue from a non-admin", async () => {
    const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY, PENDING_BODY]);
    renderScreen(<RoutingScreen />, { fetchImpl, session: VIEWER });

    await screen.findByText("UgurPay Core");
    // A viewer never sees an approve button.
    expect(screen.queryByRole("button", { name: "Onayla" })).not.toBeInTheDocument();
  });

  /**
   * "Düzenle" on a bound project — the affordance the list never had.
   *
   * The bound-projects table was read-only: once a project was bound there was
   * no way to change anything about it from the UI, and no way to find out why.
   * What it can honestly become is bounded by the API, which was measured:
   * `POST /onboarding` is a CREATE path that refuses an already-bound project
   * (`project_already_bound`), and there is no update endpoint at all. So the
   * one thing this must NOT do is offer a save button that files nothing — on a
   * four-eyes decision about which repository an agent may push to, a silent
   * no-op is the worst possible outcome. These tests pin both halves: the
   * editable path is wired, and the gap is named rather than faked.
   */
  describe("editing a bound project", () => {
    it("offers Düzenle on each bound project, to an admin only", async () => {
      const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
      renderScreen(<RoutingScreen />, { fetchImpl });
      await screen.findByText("UgurPay Core");
      expect(screen.getByRole("button", { name: "Düzenle" })).toBeInTheDocument();
    });

    it("does not offer it to a non-admin", async () => {
      const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
      renderScreen(<RoutingScreen />, { fetchImpl, session: VIEWER });
      await screen.findByText("UgurPay Core");
      expect(screen.queryByRole("button", { name: "Düzenle" })).not.toBeInTheDocument();
    });

    it("routes to the one thing that IS editable, and names what is not", async () => {
      const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
      renderScreen(<RoutingScreen />, { fetchImpl });
      await screen.findByText("UgurPay Core");

      await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));

      // The project it is about is named, not implied.
      expect(await screen.findByText("UGURPAY bağlamasını düzenle")).toBeInTheDocument();
      // The editable half: listening rules, reachable in one click.
      expect(screen.getByRole("button", { name: "Dinleme kurallarını aç" })).toBeInTheDocument();
      // The locked half, named FIELD BY FIELD — "bazı ayarlar değiştirilemez"
      // is the sentence that generates a support ticket instead of resolving
      // one — and with the reason, so nobody hunts for a hidden button.
      expect(
        screen.getByText(/tetikleme kipi, uygulama\/depo eşlemesi ve veri sınıfı/),
      ).toBeInTheDocument();
      expect(screen.getByText(/sunucuda bunu yapan bir uç nokta da yok/)).toBeInTheDocument();
      // And crucially: NO save button, because there is nothing to save to.
      expect(screen.queryByRole("button", { name: /Kaydet/ })).not.toBeInTheDocument();
    });

    it("writes nothing at all — opening the panel is not a change", async () => {
      const { fetchImpl, calls } = stubFetch([ROUTING_BODY, APPS_BODY]);
      renderScreen(<RoutingScreen />, { fetchImpl });
      await screen.findByText("UgurPay Core");

      await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));
      await screen.findByText("UGURPAY bağlamasını düzenle");

      // A binding is four-eyes governed; an "edit" screen that quietly filed a
      // proposal on open would put a decision in front of an approver that
      // nobody made.
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    });
  });
});

const NOTIFY_BODY = {
  path: "/notify",
  body: {
    ladder: [{ afterHours: 24, channels: ["jira"], kind: "notify" }],
    delegations: [],
    waiting: [],
    routing: { default: ["teams"], byEvent: {} },
    ladderRaw: {
      steps: [{ id: "reminder-24h", afterHours: 24, channel: "jira", event: "gate_reminder", action: "notify" }],
      businessHoursOnly: false,
      calendar: {},
    },
    teamsWebhookMask: "",
  },
};

describe("notify screen editing", () => {
  it("edits a threshold and PUTs the same step id so open gates do not re-escalate", async () => {
    const { fetchImpl, calls } = stubFetch([
      NOTIFY_BODY,
      { path: "/notify", method: "PUT", body: { results: [{ status: "applied", change: {} }] } },
    ]);
    renderScreen(<NotifyScreen />, { fetchImpl });

    await userEvent.click(await screen.findByRole("button", { name: /Merdiveni düzenle/ }));
    const dialog = await screen.findByRole("dialog");
    const hours = within(dialog).getByRole("spinbutton");
    await userEvent.clear(hours);
    await userEvent.type(hours, "48");
    await userEvent.click(within(dialog).getByRole("button", { name: "Kaydet" }));

    const put = calls.find((call) => call.method === "PUT" && call.url.endsWith("/notify"));
    expect(put).toBeDefined();
    const payload = put!.body as { ladder: { steps: { id: string; afterHours: number }[] } };
    expect(payload.ladder.steps[0]?.id).toBe("reminder-24h");
    expect(payload.ladder.steps[0]?.afterHours).toBe(48);
  });

  it("wears the honest 'delivery not live yet' strip at the top", async () => {
    const { fetchImpl } = stubFetch([NOTIFY_BODY]);
    renderScreen(<NotifyScreen />, { fetchImpl });
    // Renders unconditionally: the settings persist but nothing delivers yet,
    // so an operator must not rely on a reminder arriving.
    expect(
      await screen.findByText(/bildirim gönderimi henüz devrede değil/),
    ).toBeInTheDocument();
  });

  it("keeps the edit button from a non-admin", async () => {
    const { fetchImpl } = stubFetch([NOTIFY_BODY]);
    renderScreen(<NotifyScreen />, { fetchImpl, session: VIEWER });

    await screen.findByText(/otomatik reddedilmez/);
    expect(screen.queryByRole("button", { name: /Merdiveni düzenle/ })).not.toBeInTheDocument();
    // A non-admin also gets no routing-edit button.
    expect(screen.queryByRole("button", { name: /Eşlemeyi düzenle/ })).not.toBeInTheDocument();
  });

  it("saves a Teams webhook URL through PUT /notify (never prefilled)", async () => {
    const { fetchImpl, calls } = stubFetch([
      NOTIFY_BODY,
      { path: "/notify", method: "PUT", body: { results: [{ status: "applied", change: {} }] } },
    ]);
    renderScreen(<NotifyScreen />, { fetchImpl });

    const field = await screen.findByLabelText("Teams webhook URL");
    await userEvent.type(field, "https://outlook.office.com/webhook/abc123");
    await userEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    const put = calls.find((call) => call.method === "PUT" && call.url.endsWith("/notify"));
    expect(put).toBeDefined();
    expect((put!.body as { teamsWebhook?: string }).teamsWebhook).toBe(
      "https://outlook.office.com/webhook/abc123",
    );
  });

  it("shows the event→channel routing: each event with its channels, defaults marked", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/notify",
        body: {
          ...NOTIFY_BODY.body,
          // gate_open explicitly on jira; kill_switch muted; everything else default (teams).
          routing: { default: ["teams"], byEvent: { gate_open: ["jira"], kill_switch: [] } },
        },
      },
    ]);
    renderScreen(<NotifyScreen />, { fetchImpl });

    // The routing card lists every event by its localized name.
    expect(await screen.findByText("Onay kapısı açıldı")).toBeInTheDocument();
    expect(screen.getByText("Kill-switch")).toBeInTheDocument();
    // A muted event is shown as such, not blank.
    expect(screen.getByText("susturulmuş")).toBeInTheDocument();
    // An event with no explicit rule is marked as following the default.
    expect(screen.getAllByText(/varsayılan/).length).toBeGreaterThan(0);
  });
});
