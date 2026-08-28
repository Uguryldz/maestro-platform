import { WorkflowExecutionAlreadyStartedError, type Client } from "@temporalio/client";
import { describe, expect, it } from "vitest";
import { TemporalRunGateway, type OpenedRun } from "../src/temporal-gateway.js";

/**
 * `onRunOpened` — the hook that opens a run's `WorkflowRun` row.
 *
 * This exists because of a real deployment state: `signalWithStart` started
 * executions, nothing wrote a run row, and every activity then failed with
 * `RunNotFoundError` against a worker that looked healthy. What is asserted
 * here is the one distinction that failure needed — the hook fires when a
 * start CREATED an execution and stays quiet when the caller merely joined a
 * live one.
 *
 * The client is a hand-built double rather than a Temporal test environment:
 * the behaviour under test is this class's branching, not the server's.
 */

function gatewayWith(
  workflow: Partial<Client["workflow"]>,
  onRunOpened?: (run: OpenedRun) => Promise<void>,
): TemporalRunGateway {
  const client = { workflow } as unknown as Client;
  return new TemporalRunGateway({
    client,
    ...(onRunOpened === undefined ? {} : { onRunOpened }),
  });
}

const INPUT = {
  ticket: "OPS-7",
  appId: "payments",
  mode: "ai_assist",
  dataClass: "gizli",
} as const;

describe("TemporalRunGateway.signalWithStart — opening the run row", () => {
  it("opens the row when a plain start creates the execution", async () => {
    const opened: OpenedRun[] = [];
    const gateway = gatewayWith(
      { start: () => Promise.resolve({}) } as unknown as Partial<Client["workflow"]>,
      async (run) => void opened.push(run),
    );

    const outcome = await gateway.signalWithStart({ ...INPUT });

    expect(outcome.started).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      runId: outcome.workflowId,
      ticket: "OPS-7",
      appId: "payments",
      mode: "ai_assist",
      dataClass: "gizli",
    });
  });

  it("does not open a second row when the ticket already has a run", async () => {
    // The losing side of two racing webhook deliveries. Temporal collapsed
    // them into one execution; a row here would be the duplicate.
    const opened: OpenedRun[] = [];
    const gateway = gatewayWith(
      {
        start: () =>
          Promise.reject(
            new WorkflowExecutionAlreadyStartedError("already started", "maestro-OPS-7", "ticketWorkflow"),
          ),
      } as unknown as Partial<Client["workflow"]>,
      async (run) => void opened.push(run),
    );

    const outcome = await gateway.signalWithStart({ ...INPUT });

    expect(outcome.started).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it("propagates a failure to open the row", async () => {
    // A started execution whose row was not written fails one activity later,
    // far from the cause. Reporting "started" for it would hide that.
    const gateway = gatewayWith({ start: () => Promise.resolve({}) } as unknown as Partial<Client["workflow"]>, () =>
      Promise.reject(new Error("db down")),
    );

    await expect(gateway.signalWithStart({ ...INPUT })).rejects.toThrow("db down");
  });

  it("works without a hook — the gateway stays usable unwired", async () => {
    const gateway = gatewayWith({ start: () => Promise.resolve({}) } as unknown as Partial<Client["workflow"]>);
    await expect(gateway.signalWithStart({ ...INPUT })).resolves.toMatchObject({ started: true });
  });
});

/**
 * What actually reaches the workflow as its start argument.
 *
 * The `flow` and the status map are both decided in the BFF, before the run
 * exists, and PINNED here. This is the last hop; if the gateway drops either
 * of them the workflow silently falls back to the full pipeline in comment-only
 * mode, which looks exactly like a rule nobody configured.
 */
describe("TemporalRunGateway.signalWithStart — the workflow's start argument", () => {
  function capturingGateway(seen: unknown[]): TemporalRunGateway {
    return gatewayWith({
      start: (_type: unknown, options: { args: unknown[] }) => {
        seen.push(options.args[0]);
        return Promise.resolve({});
      },
    } as unknown as Partial<Client["workflow"]>);
  }

  it("carries the flow and the status map through to the workflow", async () => {
    const seen: unknown[] = [];
    const map = { onStart: "Devam Ediyor", onDone: "Tamam" };
    await capturingGateway(seen).signalWithStart({ ...INPUT, flow: "analiz", statusMap: map });

    expect(seen[0]).toEqual({ ...INPUT, flow: "analiz", statusMap: map });
  });

  /**
   * Absent, not null. The workflow reads an absent map as comment-only mode,
   * and an explicit null would mean the same thing while looking like a choice
   * somebody made — the same treatment `flow` already gets.
   */
  it("omits both fields rather than sending nulls", async () => {
    const seen: unknown[] = [];
    await capturingGateway(seen).signalWithStart({ ...INPUT, flow: null, statusMap: null });

    expect(seen[0]).toEqual({ ...INPUT });
    expect(Object.hasOwn(seen[0] as object, "statusMap")).toBe(false);
    expect(Object.hasOwn(seen[0] as object, "flow")).toBe(false);
  });

  /**
   * The analysis-only start (no application). The workflow reads an ABSENT
   * `appId` as ticket-text mode, so the key must be omitted — while the run
   * row's hook, whose store models the same fact as a nullable column, gets an
   * explicit `null` rather than a field that quietly vanished.
   */
  it("omits appId from the workflow input and passes null to the run-row hook", async () => {
    const seen: unknown[] = [];
    const opened: OpenedRun[] = [];
    const gateway = gatewayWith(
      {
        start: (_type: unknown, options: { args: unknown[] }) => {
          seen.push(options.args[0]);
          return Promise.resolve({});
        },
      } as unknown as Partial<Client["workflow"]>,
      async (run) => void opened.push(run),
    );

    const { appId: _dropped, ...noApp } = INPUT;
    await gateway.signalWithStart({ ...noApp, flow: "analiz" });

    expect(Object.hasOwn(seen[0] as object, "appId")).toBe(false);
    expect(opened[0]?.appId).toBeNull();
  });
});
