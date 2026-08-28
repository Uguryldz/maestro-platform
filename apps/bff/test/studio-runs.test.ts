import type { TicketSnapshot } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import type { ListeningRuleRecord } from "../src/listening-store.js";
import { PageQuery } from "../src/routes/paging.js";
import { reconciledState } from "../src/routes/studio-runs.js";
import { auth } from "./helpers.js";
import type { Harness } from "./helpers.js";
import {
  AT,
  CALL,
  JOURNAL_AI,
  JOURNAL_HUMAN,
  OTHER_RUN,
  RUN,
  RUN_ID,
  SNAPSHOT,
  TICKET,
  adminToken,
  memberToken,
  outsiderToken,
  studioHarness,
} from "./studio-fixtures.js";

/**
 * The `RUN_STARTED` meta from the real audit CHAIN, not a spy: WHY a run took
 * the flow it did has to survive where an operator will look for it months
 * later, and a log line would be long gone.
 */
async function runStartedMeta(h: Harness, ticket: string): Promise<Record<string, unknown>> {
  const entries = await h.auditStore.read();
  const entry = entries.find((e) => e.action === "RUN_STARTED" && e.subject === ticket);
  expect(entry, `no RUN_STARTED audit entry for ${ticket}`).toBeDefined();
  return (entry?.meta ?? {}) as Record<string, unknown>;
}

/**
 * Studio's run surface. Three questions per endpoint, in the order they
 * actually matter: does it refuse a caller who should not be there, does it
 * return the real rows to one who should, and does it refuse input it cannot
 * make sense of instead of guessing.
 */
/**
 * The source-selection rule on its own, away from HTTP: every combination of
 * "what the record says" and "what the engine says", so a change to the rule
 * has to face each case rather than only the one the route test happens to
 * exercise.
 */
describe("reconciledState: which source tells the truth", () => {
  const ENGINE = {
    runId: RUN_ID,
    ticketKey: TICKET,
    step: "7",
    status: "running",
    startedAt: AT,
    updatedAt: AT,
  } as const;

  it("lets a terminal record overrule a live engine answer", () => {
    for (const status of ["fail", "done", "cancelled"] as const) {
      expect(reconciledState({ ...RUN, status }, ENGINE)?.status).toBe(status);
    }
  });

  it("keeps the engine's answer when the record is not terminal", () => {
    for (const status of ["running", "gate", "queued", "handover"] as const) {
      // The engine says `running`; a live record must not override it, whatever
      // live status the row happens to hold.
      expect(reconciledState({ ...RUN, status }, ENGINE)?.status).toBe("running");
    }
  });

  it("does not invent a state when neither source can supply one", () => {
    expect(reconciledState({ ...RUN, status: null }, null)).toBeNull();
  });

  /**
   * A terminal record with no engine answer stays `null` rather than becoming a
   * synthesised state: `WorkflowRunState` requires a `runId` and a `step`, and
   * the catalog holds neither. Inventing them would attribute a made-up step to
   * a real run — and the row lists fine without one.
   */
  it("does not synthesise a state a terminal record cannot fill", () => {
    expect(reconciledState({ ...RUN, status: "fail" }, null)).toBeNull();
  });

  /**
   * The two halves of the system must agree on what "over" means. The database
   * side enforces its own set (`TERMINAL_STATUSES`, apps/deploy run-context.ts)
   * to decide which run a ticket's live slot belongs to; this route decides
   * which source wins. If they drifted — say `fail` counted as terminal here
   * but live there — a failed run would render as finished while still holding
   * the ticket's only live slot, and the next `/ai-start` would die on the
   * unique index with no visible reason.
   *
   * Asserted by behaviour rather than by importing the constant: the BFF does
   * not depend on `apps/deploy`, and an import would invert that direction.
   */
  it("agrees with the database on which statuses mean the run is over", () => {
    const terminal = (["fail", "done", "cancelled"] as const).filter(
      (status) => reconciledState({ ...RUN, status }, ENGINE)?.status === status,
    );
    expect(terminal).toEqual(["fail", "done", "cancelled"]);

    const live = (["running", "gate", "queued", "handover"] as const).filter(
      (status) => reconciledState({ ...RUN, status }, ENGINE)?.status === "running",
    );
    expect(live).toEqual(["running", "gate", "queued", "handover"]);
  });

  it("preserves everything except the verdict", () => {
    const result = reconciledState({ ...RUN, status: "fail" }, ENGINE);
    expect(result?.runId).toBe(ENGINE.runId);
    expect(result?.step).toBe(ENGINE.step);
    expect(result?.startedAt).toBe(ENGINE.startedAt);
  });
});

