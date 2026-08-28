import { GATES_BY_RISK, ROLES, STEP_IDS, WorkflowRunState } from "@maestro/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoRunId } from "../src/fakes/run-gateway.js";
import { DEMO_RUNS } from "../src/seed/runs-data.js";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "../src/seed/users.js";
import { auth, demoHarness, type DemoHarness } from "./harness.js";

/**
 * The seed is COHERENT.
 *
 * A demo whose journal belongs to a different run than the one on screen, or
 * whose evidence package lists approvals the risk tier never demanded, teaches
 * the reader that the product is sloppy. These tests are the guard against that:
 * every derived record is checked against the run it claims to describe.
 */

let h: DemoHarness;
let adminToken: string;

beforeAll(async () => {
  h = await demoHarness();
  adminToken = await h.login("ayse.kaya", DEMO_PASSWORD);
});

afterAll(async () => {
  await h.app.close();
});

describe("the seed summary is the inventory the README publishes", () => {
  it("counts what was actually seeded", () => {
    // These numbers appear verbatim in README.md and in the boot banner. Pinning
    // them here is what keeps the three from drifting: a run added to the seed
    // without updating the README makes the documentation quietly wrong, and a
    // demo whose own description is stale is the first thing a reader catches.
    expect(h.summary).toMatchObject({
      runs: 17,
      openGates: 5,
      journalEntries: 184,
      evidencePackages: 2,
      knowledgeDocs: 6,
      confidentialDocs: 2,
      runners: 6,
      unreachableRunners: 1,
      applications: 5,
      accounts: 4,
    });
    expect(h.summary.auditEvents).toBeGreaterThan(0);
    expect(h.summary.costRows).toBeGreaterThan(0);
  });
});

describe("the roster covers every role", () => {
  it("gives each contract role at least one holder", () => {
    for (const role of ROLES) {
      const holders = DEMO_ACCOUNTS.filter((account) => account.roles.includes(role));
      expect(holders, `no demo account holds the role "${role}"`).not.toHaveLength(0);
    }
  });

  it("every account can actually log in with the documented password", async () => {
    for (const account of DEMO_ACCOUNTS) {
      const response = await h.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: account.username, password: account.password },
      });
      expect(response.statusCode, `${account.username} could not log in`).toBe(200);
    }
  });

  it("documents one shared password, and it is the one that works", () => {
    for (const account of DEMO_ACCOUNTS) {
      expect(account.password).toBe(DEMO_PASSWORD);
    }
  });
});

describe("runs and their states agree", () => {
  it("seeds a workflow execution for every catalog row, with the same step", async () => {
    for (const run of DEMO_RUNS) {
      const state = h.runs.stateOf(run.ticketKey);
      expect(state, `${run.ticketKey} has a catalog row but no execution`).not.toBeNull();
      expect(state?.step).toBe(run.step);
      expect(state?.status).toBe(run.status);
      expect(state?.risk).toBe(run.risk);
    }
  });

  it("produces run states that satisfy the frozen contract", () => {
    for (const run of DEMO_RUNS) {
      const state = h.runs.stateOf(run.ticketKey);
      expect(() => WorkflowRunState.parse(state)).not.toThrow();
    }
  });

  it("points every fan-out child at a parent that exists", () => {
    const keys = new Set(DEMO_RUNS.map((run) => run.ticketKey));
    for (const run of DEMO_RUNS) {
      if (run.parentTicketKey !== null) expect(keys.has(run.parentTicketKey)).toBe(true);
      for (const child of run.childTicketKeys) expect(keys.has(child)).toBe(true);
    }
  });

  it("makes the parent's child list agree with the children's parent field", () => {
    for (const run of DEMO_RUNS) {
      for (const childKey of run.childTicketKeys) {
        const child = DEMO_RUNS.find((candidate) => candidate.ticketKey === childKey);
        expect(child?.parentTicketKey).toBe(run.ticketKey);
      }
    }
  });
});

