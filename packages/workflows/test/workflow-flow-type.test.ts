import { fileURLToPath } from "node:url";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scenario, createTestEnv, runTicket, type RunResult } from "./harness.js";

/**
 * What the listening rule's flow type actually CHANGES about a run.
 *
 * Until `planFor` was wired in, the flow type was a label: the rule recorded
 * it, and every ticket ran the full pipeline regardless. That failed live on
 * OPS-38 — an `analiz` ticket, on a deployment deliberately configured without
 * a code agent, sailed through both analysis gates and then died inside
 * `runEngineering` with `mcpServers were requested but no --mcp-config path
 * was given`. The analysis was finished and approved; the run failed anyway.
 *
 * These tests pin the three flows to the phases they are supposed to run.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(async () => {
  await env?.teardown();
});

describe("flow: analiz — the analysis IS the deliverable", () => {
  it("passes the analysis gates, delivers, and closes without writing code", async () => {
    const run = await runTicket(
      env,
      new Scenario({ flow: "analiz", risk: "dusuk", gate: () => ({ kind: "approve" }) }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.delivered).toBe(true);
    // The gate it DID open is an analysis one — at `dusuk` the tier's set is
    // step 5 alone (`GATES_BY_RISK`) — and no engineering step ran.
    expect(run.scenario.opened).toEqual(["5"]);
    expect(run.scenario.journal.some((e) => e.title.startsWith("adım 6"))).toBe(false);
    expect(run.scenario.journal.at(-1)?.title).toBe("analiz teslim edildi");
  });

  it("still honours a rejection — it is analysis-only, not approval-free", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        flow: "analiz",
        risk: "dusuk",
        gate: (_step, visit) =>
          visit === 1 ? { kind: "reject_once", reason: "kapsam eksik" } : { kind: "approve" },
      }),
    );

    expect(run.status).toBe("done");
    // Rewritten once before the approval — the loop is untouched by the flow.
    expect(run.scenario.journal.filter((e) => e.title === "adım 3").length).toBeGreaterThan(1);
  });
});

/**
 * Replay the finished run's own history against the CURRENT workflow code.
 *
 * This is the mechanical half of the widening's replay-safety claim: every
 * in-flight run carries an appId, so the appId-present path must regenerate
 * exactly the commands its history recorded. `runReplayHistory` throws on any
 * nondeterminism, which turns "the new branch is unreachable with an appId"
 * from a code-review argument into an assertion.
 */
async function replays(run: RunResult): Promise<void> {
  const history = await run.scenario.handle!.fetchHistory();
  await Worker.runReplayHistory(
    { workflowsPath: fileURLToPath(new URL("../src/ticket-workflow.ts", import.meta.url)) },
    history,
  );
}

describe("flow: analiz with NO application — the analysis-only binding", () => {
  it("skips discovery with a journaled reason and still delivers and closes", async () => {
    const run = await runTicket(
      env,
      new Scenario({ flow: "analiz", risk: "dusuk", appId: null, gate: () => ({ kind: "approve" }) }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.delivered).toBe(true);
    // No discovery was ever SCHEDULED — there is no repository to discover.
    expect(run.scenario.discoveries).toEqual([]);
    // And the run says WHY in its own journal, in so many words.
    expect(
      run.scenario.journal.some(
        (e) =>
          e.title === "keşif atlandı" &&
          e.detail === "kod deposu bağlı değil — keşif atlandı, analiz ticket metninden üretilecek",
      ),
    ).toBe(true);
    expect(run.scenario.journal.at(-1)?.title).toBe("analiz teslim edildi");
  });

  it("regression: an analiz run WITH an application discovers exactly as before", async () => {
    const run = await runTicket(
      env,
      new Scenario({ flow: "analiz", risk: "dusuk", gate: () => ({ kind: "approve" }) }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.discoveries).toEqual(["pay"]);
    expect(run.scenario.journal.some((e) => e.title === "keşif atlandı")).toBe(false);
    // The history this run recorded replays against the widened code — the
    // appId-present path produced the commands it always produced.
    await replays(run);
  });

  /**
   * The assertion behind "the engineering path is unreachable without an
   * application". Intake refuses to start a code-writing flow with no appId,
   * so the only way to arrive here is a bug upstream — and the workflow's
   * answer must be a fail-closed handover, never an engineering loop opening
   * a session against a repository that does not exist.
   */
  it("hands over — fail closed — if a code-writing flow somehow starts without one", async () => {
    const run = await runTicket(
      env,
      new Scenario({ flow: "gelistirme", risk: "dusuk", appId: null, gate: () => ({ kind: "approve" }) }),
    );

    expect(run.status).toBe("handover");
    expect(run.scenario.handovers).toEqual([
      "uygulama bağlı değil — mühendislik adımları uygulamasız çalıştırılamaz",
    ]);
    // The guard sits AFTER the analysis half (which needs no repo) and BEFORE
    // the first engineering step.
    expect(run.scenario.journal.some((e) => e.title === "adım 3")).toBe(true);
    expect(run.scenario.journal.some((e) => e.title.startsWith("adım 6"))).toBe(false);
  });
});

describe("flow: gelistirme and an absent rule — the full pipeline", () => {
  it("runs engineering for gelistirme, and its history replays against the widened code", async () => {
    const run = await runTicket(
      env,
      new Scenario({ flow: "gelistirme", risk: "dusuk", gate: () => ({ kind: "approve" }) }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.journal.some((e) => e.title.startsWith("adım 6"))).toBe(true);
    expect(run.scenario.delivered).toBe(false);
    // A full-pipeline history — the shape every in-flight production run has —
    // recorded with an appId must replay unchanged, including through the new
    // (command-free) engineering guard.
    await replays(run);
  });

  /**
   * The safe default, and the direction it is safe in: a ticket that matched
   * no rule is never silently under-processed. A run that does too much stops
   * at a human gate; a run that does too little just quietly ends.
   */
  it("runs the full pipeline when no rule named a flow", async () => {
    const run = await runTicket(
      env,
      new Scenario({ risk: "dusuk", gate: () => ({ kind: "approve" }) }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.journal.some((e) => e.title.startsWith("adım 6"))).toBe(true);
  });
});
