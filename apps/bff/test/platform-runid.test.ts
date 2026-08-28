import { describe, expect, it } from "vitest";
import type { TicketKey } from "@maestro/contracts";
import { PLATFORM_MAX_LIMIT } from "../src/platform/index.js";
import { RUN, studioHarness, TICKET } from "./studio-fixtures.js";
import type { Harness } from "./helpers.js";

/**
 * Resolving a `runId` must not depend on how many runs the bank has (Y-1).
 *
 * `runOf` used to answer "which run is this" by listing one page of the run
 * catalog — `PLATFORM_MAX_LIMIT` rows, newest first — and searching it. That
 * made the page's horizon into a correctness boundary: past it, a caller's own
 * run answered `no_run`, so `getRun`, `getJournal`, `setWorkMode`, `pauseRun`,
 * `resumeRun`, `retryStep` and `notifyGateOwner` all stopped working on it, and
 * an admin could not pause a run they could see in Studio either. Two hundred
 * runs is a small number for a bank's SDLC, so this was reachable, and the
 * symptom — "no such run" — pointed at the wrong diagnosis.
 *
 * The numbers here are deliberately past that horizon.
 */

const MEMBER = "uye.kisi";
const MEMBER_ACTOR = "uye.kisi@ugurbank.local";
const ADMIN_ACTOR = "yonetici@ugurbank.local";
/** Comfortably past one page, so the old scan could not have reached it. */
const SEEDED = PLATFORM_MAX_LIMIT + 50;

/**
 * Seed `SEEDED` runs in the caller's OWN project, oldest last by `updatedAt`
 * so the far run is the one a recency-ordered page would drop first.
 */
async function crowdedHarness(): Promise<{ h: Harness; farTicket: TicketKey; farRunId: string }> {
  const h = await studioHarness();
  await h.addUser({ username: MEMBER, groups: ["maestro-ugurpay"] });
  await h.addUser({ username: "yonetici", roles: ["admin"], groups: ["maestro-ugurpay"] });

  for (let index = 0; index < SEEDED; index += 1) {
    const ticket = `UGURPAY-${2000 + index}` as TicketKey;
    // Descending timestamps: index 0 is newest, so the last one seeded sits at
    // the bottom of the catalog's ordering.
    const updatedAt = new Date(Date.UTC(2026, 7, 9, 9, 0, 0) - index * 60_000).toISOString();
    h.read.runs.put({ ...RUN, ticketKey: ticket, updatedAt, startedAt: updatedAt });
    h.runs.openGate(ticket, "5");
  }

  const farTicket = `UGURPAY-${2000 + SEEDED - 1}` as TicketKey;
  return { h, farTicket, farRunId: `run-${farTicket}` };
}

