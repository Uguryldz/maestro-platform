import { describe, expect, it } from "vitest";
import { moveTicketStatus } from "../src/impl/status-move.js";
import { makeFakes, SNAPSHOT } from "./fakes.js";

/**
 * The activity behind the listening rule's status map: moving the ticket, and
 * saying why it did not move.
 *
 * Two properties are load-bearing and everything below is about one of them:
 *
 *  1. **It never throws.** Five points inside the ticket workflow call this,
 *     and a run whose analysis is written and approved must not die because
 *     somebody's Jira workflow has no edge to the column their rule names. So
 *     every failure — a refused transition, a driver that has no transition API
 *     at all, a driver that breaks its own contract and throws — comes back as
 *     data.
 *  2. **The reason is written down.** Fail-soft is only defensible when the
 *     failure is visible; a swallowed refusal leaves an operator watching
 *     tickets never reach 'Tamam' with nothing anywhere to explain it.
 */

const TICKET = "PAY-101";

describe("moveTicketStatus — the happy path", () => {
  it("asks the driver for the status the rule named, and journals the move", async () => {
    const fakes = makeFakes();
    const result = await moveTicketStatus(fakes.deps, TICKET, { at: "review", status: "İNCELEMEDE" });

    expect(result).toEqual({ moved: true, reassigned: false });
    expect(fakes.recorded.moved).toEqual([{ ticket: TICKET, statusName: "İNCELEMEDE" }]);
    const line = fakes.journalStore.entries.at(-1);
    expect(line?.title).toBe("durum: incelemede");
    expect(line?.detail).toContain("İNCELEMEDE");
  });

  /**
   * Whitespace in a hand-typed rule is the operator's, not Jira's. Trimming
   * here rather than in the driver keeps the driver's own `bad_status_name`
   * guard for what it is really for: a rule whose value is blank.
   */
  it("trims the status name before handing it over", async () => {
    const fakes = makeFakes();
    await moveTicketStatus(fakes.deps, TICKET, { at: "done", status: "  Tamam  " });

    expect(fakes.recorded.moved).toEqual([{ ticket: TICKET, statusName: "Tamam" }]);
  });
});

describe("the capability check — a driver that cannot transition", () => {
  /**
   * The Data Center deployment. Its driver has no `transitionToStatus` at all,
   * so the composition root passes no `StatusMover` — and that is a SUPPORTED
   * configuration, not a broken one: M102 is why progress there is a label.
   * The flow degrades to exactly what it did before the map existed.
   */
  it("degrades silently to comment-only mode, without failing", async () => {
    const fakes = makeFakes({ noStatusMover: true });
    const result = await moveTicketStatus(fakes.deps, TICKET, { at: "start", status: "Devam Ediyor" });

    expect(result).toEqual({ moved: false, reason: "no_capability", reassigned: false });
    expect(fakes.recorded.moved).toEqual([]);
    expect(fakes.recorded.comments).toEqual([]);
  });

  /**
   * "Silently" means to the FLOW, not to the operator. A rule an admin
   * deliberately configured that quietly does nothing is its own failure mode —
   * the journal has to say the deployment cannot do it.
   */
  it("still writes the reason into the journal", async () => {
    const fakes = makeFakes({ noStatusMover: true });
    await moveTicketStatus(fakes.deps, TICKET, { at: "start", status: "Devam Ediyor" });

    const line = fakes.journalStore.entries.at(-1);
    expect(line?.title).toBe("durum: işe alındı");
    expect(line?.detail).toContain("yalnız yorum modu");
  });

  it("still hands the ticket back to its reporter when the rule asked for that", async () => {
    // The two halves are independent: a deployment that cannot transition can
    // still assign, and losing the hand-back with the transition would strand
    // the reporter's question in Maestro's queue.
    const fakes = makeFakes({ noStatusMover: true });
    const result = await moveTicketStatus(fakes.deps, TICKET, {
      at: "need_info",
      status: "Yapılacaklar",
      toReporter: true,
    });

    expect(result.reassigned).toBe(true);
    expect(fakes.recorded.assignments).toEqual([{ ticket: TICKET, to: SNAPSHOT.reporter }]);
  });
});

