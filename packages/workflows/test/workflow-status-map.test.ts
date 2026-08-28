import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scenario, createTestEnv, runTicket } from "./harness.js";

/**
 * What the listening rule's STATUS MAP changes about a run.
 *
 * The complaint this answers is a real one: a team watching their board saw a
 * Maestro ticket sit in one column for a day and a half while the run went
 * through intake, analysis, two approval gates and a delivery. Every one of
 * those was written into the ticket as a comment. None of it was where anybody
 * looks. The map lets an operator say which column each of those five moments
 * corresponds to on THEIR board, and these tests pin what happens when they do
 * — and, just as importantly, what happens when they do not.
 *
 * The policy under test throughout is WARN BUT CONTINUE. A move that Jira
 * refuses is a board that is briefly out of date; a run that stopped over it is
 * work that did not get done, and the analysis is the deliverable either way.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(async () => {
  await env?.teardown();
});

/** A map that names every point, so one run can exercise all of them. */
const FULL_MAP = {
  onStart: "Devam Ediyor",
  onNeedInfo: "Yapılacaklar",
  onReview: "İNCELEMEDE",
  onRejected: "Devam Ediyor",
  onDone: "Tamam",
} as const;

describe("no status map — comment-only mode, unchanged", () => {
  /**
   * The regression this suite exists to prevent. Every rule written before the
   * map existed has none, and driving somebody's board uninvited is the kind of
   * surprise that gets an automation banned from a bank's Jira.
   *
   * Asserted on the REQUESTS, not on the driver: an empty list proves the
   * workflow never scheduled the activity, which is a stronger claim than "the
   * activity decided to do nothing". It is also what keeps the run's history
   * byte-identical to the pre-map version.
   */
  it("attempts no transition anywhere in a full run", async () => {
    const run = await runTicket(
      env,
      new Scenario({ flow: "analiz", risk: "dusuk", gate: () => ({ kind: "approve" }) }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.moves).toEqual([]);
  });

  it("attempts no transition even when the ticket goes back to the reporter", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        flow: "analiz",
        risk: "dusuk",
        answerClarification: true,
        gate: () => ({ kind: "approve" }),
      }),
      { runIntake: async () => ({ complete: false, question: "hangi ortam?" }) },
    );

    expect(run.status).toBe("done");
    expect(run.scenario.moves).toEqual([]);
  });

  it("attempts no transition when the map is present but empty", async () => {
    const run = await runTicket(
      env,
      new Scenario({ flow: "analiz", risk: "dusuk", statusMap: {}, gate: () => ({ kind: "approve" }) }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.moves).toEqual([]);
  });
});

