import { describe, expect, it } from "vitest";
import { UGURPAY_BINDING, harness, type Harness } from "./helpers.js";
import { issueEvent, signed } from "./payloads.js";
import type { ListeningRuleRecord } from "../src/listening-store.js";

/**
 * Per-ticket flow selection, end to end through the REAL intake path: a signed
 * Jira delivery → webhook route → `runIntake` → the flow that reaches the
 * workflow engine's start input.
 *
 * The behaviour this pins down is the one `flowOf(env)` could not express. The
 * flow used to come from the process environment, so a deployment was either
 * all-analysis or all-engineering; a bank running one Jira project for both
 * "analyse this" and "fix this bug" had no way to say so.
 */

function rule(over: Partial<ListeningRuleRecord> = {}): ListeningRuleRecord {
  return {
    ruleId: "lr_1",
    projectKey: "UGURPAY",
    assigneeAccountId: "",
    matchKind: "issuetype",
    matchValue: "Hata",
    flowType: "duzeltme",
    priority: 100,
    enabled: true,
    ...over,
  };
}

/** Deliver a signed issue event and return the run input the engine received. */
async function deliver(
  h: Harness,
  options: { ticket: string; issueType?: string; status?: string; assignee?: string },
): Promise<{ flow?: unknown; ticket: string } | undefined> {
  const before = h.runs.started.length;
  const delivery = signed(issueEvent(options));
  const response = await h.app.inject({
    method: "POST",
    url: "/webhooks/jira",
    headers: delivery.headers,
    payload: delivery.payload,
  });
  expect(response.statusCode).toBe(202);
  return h.runs.started[before] as { flow?: unknown; ticket: string } | undefined;
}

describe("intake picks the flow PER TICKET, not per deployment", () => {
  const rules = [
    rule({ ruleId: "lr_bug", matchKind: "issuetype", matchValue: "Hata", flowType: "duzeltme", priority: 10 }),
    rule({ ruleId: "lr_analiz", matchKind: "issuetype", matchValue: "Analiz", flowType: "analiz", priority: 20 }),
  ];

  /**
   * Reported from the field, in these words: "dinleyip cevap dönmedi, işleme
   * alındı diye bir yorum yok."
   *
   * The operator assigned a ticket to the bot, the sweep took it and a run
   * started — and Jira showed nothing. From where they were sitting, assigning
   * the ticket had done nothing at all: the only evidence was in a panel they
   * had no reason to open yet.
   */
  it("says on the ticket that the work was picked up", async () => {
    const h = await harness({ listeningRules: rules });

    await deliver(h, { ticket: "UGURPAY-1", issueType: "Hata" });

    const comment = h.work.lastComment("UGURPAY-1") ?? "";
    expect(comment).toContain("UGURPAY-1");
    // Names what happens next, not just that something happened.
    expect(comment).toMatch(/analiz|onay/i);
  });

  /**
   * A delivery that JOINED a run already going has nothing new to announce,
   * and a second "picked this up" on the same ticket reads as the platform
   * having lost track of itself.
   */
  it("does not announce again when a second delivery joins the same run", async () => {
    const h = await harness({ listeningRules: rules });

    await deliver(h, { ticket: "UGURPAY-1", issueType: "Hata" });
    const onTicket = (): number =>
      h.work.comments.filter((c: { ticket: string }) => c.ticket === "UGURPAY-1").length;
    const first = onTicket();
    await deliver(h, { ticket: "UGURPAY-1", issueType: "Hata" });

    expect(onTicket()).toBe(first);
  });

  it("runs two tickets of the SAME project on two DIFFERENT flows", async () => {
    const h = await harness({ listeningRules: rules });

    const bug = await deliver(h, { ticket: "UGURPAY-1", issueType: "Hata" });
    const analysis = await deliver(h, { ticket: "UGURPAY-2", issueType: "Analiz" });

    expect(bug?.flow).toBe("duzeltme");
    expect(analysis?.flow).toBe("analiz");
    // The headline assertion: one project, one deployment, two flows.
    expect(bug?.flow).not.toBe(analysis?.flow);
    expect(h.runs.started).toHaveLength(2);
  });

  it("selects the flow from the ticket STATUS when the rule keys on status", async () => {
    const h = await harness({
      listeningRules: [rule({ ruleId: "lr_todo", matchKind: "status", matchValue: "Yapılacak", flowType: "analiz" })],
    });

    const started = await deliver(h, { ticket: "UGURPAY-3", status: "Yapılacak" });
    expect(started?.flow).toBe("analiz");
  });

  it("only runs a bot-assigned rule for tickets actually assigned to the bot", async () => {
    const h = await harness({
      listeningRules: [rule({ assigneeAccountId: "712020:bot", matchValue: "Hata", flowType: "duzeltme" })],
      deps: { config: { actorDomain: "ugurbank.local", defaultFlow: "analiz" } },
    });

    const mine = await deliver(h, { ticket: "UGURPAY-4", issueType: "Hata", assignee: "712020:bot" });
    const theirs = await deliver(h, { ticket: "UGURPAY-5", issueType: "Hata", assignee: "ayse.kaya" });

    expect(mine?.flow).toBe("duzeltme");
    // Assigned to a human: the rule does not claim it, so the default applies.
    expect(theirs?.flow).toBe("analiz");
  });
});