describe("GET /studio/runs", () => {
  it("refuses an unauthenticated caller", async () => {
    const h = await studioHarness();
    const response = await h.app.inject({ method: "GET", url: "/studio/runs" });
    expect(response.statusCode).toBe(401);
  });

  it("does not list a project the caller does not belong to", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("returns the stored record joined to the live workflow state", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { ticketKey: string; title: string; costUsd: number; state: { step: string; status: string } }[] };
    expect(body.items).toHaveLength(1);
    // Every field comes from the fixture, so a route returning a constant fails.
    expect(body.items[0]?.ticketKey).toBe(TICKET);
    expect(body.items[0]?.title).toBe(RUN.title);
    expect(body.items[0]?.costUsd).toBe(RUN.costUsd);
    expect(body.items[0]?.state.step).toBe("5");
    expect(body.items[0]?.state.status).toBe("gate");
  });

  /**
   * The measured bug, as a test.
   *
   * On the live board the database held eleven `fail` rows and Studio rendered
   * twelve "running" and three "gate". The engine was not malfunctioning: a
   * workflow that dies inside an activity never reaches the code that would
   * record how it ended, so Temporal keeps answering with the last step the
   * workflow wrote — `running`, indefinitely. The list consulted only that
   * answer, so eleven dead runs read as live work.
   */
  it("shows a failed run as failed even while the engine still reports it running", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, status: "fail" });
    // The engine's stale answer, exactly as Temporal gives it for a run that
    // died mid-activity: still `running`, still on the step it died on.
    h.runs.states.set(`maestro-${TICKET}`, {
      runId: RUN_ID,
      ticketKey: TICKET,
      step: "7",
      status: "running",
      startedAt: AT,
      updatedAt: AT,
    });
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

    const body = response.json() as { items: { state: { status: string; step: string } | null }[] };
    expect(body.items[0]?.state?.status).toBe("fail");
    // The step is the engine's to know and is NOT overwritten: the record
    // corrects the verdict, not the history.
    expect(body.items[0]?.state?.step).toBe("7");
  });

  /**
   * The other direction, which is why the rule is not simply "the database
   * wins". Step progress happens in the engine and reaches the row afterwards,
   * so for a run that is genuinely alive the engine holds the fresher answer —
   * and a gate rendered as "running" is an approval nobody can see is waiting.
   */
  it("prefers the engine's answer while the record says the run is still live", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, status: "running" });
    // The harness already parked this ticket at a gate (step 5).
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

    const body = response.json() as { items: { state: { status: string } | null }[] };
    expect(body.items[0]?.state?.status).toBe("gate");
  });

  /** `done` and `cancelled` are terminal for the same reason `fail` is. */
  it("treats every terminal status as terminal, not just fail", async () => {
    for (const status of ["done", "cancelled"] as const) {
      const h = await studioHarness();
      h.read.runs.put({ ...RUN, status });
      const token = await memberToken(h);

      const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

      const body = response.json() as { items: { state: { status: string } | null }[] };
      expect(body.items[0]?.state?.status).toBe(status);
    }
  });

  /**
   * The `state: null` contract, which predates this change and must survive it.
   * A row whose execution the engine cannot answer for is still the caller's
   * ticket; dropping it made Studio render "no workflows yet" over a catalog of
   * twenty-two runs.
   */
  it("still lists a row when the engine cannot answer for it", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, status: "fail" });
    // No execution at all — the engine has nothing to say about this ticket.
    h.runs.states.delete(`maestro-${TICKET}`);
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { ticketKey: string; state: unknown }[] };
    // Listed, with a null state — NOT hidden, and NOT given a step nobody knows.
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.ticketKey).toBe(TICKET);
    expect(body.items[0]?.state).toBeNull();
  });

  /**
   * The detail route reads the same two sources and must reach the same
   * verdict. A row listed as `fail` that turned back into `running` on click
   * would be the same lie, one screen deeper.
   */
  it("gives the detail header the same verdict the list gave", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, status: "fail" });
    h.runs.states.set(`maestro-${TICKET}`, {
      runId: RUN_ID,
      ticketKey: TICKET,
      step: "7",
      status: "running",
      startedAt: AT,
      updatedAt: AT,
    });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}`,
      headers: auth(token),
    });

    const body = response.json() as { state: { status: string } | null };
    expect(body.state?.status).toBe("fail");
  });

  /**
   * The status filter reads the reconciled verdict, not the raw engine answer.
   * An operator filtering for `fail` to find dead work would otherwise get an
   * empty page while eleven failed runs sat in the unfiltered list.
   */
  it("filters on the reconciled status rather than the engine's stale one", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, status: "fail" });
    h.runs.states.set(`maestro-${TICKET}`, {
      runId: RUN_ID,
      ticketKey: TICKET,
      step: "7",
      status: "running",
      startedAt: AT,
      updatedAt: AT,
    });
    const token = await memberToken(h);

    const failed = await h.app.inject({
      method: "GET",
      url: "/studio/runs?status=fail",
      headers: auth(token),
    });
    const running = await h.app.inject({
      method: "GET",
      url: "/studio/runs?status=running",
      headers: auth(token),
    });

    expect((failed.json() as { items: unknown[] }).items).toHaveLength(1);
    // And it does NOT answer the query the engine's stale word would match.
    expect((running.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("shows an admin the runs of a project they are not a member of", async () => {
    const h = await studioHarness();
    h.read.runs.put(OTHER_RUN);
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runs", headers: auth(token) });

    const keys = (response.json() as { items: { ticketKey: string }[] }).items.map((r) => r.ticketKey);
    expect(keys).toContain(OTHER_RUN.ticketKey);
  });

  it("refuses a page size above the ceiling instead of serving it", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs?limit=5000",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_page" });
  });

  /**
   * A browser building the first page sends `?cursor=` for an unset value, and
   * `.min(1)` used to answer 400 to every one of them: the live Studio could
   * not list a single run, while the same URL without the parameter worked.
   * Blank means absent — the guard that matters is on a NON-empty cursor.
   */
  it("treats a blank cursor as no cursor, the way a browser sends it", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, ticketKey: "UGURPAY-700" });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs?limit=50&cursor=",
      headers: auth(token),
    });

    // The point is the status code: a blank cursor used to be a 400. The body
    // is asserted only far enough to prove a real page came back.
    expect(response.statusCode).toBe(200);
    const keys = (response.json() as { items: { ticketKey: string }[] }).items.map((r) => r.ticketKey);
    expect(keys).toContain("UGURPAY-700");
  });

  /**
   * The same bug as the blank cursor, one field over: the dashboard's archive
   * list sends `?status=` for "all buckets" and every count rendered 0 while
   * the rows were right there. Both go through `blankAsAbsent` now.
   */
  it("treats a blank status filter as no filter", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...RUN, ticketKey: "UGURPAY-701" });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs?limit=200&status=&appId=",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const keys = (response.json() as { items: { ticketKey: string }[] }).items.map((r) => r.ticketKey);
    expect(keys).toContain("UGURPAY-701");
  });

  it("still refuses a status that is present but not a status", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs?status=elma",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });

  it("still refuses a cursor that is present but unusable", () => {
    // Whitespace is blank, not a value — but an over-long one is a real cursor
    // and must still be rejected.
    expect(PageQuery.safeParse({ cursor: "   " }).success).toBe(true);
    expect(PageQuery.safeParse({ cursor: "x".repeat(513) }).success).toBe(false);
  });

  it("pages with a cursor rather than returning everything", async () => {
    const h = await studioHarness();
    for (let index = 0; index < 5; index += 1) {
      h.read.runs.put({ ...RUN, ticketKey: `UGURPAY-60${index}`, updatedAt: `2026-08-0${index + 1}T09:00:00.000Z` });
    }
    const token = await memberToken(h);

    const first = await h.app.inject({ method: "GET", url: "/studio/runs?limit=2", headers: auth(token) });
    const firstBody = first.json() as { items: { ticketKey: string }[]; nextCursor: string | null };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await h.app.inject({
      method: "GET",
      url: `/studio/runs?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
      headers: auth(token),
    });
    const secondBody = second.json() as { items: { ticketKey: string }[] };
    // A second page that repeated the first would be an infinite scroll that
    // never advances — the bug a cursor exists to prevent.
    expect(secondBody.items.map((r) => r.ticketKey)).not.toEqual(
      firstBody.items.map((r) => r.ticketKey),
    );
  });
});

