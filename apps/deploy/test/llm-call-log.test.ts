import type { LlmCallLog } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { llmCallRecorder, type LlmCallRow } from "../src/stores/llm-call-log.js";

/**
 * The spend recorder.
 *
 * Written because `LlmCall` rows had only ever been produced by the pilot
 * launcher: the Temporal path called models all day and `/studio/cost`
 * answered 200 with an empty table. What is pinned here is the part a screen
 * cannot show — that a reporting failure never reaches the caller, and that
 * the nullable columns stay nullable rather than being coerced to 0.
 */

const LOG: LlmCallLog = {
  at: "2026-01-01T10:00:00.000Z",
  runId: "run-1",
  role: "analyst",
  variantId: "v1",
  driver: "openai-compat",
  model: "gpt-4o-mini",
  tokensIn: 1200,
  tokensOut: 300,
  cachePct: 40,
  usd: 0.0123,
  dataClass: "gizli",
};

/** Waits out the recorder's fire-and-forget promise. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("llmCallRecorder", () => {
  it("writes the call as a row", async () => {
    const written: LlmCallRow[] = [];
    llmCallRecorder({ create: (args) => { written.push(args.data); return Promise.resolve(undefined); } })(LOG);
    await settle();

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      runId: "run-1",
      role: "analyst",
      model: "gpt-4o-mini",
      tokensIn: 1200,
      tokensOut: 300,
      dataClass: "gizli",
    });
    // The contract carries an ISO string; the column is a timestamp.
    expect(written[0]?.at).toBeInstanceOf(Date);
  });

  it("keeps null spend and null cache ratio rather than coercing them to zero", async () => {
    // Subscription drivers bill a seat, not a call (M55). Writing 0 here would
    // make a seat-billed month look free in the cost report.
    const written: LlmCallRow[] = [];
    llmCallRecorder({ create: (args) => { written.push(args.data); return Promise.resolve(undefined); } })({
      ...LOG,
      usd: null,
      cachePct: null,
      runId: null,
    });
    await settle();

    expect(written[0]?.usd).toBeNull();
    expect(written[0]?.cachePct).toBeNull();
    expect(written[0]?.runId).toBeNull();
  });

  it("never lets a reporting failure reach the model call", async () => {
    // The hook runs on the call path. Awaiting — or throwing — would put the
    // cost ledger between an agent and its answer.
    const errors: string[] = [];
    const record = llmCallRecorder(
      { create: () => Promise.reject(new Error("db down")) },
      (message) => errors.push(message),
    );

    expect(() => record(LOG)).not.toThrow();
    await settle();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("db down");
  });
});