describe("runId resolution past the page horizon", () => {
  it("seeds more runs than a single page can hold", async () => {
    const { h } = await crowdedHarness();

    // The premise of the whole file: a single page genuinely cannot see the
    // far run, so the tests below are not passing by accident.
    const page = await h.read.runs.list({
      limit: PLATFORM_MAX_LIMIT,
      cursor: null,
      appId: null,
      projectKeys: null,
      archived: "active",
    });
    expect(page.items).toHaveLength(PLATFORM_MAX_LIMIT);
    expect(page.items.map((row) => row.ticketKey)).not.toContain(`UGURPAY-${2000 + SEEDED - 1}`);
  });

  it("reads a run in the caller's own project past the horizon", async () => {
    const { h, farTicket, farRunId } = await crowdedHarness();

    const detail = await h.platform.getRun(MEMBER_ACTOR, farRunId);

    expect(detail.state.runId).toBe(farRunId);
    expect(detail.state.ticketKey).toBe(farTicket);
  });

  it("lets an operator pause a run past the horizon", async () => {
    const { h, farTicket, farRunId } = await crowdedHarness();

    const result = await h.platform.pauseRun(MEMBER_ACTOR, { runId: farRunId, reason: "inceleme" });

    expect(result).toMatchObject({ runId: farRunId, status: "paused" });
    // The signal reached the far run's OWN workflow, not the nearest one.
    expect(h.runs.signals).toHaveLength(1);
    expect(h.runs.signals[0]).toMatchObject({
      workflowId: `maestro-${farTicket}`,
      arg: { mode: "human_only" },
    });
  });

  it("lets an admin resume and retry a run past the horizon", async () => {
    const { h, farTicket, farRunId } = await crowdedHarness();

    await h.platform.resumeRun(ADMIN_ACTOR, { runId: farRunId, reason: "devam" });
    await h.platform.retryStep(ADMIN_ACTOR, { runId: farRunId, step: "5", reason: "geçici" });

    expect(h.runs.signals.map((signal) => signal.workflowId)).toEqual([
      `maestro-${farTicket}`,
      `maestro-${farTicket}`,
    ]);
  });

  /**
   * The horizon affected `runOf`, so every method that goes through it is
   * checked rather than a representative one — a fix applied at one call site
   * would otherwise look complete.
   */
  it("serves every runOf-backed method past the horizon", async () => {
    const { h, farRunId } = await crowdedHarness();

    await expect(h.platform.getRun(MEMBER_ACTOR, farRunId)).resolves.toBeDefined();
    await expect(
      h.platform.getJournal(MEMBER_ACTOR, farRunId, { fromSeq: 0, limit: 10 }),
    ).resolves.toBeDefined();
    await expect(
      h.platform.setWorkMode(MEMBER_ACTOR, { runId: farRunId, mode: "ai_assist", reason: "x" }),
    ).resolves.toBeDefined();
    await expect(
      h.platform.notifyGateOwner(MEMBER_ACTOR, { runId: farRunId, step: "5", message: null }),
    ).rejects.toMatchObject({ status: 404, code: "no_open_gate" });
  });

  /**
   * Access is still decided by the caller's projects, not by the lookup being
   * cheaper. A direct `findByRunId` that skipped the project check would have
   * traded a horizon bug for an authorisation one.
   */
  it("still refuses a run in a project the caller cannot see", async () => {
    const { h } = await crowdedHarness();
    const foreign = "UGURWEB-104" as TicketKey;
    h.read.runs.put({ ...RUN, ticketKey: foreign, appId: "ugurweb" });
    h.runs.openGate(foreign, "5");

    await expect(h.platform.getRun(MEMBER_ACTOR, `run-${foreign}`)).rejects.toMatchObject({
      status: 404,
      code: "no_run",
    });
    await expect(
      h.platform.pauseRun(MEMBER_ACTOR, { runId: `run-${foreign}`, reason: "x" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.runs.signals).toHaveLength(0);
  });

  /**
   * "Not yours" and "no such run" stay indistinguishable — the refusal must not
   * become a way to probe which run ids exist. The note is the only thing that
   * changed, and it says which two things the code means without saying which
   * one happened.
   */
  it("refuses an unknown run the same way, and says the refusal is ambiguous", async () => {
    const { h } = await crowdedHarness();
    const foreign = "UGURWEB-104" as TicketKey;
    h.read.runs.put({ ...RUN, ticketKey: foreign, appId: "ugurweb" });
    h.runs.openGate(foreign, "5");

    const unknown = await h.platform.getRun(MEMBER_ACTOR, "run-YOK-9999").catch((e: unknown) => e);
    const hidden = await h.platform.getRun(MEMBER_ACTOR, `run-${foreign}`).catch((e: unknown) => e);

    expect(hidden).toMatchObject({ status: 404, code: "no_run" });
    expect(unknown).toMatchObject({ status: 404, code: "no_run" });
    // Same code AND same detail shape: the operator cannot tell the two apart,
    // and neither can a caller probing for ids.
    expect(JSON.stringify(unknown)).toBe(
      JSON.stringify(hidden).replace(`run-${foreign}`, "run-YOK-9999"),
    );
    // But the message no longer reads as "this run was deleted".
    expect((unknown as { details?: { note?: string } }).details?.note).toMatch(/project you can see/);
  });

  /** A known run in the caller's project still resolves — sanity against a fix that refuses everything. */
  it("still resolves the ordinary near run", async () => {
    const { h } = await crowdedHarness();

    const detail = await h.platform.getRun(MEMBER_ACTOR, `run-${TICKET}`);

    expect(detail.state.ticketKey).toBe(TICKET);
  });
});