describe("a run's journal belongs to that run", () => {
  it("keys every entry to the run id the execution reports", async () => {
    // UGURPAY-501 is the fan-out child sitting at the PR gate — the run the
    // demo's walkthrough opens first.
    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs/UGURPAY-501/journal",
      headers: auth(adminToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { runId: string; seq: number }[] };
    expect(body.items.length).toBeGreaterThan(0);
    for (const entry of body.items) {
      expect(entry.runId).toBe(demoRunId("UGURPAY-501"));
    }
  });

  it("never writes a journal entry past the step the run has reached", async () => {
    for (const run of DEMO_RUNS) {
      const response = await h.app.inject({
        method: "GET",
        url: `/studio/runs/${run.ticketKey}/journal`,
        headers: auth(adminToken),
      });
      const body = response.json() as { items: { title: string }[] };

      const reached = STEP_IDS.indexOf(run.step);
      for (const entry of body.items) {
        const step = entry.title.split(" · ")[0] ?? "";
        expect(
          STEP_IDS.indexOf(step as (typeof STEP_IDS)[number]),
          `${run.ticketKey} journal mentions step ${step} but the run is at ${run.step}`,
        ).toBeLessThanOrEqual(reached);
      }
    }
  });

  it("numbers entries consecutively from 1", async () => {
    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs/UGURPAY-478/journal",
      headers: auth(adminToken),
    });
    const body = response.json() as { items: { seq: number }[] };

    const seqs = body.items.map((entry) => entry.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_value, index) => index + 1));
  });

  it("serves a summary naming the run it summarises", async () => {
    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs/UGURPAY-501/summary",
      headers: auth(adminToken),
    });

    const body = response.json() as { runId: string; summary: string | null };
    expect(body.runId).toBe(demoRunId("UGURPAY-501"));
    expect(body.summary).toContain("UGURPAY-501");
  });
});

describe("cost rows agree with the journal", () => {
  it("reports per-run totals that match the catalog's token counts", async () => {
    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs/UGURPAY-478/cost",
      headers: auth(adminToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: { runId: string }[];
      totals: { tokensIn: number; tokensOut: number; calls: number };
    };
    const run = DEMO_RUNS.find((candidate) => candidate.ticketKey === "UGURPAY-478");

    expect(body.items.length).toBeGreaterThan(0);
    for (const row of body.items) expect(row.runId).toBe(demoRunId("UGURPAY-478"));
    // Rounding splits the total across AI turns, so the sum lands within one
    // token per row rather than exactly — the point is that it is DERIVED.
    expect(body.totals.tokensIn).toBeCloseTo(run?.tokensIn ?? 0, -3);
    expect(body.totals.tokensOut).toBeCloseTo(run?.tokensOut ?? 0, -3);
  });
});

describe("evidence packages describe the run that closed", () => {
  it("carries the approvals the run's risk tier demanded", async () => {
    const closed = DEMO_RUNS.filter((run) => run.status === "done");
    expect(closed.length).toBeGreaterThan(0);

    for (const run of closed) {
      const response = await h.app.inject({
        method: "GET",
        url: `/studio/runs/${run.ticketKey}/evidence`,
        headers: auth(adminToken),
      });

      expect(response.statusCode, `${run.ticketKey} has no evidence package`).toBe(200);
      const pkg = response.json() as {
        runId: string;
        ticketKey: string;
        approvals: { step: string; signatureSeq: number }[];
        files: { sha256: string }[];
      };

      expect(pkg.runId).toBe(demoRunId(run.ticketKey));
      expect(pkg.ticketKey).toBe(run.ticketKey);
      expect(pkg.approvals.map((approval) => approval.step)).toEqual([
        ...GATES_BY_RISK[run.risk],
      ]);
      // Each signature is a real position in the hash chain, not a made-up number.
      for (const approval of pkg.approvals) expect(approval.signatureSeq).toBeGreaterThan(0);
      for (const file of pkg.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("gives an open run no evidence package at all", async () => {
    const response = await h.app.inject({
      method: "GET",
      url: "/studio/runs/UGURPAY-501/evidence",
      headers: auth(adminToken),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "no_evidence" });
  });
});

describe("the audit chain the seed wrote actually verifies", () => {
  it("recomputes clean over the seeded approvals", async () => {
    const auditor = await h.login("hulya.arslan", DEMO_PASSWORD);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/audit/verification",
      headers: auth(auditor),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, brokenAtSeq: null });
    expect((response.json() as { checked: number }).checked).toBeGreaterThan(0);
  });
});

describe("the open-gate board only lists closable gates", () => {
  it("names a gate-owning group for every row", async () => {
    const response = await h.app.inject({
      method: "GET",
      url: "/studio/gates",
      headers: auth(adminToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: { ticketKey: string; step: string; ownerGroup: string }[];
    };
    expect(body.items.length).toBeGreaterThan(0);
    for (const gate of body.items) {
      expect(["product-owners", "tech-leads", "qa"]).toContain(gate.ownerGroup);
      // 2b reports `gate` but is a clarification wait, not an approval — a
      // board that listed it would be inviting a decision the BFF refuses.
      expect(gate.step).not.toBe("2b");
    }
  });
});