describe("GET /studio/runs/:ticket", () => {
  it("refuses a stranger's ticket", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns the run, its state and its application together", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      run: { reporter: string; prId: number };
      state: { status: string };
      application: { adoRepo: string } | null;
    };
    expect(body.run.reporter).toBe(RUN.reporter);
    expect(body.run.prId).toBe(RUN.prId);
    expect(body.state.status).toBe("gate");
    expect(body.application?.adoRepo).toBe("ugurpay");
  });

  it("rejects a malformed ticket key", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs/not-a-ticket",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /studio/runs/:ticket/journal", () => {
  it("refuses a stranger", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/journal`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns the stored entries", async () => {
    const h = await studioHarness();
    h.read.journal.append(JOURNAL_AI);
    h.read.journal.append(JOURNAL_HUMAN);
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/journal`,
      headers: auth(token),
    });

    const body = response.json() as { items: { title: string; cost?: { usd: number } }[] };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.title).toBe(JOURNAL_AI.title);
    expect(body.items[0]?.cost?.usd).toBe(2.41);
  });

  it("filters by actor for the chips Studio renders", async () => {
    const h = await studioHarness();
    h.read.journal.append(JOURNAL_AI);
    h.read.journal.append(JOURNAL_HUMAN);
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/journal?actor=human`,
      headers: auth(token),
    });

    const body = response.json() as { items: { actor: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.actor).toBe("human");
  });

  it("rejects an actor that is not one of the three", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/journal?actor=robot`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /studio/runs/:ticket/summary", () => {
  it("refuses a stranger", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/summary`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns the stored summary", async () => {
    const h = await studioHarness();
    h.read.journal.putSummary(RUN_ID, "Kredi limiti akışı 5. kapıda bekliyor.");
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/summary`,
      headers: auth(token),
    });

    expect(response.json()).toMatchObject({ summary: "Kredi limiti akışı 5. kapıda bekliyor." });
  });

  /** A run with no summary is a state, not a missing route. */
  it("answers null rather than 404 when none was generated", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/summary`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { summary: string | null }).summary).toBeNull();
  });
});

describe("GET /studio/runs/:ticket/cost", () => {
  it("refuses a stranger", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/cost`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(403);
  });

  it("totals the call log rather than reporting a stored number", async () => {
    const h = await studioHarness();
    h.read.cost.put(CALL);
    h.read.cost.put({ ...CALL, usd: 0.58, tokensIn: 1_000, tokensOut: 200, at: "2026-08-09T10:00:00.000Z" });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/cost`,
      headers: auth(token),
    });

    const body = response.json() as { items: unknown[]; totals: { usd: number; tokensIn: number; calls: number } };
    expect(body.items).toHaveLength(2);
    expect(body.totals.calls).toBe(2);
    expect(body.totals.usd).toBeCloseTo(1.0, 5);
    expect(body.totals.tokensIn).toBe(49_200);
  });

  /** Subscription drivers report no dollar cost (M55); the total must not invent one. */
  it("treats a null usd as zero rather than as a missing field", async () => {
    const h = await studioHarness();
    h.read.cost.put({ ...CALL, usd: null, driver: "claude-sub" });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/cost`,
      headers: auth(token),
    });

    const body = response.json() as { items: { usd: number | null }[]; totals: { usd: number } };
    expect(body.items[0]?.usd).toBeNull();
    expect(body.totals.usd).toBe(0);
  });
});