describe("warn but continue — every refusal is data, never a throw", () => {
  it("reports a forbidden transition without rejecting", async () => {
    const fakes = makeFakes({ statusMove: () => ({ moved: false, reason: "forbidden" }) });
    const result = await moveTicketStatus(fakes.deps, TICKET, { at: "done", status: "Tamam" });

    expect(result).toEqual({ moved: false, reason: "forbidden", reassigned: false });
    expect(fakes.journalStore.entries.at(-1)?.detail).toContain("Transition Issues");
    // The line has to say the flow was NOT affected, or an operator reading it
    // will go looking for a run that failed and find one that finished.
    expect(fakes.journalStore.entries.at(-1)?.detail).toContain("akış etkilenmedi");
  });

  it("reports a missing edge in the operator's own vocabulary", async () => {
    const fakes = makeFakes({ statusMove: () => ({ moved: false, reason: "no_transition" }) });
    const result = await moveTicketStatus(fakes.deps, TICKET, { at: "review", status: "İNCELEMEDE" });

    expect(result.moved).toBe(false);
    expect(fakes.journalStore.entries.at(-1)?.detail).toContain("geçiş tanımlı değil");
  });

  /**
   * `already` is not a failure at all — a retried step, or a human who moved
   * the card by hand — and it must read as the non-event it is.
   */
  it("reports an already-there ticket as a reason, not an error", async () => {
    const fakes = makeFakes({ statusMove: () => ({ moved: false, reason: "already" }) });
    const result = await moveTicketStatus(fakes.deps, TICKET, { at: "start", status: "Devam Ediyor" });

    expect(result).toEqual({ moved: false, reason: "already", reassigned: false });
    expect(fakes.journalStore.entries.at(-1)?.detail).toContain("zaten bu durumda");
  });

  /**
   * The driver's contract says it cannot throw. Drivers are somebody else's
   * code, and the five call sites inside the workflow must not be able to fail
   * because one of them broke that promise.
   */
  it("survives a driver that throws despite its own contract", async () => {
    const fakes = makeFakes({ statusMoverThrows: true });
    const result = await moveTicketStatus(fakes.deps, TICKET, { at: "done", status: "Tamam" });

    expect(result.moved).toBe(false);
    expect(result.reason).toContain("driver_threw");
    expect(fakes.journalStore.entries.at(-1)?.detail).toContain("taşınamadı");
  });
});

describe("reassignOnNeedInfo — the other half of 'waiting on the reporter'", () => {
  it("assigns the ticket to its reporter and moves it, when both are mapped", async () => {
    const fakes = makeFakes();
    const result = await moveTicketStatus(fakes.deps, TICKET, {
      at: "need_info",
      status: "Yapılacaklar",
      toReporter: true,
    });

    expect(result).toEqual({ moved: true, reassigned: true });
    expect(fakes.recorded.assignments).toEqual([{ ticket: TICKET, to: SNAPSHOT.reporter }]);
    expect(fakes.recorded.moved).toEqual([{ ticket: TICKET, statusName: "Yapılacaklar" }]);
  });

  /**
   * A board that models "waiting on the reporter" as an ASSIGNEE rather than a
   * column. There is nothing to transition to, and inventing a status would
   * drive the ticket somewhere the operator never asked for.
   */
  it("assigns and moves nothing when only the hand-back is mapped", async () => {
    const fakes = makeFakes();
    const result = await moveTicketStatus(fakes.deps, TICKET, { at: "need_info", toReporter: true });

    expect(result).toEqual({ moved: false, reason: "no_status", reassigned: true });
    expect(fakes.recorded.moved).toEqual([]);
    expect(fakes.recorded.assignments).toHaveLength(1);
  });

  /** An assignment Jira refused is a journal line, not a stopped run. */
  it("carries on when the assignment is refused", async () => {
    const fakes = makeFakes({ assignFails: true });
    const result = await moveTicketStatus(fakes.deps, TICKET, {
      at: "need_info",
      status: "Yapılacaklar",
      toReporter: true,
    });

    expect(result).toEqual({ moved: true, reassigned: false });
    // The move still happened — the two halves do not depend on each other.
    expect(fakes.recorded.moved).toEqual([{ ticket: TICKET, statusName: "Yapılacaklar" }]);
    expect(fakes.journalStore.entries.some((e) => e.detail.includes("atanamadı"))).toBe(true);
  });

  /**
   * A ticket may genuinely have no reporter Maestro can act on — an
   * integration account, a migrated issue. Said out loud, exactly as
   * `deliverAnalysis` does for the same fact, rather than treated as an error.
   */
  it("says so when the ticket has no reporter to hand back to", async () => {
    const fakes = makeFakes({ ticket: { ...SNAPSHOT, reporter: "   " } });
    const result = await moveTicketStatus(fakes.deps, TICKET, { at: "need_info", toReporter: true });

    expect(result.reassigned).toBe(false);
    expect(fakes.recorded.assignments).toEqual([]);
    expect(fakes.journalStore.entries.at(-1)?.detail).toContain("talep sahibi okunamadı");
  });
});

describe("idempotency — a retry must not move the ticket twice", () => {
  it("replays the first answer instead of sending a second transition", async () => {
    const fakes = makeFakes();
    const first = await moveTicketStatus(fakes.deps, TICKET, { at: "done", status: "Tamam" });
    const second = await moveTicketStatus(fakes.deps, TICKET, { at: "done", status: "Tamam" });

    expect(first).toEqual(second);
    // Outside an activity context `activitySeq()` answers "local", so the two
    // calls share a key — which is exactly the retry this guard exists for.
    expect(fakes.recorded.moved).toHaveLength(1);
  });

  /**
   * The five points are keyed apart, so a run that maps two of them to the SAME
   * column still moves the ticket at both. Collapsing them would mean a
   * rejection that shares a status with `onStart` silently skipped one of the
   * two moves the operator configured.
   */
  it("keeps the five points apart even when they name one status", async () => {
    const fakes = makeFakes();
    await moveTicketStatus(fakes.deps, TICKET, { at: "start", status: "Devam Ediyor" });
    await moveTicketStatus(fakes.deps, TICKET, { at: "rejected", status: "Devam Ediyor" });

    expect(fakes.recorded.moved).toHaveLength(2);
  });
});