describe("intake falls back when no rule claims the ticket", () => {
  it("keeps the deployment default (an existing install is not broken)", async () => {
    const h = await harness({
      listeningRules: [rule({ matchValue: "Hata", flowType: "duzeltme" })],
      deps: { config: { actorDomain: "ugurbank.local", defaultFlow: "analiz" } },
    });

    const started = await deliver(h, { ticket: "UGURPAY-6", issueType: "Görev" });
    expect(started?.flow).toBe("analiz");
  });

  it("keeps the deployment default when NO rules exist at all", async () => {
    const h = await harness({
      deps: { config: { actorDomain: "ugurbank.local", defaultFlow: "analiz" } },
    });

    const started = await deliver(h, { ticket: "UGURPAY-7", issueType: "Hata" });
    expect(started?.flow).toBe("analiz");
  });

  it("leaves the flow unset when nothing matches and no default is configured", async () => {
    const h = await harness({ listeningRules: [rule({ matchValue: "Hata" })] });

    const started = await deliver(h, { ticket: "UGURPAY-8", issueType: "Görev" });
    expect(started).toBeDefined();
    expect(started?.flow).toBeUndefined();
  });

  it("keeps the deployment default when NO listening store is wired at all", async () => {
    // The store is an optional capability. A deployment that never wired one —
    // every install that predates the rules table — must go on running its
    // configured flow rather than silently reverting to the full pipeline.
    const h = await harness({
      deps: { listening: undefined, config: { actorDomain: "ugurbank.local", defaultFlow: "analiz" } },
    });

    const started = await deliver(h, { ticket: "UGURPAY-13", issueType: "Hata" });
    expect(started?.flow).toBe("analiz");
  });

  it("still starts the run when the listening store FAILS", async () => {
    // A database blip must not strand a ticket: the deployment default is an
    // operator's deliberate choice, so falling back to it beats refusing.
    const h = await harness({
      deps: {
        config: { actorDomain: "ugurbank.local", defaultFlow: "analiz" },
        listening: {
          list: () => Promise.reject(new Error("db down")),
          get: () => Promise.resolve(null),
          put: () => Promise.resolve(),
          remove: () => Promise.resolve(false),
        },
      },
    });

    const started = await deliver(h, { ticket: "UGURPAY-9", issueType: "Hata" });
    expect(started?.flow).toBe("analiz");
  });
});

describe("the flow decision is visible to an operator", () => {
  async function runStartedMeta(h: Harness, ticket: string): Promise<Record<string, unknown>> {
    // Read the real audit CHAIN, not a spy: the decision has to survive where an
    // operator will actually look for it months later.
    const entries = await h.auditStore.read();
    const entry = entries.find((e) => e.action === "RUN_STARTED" && e.subject === ticket);
    expect(entry, `no RUN_STARTED audit entry for ${ticket}`).toBeDefined();
    return (entry!.meta ?? {}) as Record<string, unknown>;
  }

  it("records WHICH flow and WHY, naming the rule that decided", async () => {
    const h = await harness({
      listeningRules: [rule({ ruleId: "lr_bug", matchValue: "Hata", flowType: "duzeltme" })],
    });
    await deliver(h, { ticket: "UGURPAY-10", issueType: "Hata" });

    const meta = await runStartedMeta(h, "UGURPAY-10");
    expect(meta["flow"]).toBe("duzeltme");
    expect(meta["flowReason"]).toBe("rule");
    expect(meta["flowRuleId"]).toBe("lr_bug");
  });

  it("records that the DEFAULT applied when no rule matched", async () => {
    const h = await harness({
      listeningRules: [rule({ matchValue: "Hata" })],
      deps: { config: { actorDomain: "ugurbank.local", defaultFlow: "analiz" } },
    });
    await deliver(h, { ticket: "UGURPAY-11", issueType: "Görev" });

    const meta = await runStartedMeta(h, "UGURPAY-11");
    expect(meta["flow"]).toBe("analiz");
    expect(meta["flowReason"]).toBe("default");
    expect(meta["flowRuleId"]).toBeUndefined();
  });

  it("records a rule CONFLICT and names every rule involved", async () => {
    const h = await harness({
      listeningRules: [
        rule({ ruleId: "lr_type", matchKind: "issuetype", matchValue: "Hata", flowType: "gelistirme", priority: 1 }),
        rule({ ruleId: "lr_status", matchKind: "status", matchValue: "Yapılacak", flowType: "analiz", priority: 90 }),
      ],
    });
    const started = await deliver(h, { ticket: "UGURPAY-12", issueType: "Hata", status: "Yapılacak" });

    // Fail-closed: the narrowest flow wins even though the wider rule had the
    // better priority.
    expect(started?.flow).toBe("analiz");

    const meta = await runStartedMeta(h, "UGURPAY-12");
    expect(meta["flowReason"]).toBe("rule_conflict");
    expect(String(meta["flowConflictingRuleIds"]).split(",").sort()).toEqual(["lr_status", "lr_type"]);
  });
});

