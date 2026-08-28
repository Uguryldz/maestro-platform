import { describe, expect, it } from "vitest";
import { InMemoryEvalStore } from "../src/stores/variant-memory.js";
import type { EvalRunRecord, GoldenTicket, StudioReadModels } from "../src/read-studio.js";
import { auth } from "./helpers.js";
import { adminToken, memberToken, studioHarness } from "./studio-fixtures.js";

/**
 * Golden-ticket evaluation and the M78 justified-pass gate.
 *
 * The property under test throughout is the one M78 names: a candidate that
 * REGRESSED against its baseline may only be shipped WITH a written
 * justification. A silent pass is refused — the whole point of the gate is that
 * shipping a regression is a decision on the record, not one the platform makes
 * by rendering a green page. And when no eval store is wired the route refuses
 * by name rather than answer an empty pool.
 */

const POOL: readonly GoldenTicket[] = [
  { goldenId: "g1", sourceTicket: "UGURPAY-1", kind: "analiz", expectation: "x", lastScore: 90 },
  { goldenId: "g2", sourceTicket: "UGURPAY-2", kind: "analiz", expectation: "y", lastScore: 80 },
];

/** A run that REGRESSED: g2 dropped from 85 to 79. */
const REGRESSED_RUN: EvalRunRecord = {
  runId: "run-1",
  variantId: "analyst-web",
  baselineVersion: 1,
  candidateVersion: 2,
  at: "2026-07-20T09:00:00.000Z",
  results: [
    { goldenId: "g1", baselineScore: 90, candidateScore: 92 },
    { goldenId: "g2", baselineScore: 85, candidateScore: 79 },
  ],
  decision: { status: "pending", justification: "", decidedBy: null, decidedAt: null },
};

/** A run with no regression — every candidate score met or beat the baseline. */
const CLEAN_RUN: EvalRunRecord = {
  ...REGRESSED_RUN,
  runId: "run-clean",
  results: [
    { goldenId: "g1", baselineScore: 90, candidateScore: 92 },
    { goldenId: "g2", baselineScore: 85, candidateScore: 88 },
  ],
};

async function withEval(
  runs: readonly EvalRunRecord[],
): Promise<Awaited<ReturnType<typeof studioHarness>> & { store: InMemoryEvalStore }> {
  const store = new InMemoryEvalStore({ pool: POOL, runs });
  const studio: StudioReadModels = { eval: store };
  const h = await studioHarness({ deps: { studio } });
  return Object.assign(h, { store });
}

describe("GET /eval", () => {
  it("refuses an unauthenticated caller", async () => {
    const h = await withEval([REGRESSED_RUN]);
    expect((await h.app.inject({ method: "GET", url: "/eval" })).statusCode).toBe(401);
  });

  it("returns the pool and the last run to any session", async () => {
    const h = await withEval([REGRESSED_RUN]);
    const token = await memberToken(h);
    const response = await h.app.inject({ method: "GET", url: "/eval", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      goldenTickets: unknown[];
      lastRun: { runId: string; results: unknown[] };
    };
    expect(body.goldenTickets).toHaveLength(2);
    expect(body.lastRun.runId).toBe("run-1");
    expect(body.lastRun.results).toHaveLength(2);
  });

  it("REFUSES with a named capability when no eval store is wired — never an empty pool", async () => {
    const h = await studioHarness({ deps: { studio: {} } });
    const token = await adminToken(h);
    const response = await h.app.inject({ method: "GET", url: "/eval", headers: auth(token) });

    expect(response.statusCode).toBe(503);
    const body = response.json() as { error: string; details: { capability: string } };
    expect(body.error).toBe("capability_not_wired");
    expect(body.details.capability).toBe("eval");
    expect(response.body).not.toContain('"goldenTickets":[]');
  });
});

describe("POST /eval/decisions (M78 justified pass)", () => {
  it("refuses a member — deciding is admin-only", async () => {
    const h = await withEval([REGRESSED_RUN]);
    const token = await memberToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/eval/decisions",
      headers: auth(token),
      payload: { runId: "run-1", status: "shipped", justification: "gerekçe" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("REFUSES to ship a regression with no justification", async () => {
    const h = await withEval([REGRESSED_RUN]);
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/eval/decisions",
      headers: auth(token),
      payload: { runId: "run-1", status: "shipped", justification: "" },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: string; details: { regressions: string[] } };
    expect(body.error).toBe("eval_regression_needs_justification");
    // The refusal names WHICH golden ticket regressed.
    expect(body.details.regressions).toContain("g2");
    // Nothing was recorded: the run is still pending.
    const run = await h.store.run("run-1");
    expect(run?.decision.status).toBe("pending");
  });

  it("ships a regression WITH a justification, and records it on the trail", async () => {
    const h = await withEval([REGRESSED_RUN]);
    const token = await adminToken(h, "yonetici");
    const response = await h.app.inject({
      method: "POST",
      url: "/eval/decisions",
      headers: auth(token),
      payload: { runId: "run-1", status: "shipped", justification: "g2 bu üründe kritik değil" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { decision: { status: string; justification: string } };
    expect(body.decision.status).toBe("shipped");
    expect(body.decision.justification).toBe("g2 bu üründe kritik değil");

    // The justification is on the audit trail — that is where an auditor reads
    // "who shipped a regression, and why".
    const events = await h.auditStore.read();
    const decided = events.find((event) => event.subject === "eval:run-1");
    expect(decided?.meta["justification"]).toBe("g2 bu üründe kritik değil");
    expect(decided?.meta["regressed"]).toBe(true);
  });

  it("ships a CLEAN run with no justification required", async () => {
    const h = await withEval([CLEAN_RUN]);
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/eval/decisions",
      headers: auth(token),
      payload: { runId: "run-clean", status: "shipped", justification: "" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { decision: { status: string; justification: string } };
    expect(body.decision.status).toBe("shipped");
    // A clean pass records no defence it never needed.
    expect(body.decision.justification).toBe("");
  });

  it("blocks a regression with no justification required", async () => {
    const h = await withEval([REGRESSED_RUN]);
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/eval/decisions",
      headers: auth(token),
      payload: { runId: "run-1", status: "blocked", justification: "" },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { decision: { status: string } }).decision.status).toBe("blocked");
  });

  it("checks the regression against the STORED scores, not the client's claim", async () => {
    // The client cannot say "no regression, ship it" over a run that did
    // regress: the fact comes from the recorded scores, re-read server-side.
    const h = await withEval([REGRESSED_RUN]);
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/eval/decisions",
      headers: auth(token),
      // No justification, and no way to lie the regression away.
      payload: { runId: "run-1", status: "shipped" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("404s an unknown run", async () => {
    const h = await withEval([REGRESSED_RUN]);
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/eval/decisions",
      headers: auth(token),
      payload: { runId: "yok", status: "blocked", justification: "" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses the decision while the kill switch is on (M58)", async () => {
    const h = await withEval([REGRESSED_RUN]);
    const token = await adminToken(h);
    await h.killSwitch.set({
      level: "all",
      actor: "yonetici@ugurbank.local",
      reason: "olay",
      at: "2026-08-09T10:00:00.000Z",
    });
    const response = await h.app.inject({
      method: "POST",
      url: "/eval/decisions",
      headers: auth(token),
      payload: { runId: "run-1", status: "blocked", justification: "" },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe("kill_switch");
  });
});