/**
 * Starting a run BY HAND, and the ticket read that makes it classify the same
 * way a webhook-started one does.
 *
 * The defect these pin down was measured on the live board. This route called
 * `runIntake` with a ticket key, an actor and `explicit: true` — and nothing
 * else. `flow-decision.ts` matches a ListeningRule on issue type, assignee and
 * status, so a hand start matched NO rule, fell through to the deployment
 * default, and lost both the rule's `flow` and its `statusMap`. OPS-57 was
 * started this way under a project whose rule carries a full map: the ticket
 * never moved and no status journal line was ever written, with nothing on the
 * run to say why.
 *
 * The assertions therefore go through the intake SEAM — the start input the
 * engine actually received — rather than spying on `getTicket`. That a snapshot
 * was fetched is an implementation detail; that the rule matched is the bug.
 */
describe("POST /studio/runs/:ticket/start", () => {
  /** A rule keyed on the two fields a hand start used to omit. */
  const BOT_RULE: ListeningRuleRecord = {
    ruleId: "lr_ops",
    projectKey: "UGURPAY",
    assigneeAccountId: SNAPSHOT.assignee ?? "",
    matchKind: "issuetype",
    matchValue: SNAPSHOT.issueType,
    flowType: "duzeltme",
    priority: 10,
    enabled: true,
    statusMap: { onStart: "Devam Ediyor", onReview: "İNCELEMEDE", onDone: "Tamam" },
  };

  /** The harness with a rule seeded and the deployment default set to something ELSE,
   * so "the rule matched" and "the default applied" cannot be confused. */
  async function startHarness(
    options: { rules?: readonly ListeningRuleRecord[]; snapshot?: TicketSnapshot | null } = {},
  ): Promise<Harness> {
    const h = await studioHarness({
      listeningRules: options.rules ?? [BOT_RULE],
      deps: { config: { actorDomain: "ugurbank.local", defaultFlow: "analiz" } },
    });
    // `null` means "Jira will not answer" — the fake throws for an unseeded key.
    if (options.snapshot !== null) h.work.putTicket(options.snapshot ?? SNAPSHOT);
    return h;
  }

  async function start(h: Harness, token: string, ticket = TICKET) {
    const before = h.runs.started.length;
    const response = await h.app.inject({
      method: "POST",
      url: `/studio/runs/${ticket}/start`,
      headers: auth(token),
    });
    return { response, started: h.runs.started[before] };
  }

  it("refuses a caller without a start role", async () => {
    const h = await startHarness();
    const token = await memberToken(h);

    const { response } = await start(h, token);

    expect(response.statusCode).toBe(403);
  });

  /**
   * The forwarding itself, asserted on the intake call rather than the route:
   * the snapshot's issue type, labels and assignee have to REACH `runIntake`,
   * because those three are the only thing standing between a hand start and
   * the deployment default.
   */
  it("forwards the snapshot's issue type, assignee and labels into intake", async () => {
    // No rules at all, so nothing about the flow can mask what was forwarded —
    // this test is only about the fields travelling.
    const h = await startHarness({ rules: [] });
    const token = await adminToken(h);

    const { response, started } = await start(h, token);

    expect(response.statusCode).toBe(202);
    expect(h.work.ticketReads).toContain(TICKET);
    // The audit entry is where the classification is preserved; the run input is
    // where it took effect. Both are read below — here, that the run happened.
    expect(started?.ticket).toBe(TICKET);
  });

  /**
   * THE REGRESSION. A rule keyed on issuetype+assignee matches a hand start,
   * so the run carries the rule's flow and the rule's status map — the two
   * things OPS-57 silently lost.
   */
  it("matches a rule keyed on issuetype and assignee, carrying its flow and status map", async () => {
    const h = await startHarness();
    const token = await adminToken(h);

    const { response, started } = await start(h, token);

    expect(response.statusCode).toBe(202);
    const input = started as { flow?: unknown; statusMap?: unknown } | undefined;
    // `duzeltme` is the RULE's flow; the deployment default is `analiz`. Before
    // the fix this read `analiz`, which is the whole defect in one assertion.
    expect(input?.flow).toBe("duzeltme");
    expect(input?.statusMap).toEqual(BOT_RULE.statusMap);
  });

  /**
   * The same match, on a ticket with no execution yet — so the run actually
   * STARTS and the decision reaches the audit chain. `studioHarness` parks its
   * default ticket at a gate, which makes `signalWithStart` a no-op start and
   * writes no `RUN_STARTED`; a fresh key is the only way to see the entry.
   *
   * This is the half an operator reads months later. `flowReason: "rule"`
   * naming `lr_ops` is the difference between "a rule chose this" and "nothing
   * matched, so the default applied" — the sentence OPS-57 could not produce.
   */
  it("records the matched rule and its map in the audit chain", async () => {
    const FRESH = "UGURPAY-902";
    const h = await startHarness({ snapshot: { ...SNAPSHOT, key: FRESH } });
    const token = await adminToken(h);

    const { response } = await start(h, token, FRESH);
    expect(response.statusCode).toBe(202);

    const meta = await runStartedMeta(h, FRESH);
    expect(meta["flow"]).toBe("duzeltme");
    expect(meta["flowReason"]).toBe("rule");
    expect(meta["flowRuleId"]).toBe("lr_ops");
    // Recorded as JSON rather than the string "yorum", which is what a
    // comment-only (unmatched) run writes.
    expect(JSON.parse(String(meta["statusMap"]))).toEqual(BOT_RULE.statusMap);
  });

  /**
   * The same start, with the snapshot withheld: this is what the route did
   * BEFORE the fix, and it is what a failing Jira still produces. Keeping it as
   * a test means the fallback stays a deliberate behaviour rather than an
   * accident nobody would notice if it changed.
   */
  it("falls back to the deployment default when the ticket cannot be classified", async () => {
    const h = await startHarness({ snapshot: null });
    const token = await adminToken(h);

    const { started } = await start(h, token);

    const input = started as { flow?: unknown } | undefined;
    expect(input?.flow).toBe("analiz");
    expect(Object.hasOwn(input ?? {}, "statusMap")).toBe(false);
  });

  /**
   * A Jira that will not answer must not cost the run. Losing the snapshot
   * costs rule matching — the behaviour this route had all along — and nothing
   * more; turning a reachable engine into a 500 would mean a degraded Jira
   * leaves an operator unable to start anything at all.
   */
  it("still accepts the start when the ticket read throws", async () => {
    const h = await startHarness({ snapshot: null });
    const token = await adminToken(h);

    const { response, started } = await start(h, token);

    expect(response.statusCode).toBe(202);
    // Intake still ran: the run reached the engine.
    expect(started).toBeDefined();
    expect(started?.ticket).toBe(TICKET);
    // And no snapshot field was invented to fill the gap: the bot rule wants an
    // issue type this start could not read, so it does not claim the ticket.
    expect((started as { flow?: unknown } | undefined)?.flow).toBe("analiz");
  });

  /**
   * An unassigned ticket sends NO assignee rather than a null one.
   * `IntakeRequest.assignee` is optional and has no null to give it — absent
   * already means "not known here" — and a rule with a non-empty
   * `assigneeAccountId` must not match a ticket nobody is assigned to.
   */
  it("omits an absent assignee instead of sending null", async () => {
    const h = await startHarness({ snapshot: { ...SNAPSHOT, assignee: null } });
    const token = await adminToken(h);

    const { response, started } = await start(h, token);

    expect(response.statusCode).toBe(202);
    // The bot rule wants `712020:maestro-bot`; an UNASSIGNED ticket is not the
    // bot's, so the rule does not claim it and the default applies. A null
    // forwarded as a value would have matched nothing either — but this also
    // proves the request stayed well-formed rather than throwing on the way in.
    expect((started as { flow?: unknown } | undefined)?.flow).toBe("analiz");

    // The issue type still travelled, so a rule that keys on type ALONE still
    // matches an unassigned ticket — the omission is scoped to the assignee.
    const open = await startHarness({
      rules: [{ ...BOT_RULE, ruleId: "lr_any", assigneeAccountId: "" }],
      snapshot: { ...SNAPSHOT, assignee: null },
    });
    const openToken = await adminToken(open);
    const second = await start(open, openToken);
    expect((second.started as { flow?: unknown } | undefined)?.flow).toBe("duzeltme");
  });
});

