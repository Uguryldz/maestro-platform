import { describe, expect, it } from "vitest";
import type { WorkflowRunState } from "@maestro/contracts";
import { InMemoryRunGateway } from "../src/fakes/run-gateway.js";

/**
 * `findByRunId` is an exact lookup and must behave like one.
 *
 * The real gateway got this wrong first: it resolved a run id by listing a page
 * of recent runs and looking through it, so the 201st run in a caller's own
 * project answered "no such run" and could not be paused — an admin included.
 * A demo whose fake reproduced that horizon would hide the same class of bug
 * from anyone exercising the platform through Studio, which is precisely what
 * the demo exists to prevent.
 */

function state(ticketKey: string, runId: string, updatedAt: string): WorkflowRunState {
  return {
    runId,
    ticketKey,
    step: "4",
    status: "gate",
    startedAt: "2026-08-01T09:00:00.000Z",
    updatedAt,
  };
}

/** Enough rows that any page-sized scan would miss the tail. */
function manyRuns(count: number): WorkflowRunState[] {
  return Array.from({ length: count }, (_, index) =>
    state(
      `UGURPAY-${1000 + index}`,
      `run-${1000 + index}`,
      // Ascending time, so the LAST one created is the most recently touched
      // and the FIRST one is what a recency-ordered page would drop.
      new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    ),
  );
}

describe("findByRunId", () => {
  it("finds a run that a recency-ordered page would have dropped", async () => {
    const runs = manyRuns(250);
    const gateway = new InMemoryRunGateway(runs);

    // The oldest run: last in recency order, so a 200-row page never reaches it.
    const oldest = runs[0] as WorkflowRunState;
    const found = await gateway.findByRunId(oldest.runId);

    expect(found).not.toBeNull();
    expect(found?.ticketKey).toBe(oldest.ticketKey);
    expect(found?.runId).toBe(oldest.runId);
  });

  it("answers null for an id nobody minted, rather than the nearest match", async () => {
    const gateway = new InMemoryRunGateway(manyRuns(5));
    expect(await gateway.findByRunId("run-does-not-exist")).toBeNull();
    // A prefix of a real id is still not that id.
    expect(await gateway.findByRunId("run-100")).toBeNull();
  });

  it("reports an open run as open and a finished one as closed", async () => {
    const open = state("UGURPAY-501", "run-open", "2026-08-02T09:00:00.000Z");
    const done: WorkflowRunState = {
      ...state("UGURPAY-478", "run-done", "2026-08-02T10:00:00.000Z"),
      status: "done",
    };
    const gateway = new InMemoryRunGateway([open, done]);

    expect((await gateway.findByRunId("run-open"))?.closedAt).toBeNull();
    expect((await gateway.findByRunId("run-done"))?.closedAt).toBe(done.updatedAt);
  });

  it("keys on the run id, not on the ticket key", async () => {
    const gateway = new InMemoryRunGateway([state("UGURPAY-501", "run-ugurpay-501", "2026-08-02T09:00:00.000Z")]);
    // Passing the ticket key where a run id belongs must not silently succeed.
    expect(await gateway.findByRunId("UGURPAY-501")).toBeNull();
    expect(await gateway.findByRunId("run-ugurpay-501")).not.toBeNull();
  });
});