describe("a mapped rule — the ticket moves desk to desk", () => {
  it("moves at start, at review and at done, in that order", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        flow: "analiz",
        risk: "dusuk",
        statusMap: FULL_MAP,
        gate: () => ({ kind: "approve" }),
      }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.moves).toEqual([
      { at: "start", status: "Devam Ediyor" },
      { at: "review", status: "İNCELEMEDE" },
      { at: "done", status: "Tamam" },
    ]);
  });

  /**
   * `need_info` is the only point that can happen BEFORE `start`, and it must:
   * a ticket handed back to its reporter has not been picked up, so claiming
   * the in-progress column first would put it there for the length of a
   * question nobody has answered yet.
   */
  it("moves to the need-info status before asking the reporter, then on to start", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        flow: "analiz",
        risk: "dusuk",
        statusMap: FULL_MAP,
        answerClarification: true,
        gate: () => ({ kind: "approve" }),
      }),
      { runIntake: async () => ({ complete: false, question: "hangi ortam?" }) },
    );

    expect(run.status).toBe("done");
    expect(run.scenario.moves.map((m) => m.at)).toEqual(["need_info", "start", "review", "done"]);
    expect(run.scenario.moves[0]).toEqual({ at: "need_info", status: "Yapılacaklar" });
  });

  /**
   * The two halves of "waiting on the reporter" are independent, and a board
   * may model it as an assignee rather than a column. `reassignOnNeedInfo`
   * alone must still reach the activity — with no status to move to — or the
   * ticket never lands in the reporter's queue.
   */
  it("asks for the reporter hand-back even when no need-info status is mapped", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        flow: "analiz",
        risk: "dusuk",
        statusMap: { onDone: "Tamam", reassignOnNeedInfo: true },
        answerClarification: true,
        gate: () => ({ kind: "approve" }),
      }),
      { runIntake: async () => ({ complete: false, question: "hangi ortam?" }) },
    );

    expect(run.status).toBe("done");
    expect(run.scenario.moves[0]).toEqual({ at: "need_info", toReporter: true });
    // Nothing was mapped for start or review, so nothing was attempted there.
    expect(run.scenario.moves.map((m) => m.at)).toEqual(["need_info", "done"]);
  });

  it("carries the reporter hand-back alongside the status when both are mapped", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        flow: "analiz",
        risk: "dusuk",
        statusMap: { ...FULL_MAP, reassignOnNeedInfo: true },
        answerClarification: true,
        gate: () => ({ kind: "approve" }),
      }),
      { runIntake: async () => ({ complete: false, question: "hangi ortam?" }) },
    );

    expect(run.scenario.moves[0]).toEqual({
      at: "need_info",
      status: "Yapılacaklar",
      toReporter: true,
    });
  });

  /**
   * A rejection is the point of the map an operator feels most: without it the
   * card stays in "İNCELEMEDE" while the agent rewrites the analysis, and a
   * second reviewer picks up work that is already back with Maestro.
   */
  it("moves off review on a rejection, and back through review on the retry", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        flow: "analiz",
        risk: "dusuk",
        statusMap: FULL_MAP,
        gate: (_step, visit) =>
          visit === 1 ? { kind: "reject_once", reason: "kapsam eksik" } : { kind: "approve" },
      }),
    );

    expect(run.status).toBe("done");
    /**
     * The whole round trip, across the `continueAsNew` the rejection loop is
     * built on. That second `start`/`review` pair is the point: the run's own
     * idempotency guard is keyed on the workflowId, which SURVIVES the
     * continuation, so a key that did not also carry Temporal's activity id
     * would find both points already claimed and skip them — the ticket would
     * be left in the rejection column through an approval that did happen.
     */
    expect(run.scenario.moves.map((m) => m.at)).toEqual([
      "start",
      "review",
      "rejected",
      "start",
      "review",
      "done",
    ]);
    expect(run.scenario.moves[2]).toEqual({ at: "rejected", status: "Devam Ediyor" });
  });

  /**
   * The engineering flow closes through a different branch of step 13 (merge
   * and evidence, not analysis delivery), and `onDone` has to be on both — a
   * ticket that built software and stayed in "İNCELEMEDE" is the same bug.
   */
  it("moves to done on the engineering flow's close too", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        flow: "gelistirme",
        risk: "dusuk",
        statusMap: FULL_MAP,
        gate: () => ({ kind: "approve" }),
      }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.moves.at(-1)).toEqual({ at: "done", status: "Tamam" });
  });
});

describe("warn but continue — a refused move never costs the run", () => {
  /**
   * The permission failure an operator actually hits: the service account can
   * browse and comment on the issue but was never granted "Transition Issues".
   * Every point refuses. The run must still finish, still deliver, and still
   * have ASKED at each point — a workflow that gave up after the first refusal
   * would leave the board wrong for the rest of the run even after the
   * permission was fixed.
   */
  it("finishes the run when every transition comes back forbidden", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        flow: "analiz",
        risk: "dusuk",
        statusMap: FULL_MAP,
        statusMove: () => ({ moved: false, reason: "forbidden", reassigned: false }),
        gate: () => ({ kind: "approve" }),
      }),
    );

    expect(run.error).toBeNull();
    expect(run.status).toBe("done");
    expect(run.scenario.delivered).toBe(true);
    expect(run.scenario.moves.map((m) => m.at)).toEqual(["start", "review", "done"]);
  });

  /**
   * The journal is the whole point of "warn": a move that did not happen has to
   * be explainable months later. The real activity writes the line itself (see
   * `impl/status-move.ts`); the workflow-level proof is that the run reaches
   * the operator-facing record at all rather than dying at the first refusal.
   */
  it("keeps the flow's own journal intact through the refusals", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        flow: "analiz",
        risk: "dusuk",
        statusMap: FULL_MAP,
        statusMove: () => ({ moved: false, reason: "no_transition", reassigned: false }),
        gate: () => ({ kind: "approve" }),
      }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.journal.at(-1)?.title).toBe("analiz teslim edildi");
  });

  /**
   * The activity's contract is that it NEVER rejects, so the workflow discards
   * its result and branches on nothing. If a future change made a call site
   * depend on `moved`, this is the test that would notice: a run whose every
   * move reported success must take exactly the same path as one whose every
   * move reported failure.
   */
  it("takes the same path whether the moves succeed or fail", async () => {
    const options = { flow: "analiz", risk: "dusuk", statusMap: FULL_MAP } as const;
    const good = await runTicket(
      env,
      new Scenario({ ...options, gate: () => ({ kind: "approve" }) }),
    );
    const bad = await runTicket(
      env,
      new Scenario({
        ...options,
        gate: () => ({ kind: "approve" }),
        statusMove: () => ({ moved: false, reason: "read_failed", reassigned: false }),
      }),
    );

    expect(bad.status).toBe(good.status);
    expect(bad.scenario.opened).toEqual(good.scenario.opened);
    expect(bad.scenario.journal.map((e) => e.title)).toEqual(good.scenario.journal.map((e) => e.title));
  });
});