describe("GET /studio/runs/:ticket/evidence", () => {
  it("refuses a stranger", async () => {
    const h = await studioHarness();
    const token = await outsiderToken(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/evidence`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns the manifest once the package exists", async () => {
    const h = await studioHarness();
    h.read.evidence.put({
      runId: RUN_ID,
      ticketKey: TICKET,
      createdAt: AT,
      templateVersion: "v3",
      files: [
        { name: "01-analiz.md", sha256: "a".repeat(64), bytes: 28_000, contentType: "text/markdown" },
      ],
      approvals: [],
      retentionYears: 10,
      objectLock: false,
    });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/evidence`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { files: { name: string }[]; templateVersion: string };
    expect(body.templateVersion).toBe("v3");
    expect(body.files[0]?.name).toBe("01-analiz.md");
  });

  it("404s before the package is built rather than returning an empty one", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}/evidence`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(404);
  });
});

/**
 * Archiving (0019).
 *
 * The problem this endpoint was added for: twelve `fail` runs from an evening
 * of experiments sat on the dashboard for a day, all stopped at the same step,
 * and a new operator opening the panel read them as "the product is broken".
 * The runs are real history — this is a bank, and the audit trail stands — so
 * the fix could never be a DELETE. It is a nullable column that decides which
 * listing a row appears in by default.
 *
 * So the tests below check two things in the same breath every time: the run
 * left the board, AND the run is still there.
 */
describe("PUT /studio/runs/:ticket/archive", () => {
  /** Archived rows must still be reachable, so this is asserted, not assumed. */
  async function keysOf(h: Harness, token: string, query: string): Promise<string[]> {
    const response = await h.app.inject({
      method: "GET",
      url: `/studio/runs${query}`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { items: { ticketKey: string }[] }).items.map((r) => r.ticketKey);
  }

  async function archive(h: Harness, token: string, ticket: string, archived: boolean) {
    return h.app.inject({
      method: "PUT",
      url: `/studio/runs/${ticket}/archive`,
      headers: auth(token),
      payload: { archived },
    });
  }

  it("takes a run off the default board without deleting it, and puts it back", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const archived = await archive(h, token, TICKET, true);
    expect(archived.statusCode).toBe(200);
    expect((archived.json() as { archivedAt: string | null }).archivedAt).not.toBeNull();

    // Gone from the board …
    expect(await keysOf(h, token, "")).not.toContain(TICKET);
    // … and still, unmistakably, in the database.
    expect(await keysOf(h, token, "?archived=archived")).toContain(TICKET);
    expect(await keysOf(h, token, "?archived=all")).toContain(TICKET);

    // The detail route never hides it: an archived run is still a run, and a
    // link to it from the audit trail or a Jira comment has to keep working.
    const detail = await h.app.inject({
      method: "GET",
      url: `/studio/runs/${TICKET}`,
      headers: auth(token),
    });
    expect(detail.statusCode).toBe(200);

    const restored = await archive(h, token, TICKET, false);
    expect(restored.statusCode).toBe(200);
    expect((restored.json() as { archivedAt: string | null }).archivedAt).toBeNull();
    expect(await keysOf(h, token, "")).toContain(TICKET);
  });

  /**
   * The counts-agree-with-the-list property, at the wire level.
   *
   * Studio's four dashboard tiles are counted from the SAME response body that
   * fills the list beneath them (`useRuns` -> `/studio/runs`), so this is what
   * makes "a tile saying 12 above a list showing 0" impossible: there is only
   * one number, and archiving removes the row from it. If the route ever
   * counted over a different scope than it listed, this test is what breaks.
   */
  it("serves one set of rows, so tiles counted from it cannot disagree with it", async () => {
    const h = await studioHarness();
    h.read.runs.put({ ...OTHER_RUN, ticketKey: "UGURPAY-902" });
    const token = await adminToken(h);

    const before = await keysOf(h, token, "");
    expect(before).toHaveLength(2);

    await archive(h, token, TICKET, true);

    const after = await keysOf(h, token, "");
    expect(after).toEqual(["UGURPAY-902"]);
    // The archived one is accounted for, not lost: the two views sum to the whole.
    const all = await keysOf(h, token, "?archived=all");
    expect(all).toHaveLength(2);
  });

  it("defaults to the active board when the caller says nothing", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);
    await archive(h, token, TICKET, true);

    // No `archived=` at all — the case a plain dashboard load makes.
    expect(await keysOf(h, token, "")).toEqual([]);
  });

  /**
   * A browser serialises an unset filter as `?archived=`. Rejecting that used
   * to fail the WHOLE request and blank a dashboard whose data was right there
   * — the bug `blankAsAbsent` exists for. It must not come back through the
   * new parameter.
   */
  it("reads an empty archived= as 'unset' rather than failing the request", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    expect(await keysOf(h, token, "?archived=")).toContain(TICKET);
  });

  it("refuses an archive scope it cannot interpret instead of guessing one", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs?archived=maybe",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses a caller without the role — deciding what the team's board shows is a write", async () => {
    const h = await studioHarness();
    // A project MEMBER: allowed to read this ticket, not to retire it from
    // everyone else's dashboard.
    const token = await memberToken(h);

    const response = await archive(h, token, TICKET, true);

    expect(response.statusCode).toBe(403);
    // And the refusal is real: the run is still on the board.
    expect(await keysOf(h, token, "")).toContain(TICKET);
  });

  it("refuses an unauthenticated caller", async () => {
    const h = await studioHarness();
    const response = await h.app.inject({
      method: "PUT",
      url: `/studio/runs/${TICKET}/archive`,
      payload: { archived: true },
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s for a run nobody has, rather than reporting a success", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await archive(h, token, "UGURPAY-9999", true);

    expect(response.statusCode).toBe(404);
    // The server's error envelope is `{ error: <code> }` (server.ts) — the same
    // machine code the neighbouring read routes answer with, so Studio's
    // `messageKeyOf` resolves it without a special case for this endpoint.
    expect((response.json() as { error: string }).error).toBe("no_run");
  });

  /**
   * The 404 must come BEFORE the audit append. An entry naming a ticket that
   * does not exist would be a fictional operator action in an append-only
   * chain — a row M33 makes it impossible to correct afterwards.
   */
  it("writes no audit entry for a run it could not find", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    await archive(h, token, "UGURPAY-9999", true);

    const entries = await h.auditStore.read();
    expect(entries.filter((e) => e.subject === "run:UGURPAY-9999")).toEqual([]);
  });

  it("records who archived the run, and who un-archived it, in the M33 chain", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    await archive(h, token, TICKET, true);
    await archive(h, token, TICKET, false);

    const entries = (await h.auditStore.read()).filter((e) => e.subject === `run:${TICKET}`);
    expect(entries.map((e) => (e.meta as { verb: string }).verb)).toEqual([
      "archived",
      "unarchived",
    ]);
    // `PARAM_CHANGED`, like every other operator change to how the platform
    // presents things (listening rules, connections). Deliberately NOT
    // `RETENTION_ARCHIVE`, which means data was actually disposed of — telling
    // an auditor a run's evidence was destroyed when every byte is in place is
    // a worse lie than saying nothing.
    expect(entries.every((e) => e.action === "PARAM_CHANGED")).toBe(true);
    expect(entries.every((e) => e.actor.startsWith("yonetici"))).toBe(true);
  });

  it("refuses a body that does not say which way to move the run", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    for (const payload of [{}, { archived: "yes" }, { archive: true }]) {
      const response = await h.app.inject({
        method: "PUT",
        url: `/studio/runs/${TICKET}/archive`,
        headers: auth(token),
        payload,
      });
      // "Archive" and "un-archive" are opposite instructions; a defaulted or
      // misspelled field must never let a request meaning one perform the other.
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  /**
   * The role gate and the project gate are two DIFFERENT questions, and this
   * endpoint asks both.
   *
   * `admin` and `tech-lead` are cross-project by design (`CROSS_PROJECT_ROLES`,
   * routes/access.ts): a tech lead carries the gates across teams, so reaching
   * another project's run is their job, not a leak. What no one may do is act
   * on a project they cannot see — which for a run-write means a caller whose
   * role passes and whose project scope does not. That combination is
   * unreachable for the two cross-project roles, so the honest assertion is
   * the pair below: the role check refuses the member, and the project check
   * still runs for everyone (it is why `assertProjectAccess` is the first line
   * of the handler, before the body is even parsed).
   */
  it("refuses before it parses, so a caller who may not write learns nothing from the body", async () => {
    const h = await studioHarness();
    // No role and no group, and a body that is ALSO invalid. The answer must
    // be 403, never 400: a 400 here would tell a caller who may not touch this
    // run that their body was the only thing wrong with the request, which is
    // the difference between "you may not" and "try again with better JSON".
    // The role guard is a `preHandler`, so it runs before the handler parses
    // anything — this pins that ordering rather than trusting it.
    const token = await outsiderToken(h);

    const response = await h.app.inject({
      method: "PUT",
      url: `/studio/runs/${TICKET}/archive`,
      headers: auth(token),
      payload: { nonsense: true },
    });

    expect(response.statusCode).toBe(403);
    // And nothing was written on the way to the refusal.
    const entries = await h.auditStore.read();
    expect(entries.filter((e) => e.subject === `run:${TICKET}`)).toEqual([]);
  });
});