/**
 * The rule's Jira status map, riding the SAME path as the flow: read once from
 * the rule row on the way in, and pinned into the run's start input.
 *
 * That path is the whole design. `packages/workflows` may not read a database
 * (M44), and a run that re-read the rules later could finish under a rule it
 * did not start under — an admin editing a rule at lunchtime would change where
 * the morning's tickets land, with the run's own history unable to say why.
 */
describe("intake pins the rule's status map into the run input", () => {
  const MAP = { onStart: "Devam Ediyor", onReview: "İNCELEMEDE", onDone: "Tamam" } as const;

  it("carries the deciding rule's map to the engine", async () => {
    const h = await harness({ listeningRules: [rule({ matchValue: "Hata", statusMap: MAP })] });

    const started = (await deliver(h, { ticket: "UGURPAY-1", issueType: "Hata" })) as
      | { statusMap?: unknown }
      | undefined;

    expect(started?.statusMap).toEqual(MAP);
  });

  /**
   * Comment-only mode is the ABSENCE of the field, not a null in it. Absent
   * already means "do not move the ticket" to the workflow, and an explicit
   * null would say the same thing while looking like a choice somebody made.
   */
  it("omits the field entirely for a rule that maps nothing", async () => {
    const h = await harness({ listeningRules: [rule({ matchValue: "Hata" })] });

    const started = (await deliver(h, { ticket: "UGURPAY-1", issueType: "Hata" })) as
      | Record<string, unknown>
      | undefined;

    expect(started).toBeDefined();
    expect(Object.hasOwn(started ?? {}, "statusMap")).toBe(false);
  });

  /** A ticket no rule matched has no operator-configured board to be driven around. */
  it("omits the field when the deployment default decided the flow", async () => {
    const h = await harness({ listeningRules: [rule({ matchValue: "Hata", statusMap: MAP })] });

    const started = (await deliver(h, { ticket: "UGURPAY-9", issueType: "Görev" })) as
      | Record<string, unknown>
      | undefined;

    expect(started).toBeDefined();
    expect(Object.hasOwn(started ?? {}, "statusMap")).toBe(false);
  });
});

describe("the analysis-only binding — no application, and only analiz may run", () => {
  const rules = [
    rule({ ruleId: "lr_analiz", matchKind: "issuetype", matchValue: "Analiz", flowType: "analiz" }),
    rule({ ruleId: "lr_gel", matchKind: "issuetype", matchValue: "Görev", flowType: "gelistirme" }),
  ];

  /** The binding an analysis-only team files: active, but naming no repo. */
  const NO_APP = { ...UGURPAY_BINDING, appId: null };

  it("accepts and starts an analiz ticket with NO appId anywhere in the input", async () => {
    const h = await harness({ bindings: [NO_APP], listeningRules: rules });
    const delivery = signed(issueEvent({ ticket: "UGURPAY-20", issueType: "Analiz" }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toMatchObject({ accepted: true });
    expect(h.runs.started).toHaveLength(1);
    const input = h.runs.started[0] as unknown as Record<string, unknown>;
    expect(input["flow"]).toBe("analiz");
    // OMITTED, not null: absence is what the workflow reads as "ticket-text
    // mode", and a null key would be a third spelling nobody parses.
    expect(Object.keys(input)).not.toContain("appId");
  });

  it("still refuses a code-writing flow on the same binding (M99 tier ③ unchanged)", async () => {
    const h = await harness({ bindings: [NO_APP], listeningRules: rules });
    const delivery = signed(issueEvent({ ticket: "UGURPAY-21", issueType: "Görev" }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toEqual({ accepted: false, reason: "no_application" });
    expect(h.runs.started).toHaveLength(0);
    // The ticket still hears it is waiting for a human, exactly as before.
    expect(h.work.lastComment("UGURPAY-21")).toContain("UGURPAY-21");
  });

  it("refuses when NO rule matches either — the default is not analiz just because the binding is bare", async () => {
    // No rule claims the ticket and no deployment default is configured, so
    // the flow is "the full pipeline" — which writes code, which needs an app.
    const h = await harness({ bindings: [NO_APP], listeningRules: [] });
    const delivery = signed(issueEvent({ ticket: "UGURPAY-22", issueType: "Hata" }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toEqual({ accepted: false, reason: "no_application" });
  });

  it("records the missing application honestly in the RUN_STARTED audit entry", async () => {
    const h = await harness({ bindings: [NO_APP], listeningRules: rules });
    const delivery = signed(issueEvent({ ticket: "UGURPAY-23", issueType: "Analiz" }));
    await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    const entries = await h.auditStore.read();
    const entry = entries.find((e) => e.action === "RUN_STARTED" && e.subject === "UGURPAY-23");
    expect(entry).toBeDefined();
    // In words, not a null a SIEM query would drop: "which app?" must be
    // answerable with "none — ticket-text analysis" months later.
    expect(entry?.meta?.["appId"]).toBe("yok (analiz, ticket metninden)");
  });
});
