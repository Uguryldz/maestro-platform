import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isApprovalGate } from "../src/gates.js";
import { PASS_SCAN, Scenario, approval, createTestEnv, runTicket } from "./harness.js";

/**
 * The loops: rejection, blocked scan, red CI, changes requested on the PR.
 *
 * Every one of them is a return to an EARLIER step with the same agent session
 * (M30), and every one of them is bounded — three fruitless turns hand the
 * ticket to a human rather than spinning (M54).
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(async () => {
  await env?.teardown();
});

describe("an analysis gate rejection goes back to step 3", () => {
  it("rewrites the analysis, then asks for the approval again", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        gate: (step, visit) =>
          step === "5" && visit === 1 ? { kind: "reject_once", reason: "kapsam eksik" } : { kind: "approve" },
      }),
    );

    expect(run.status).toBe("done");
    const backToThree = run.scenario.journal.find((e) => e.detail.startsWith("ret: kapsam eksik"));
    expect(backToThree?.title).toBe("adım 3");
    // The gate was asked twice and answered twice — the second time, positively.
    expect(run.scenario.opened.filter((s) => s === "5")).toHaveLength(2);
    const gate5 = run.scenario.decisions.filter((d) => d.step === "5");
    expect(gate5.map((d) => d.decision)).toEqual(["reject", "approve"]);
  });
});

describe("a blocking scan sends the work back to 6a (M27/M54)", () => {
  it("retries three times and then hands the ticket to a human", async () => {
    const scenario = new Scenario({ risk: "dusuk" });
    const run = await runTicket(env, scenario, {
      // Fail-closed: `fail` is not "a finding to look at later", it is a stop.
      runScans: async () => [{ ...PASS_SCAN, outcome: "fail" }],
    });

    expect(run.status).toBe("handover");
    expect(scenario.handovers).toEqual(["3 tur ilerleme yok (M54)"]);
    expect(scenario.engineering).toHaveLength(3);
    expect(scenario.journal.filter((e) => e.title === "tarama bloke etti")).toHaveLength(3);
    // It never reached the PR: a blocked scan cannot be walked past.
    expect(scenario.journal.some((e) => e.detail.includes("PR #"))).toBe(false);
  });

  it("an error outcome blocks exactly like a failure does", async () => {
    const scenario = new Scenario({ risk: "dusuk" });
    const run = await runTicket(env, scenario, {
      runScans: async () => [{ ...PASS_SCAN, outcome: "error" }],
    });
    expect(run.status).toBe("handover");
  });
});

describe("the CI gate (M12/M106)", () => {
  it("rejects a signal from another repository and keeps waiting", async () => {
    const scenario = new Scenario({
      risk: "dusuk",
      ci: [{ adoRepo: "pay-mirror", buildId: 900 }, { status: "succeeded", buildId: 901 }],
    });
    const run = await runTicket(env, scenario);

    expect(run.status).toBe("done");
    const rejected = scenario.journal.find((e) => e.title === "yabancı CI sinyali reddedildi");
    expect(rejected?.detail).toBe("pay-mirror");
    // The foreign build did NOT merge anything: the run went on to accept a
    // second, matching signal before it moved.
    expect(scenario.journal.some((e) => e.title === "CI kırmızı")).toBe(false);
  });

  it("a red build is fixed inside the SAME agent session (M30)", async () => {
    const scenario = new Scenario({
      risk: "dusuk",
      ci: [{ status: "failed", buildId: 910 }, { status: "succeeded", buildId: 911 }],
    });
    const run = await runTicket(env, scenario);

    expect(run.status).toBe("done");
    expect(scenario.journal.some((e) => e.title === "CI kırmızı")).toBe(true);
    const fix = scenario.engineering.find((e) => e.task === "CI hatasını düzelt");
    expect(fix).toBeDefined();
    // Not a fresh session: the token from the first turn came back in.
    expect(fix?.resumeToken).toBe("session-1");
  });
});

describe("changes requested on the pull request (step 12b)", () => {
  it("continues the same session and comes back for the approval", async () => {
    const scenario = new Scenario({
      risk: "dusuk",
      gate: (step, visit) =>
        step === "12" && visit === 1 ? { kind: "reject_once", reason: "isimlendirme" } : { kind: "approve" },
    });
    const run = await runTicket(env, scenario);

    expect(run.status).toBe("done");
    expect(scenario.journal.some((e) => e.title === "adım 12b")).toBe(true);
    const fix = scenario.engineering.find((e) => e.task === "isimlendirme");
    expect(fix?.resumeToken).toBe("session-1");
    expect(scenario.opened.filter((s) => s === "12")).toHaveLength(2);
  });
});

describe("decisions are never dropped (Y1/Y2)", () => {
  /**
   * The approver answers as the gate is being opened — the normal case when the
   * decision comes from a Jira comment on a ticket somebody is already reading.
   * The decision must be waiting for the gate, not thrown away by it.
   */
  it("a decision that arrives BEFORE the gate opens still closes it (Y1)", async () => {
    const scenario = new Scenario({
      risk: "dusuk",
      // Nobody will answer once the gate is open: the only decision that exists
      // is the early one, so the run can finish only if it was kept.
      gate: () => ({ kind: "approve_after_hours", hours: 100_000 }),
      earlyDecision: (step) => (isApprovalGate(step) ? approval(step) : null),
    });
    const run = await runTicket(env, scenario);

    expect(run.status).toBe("done");
    // Kept, not re-asked: no reminder ladder ever had to run.
    expect(scenario.escalations).toEqual([]);
  });

  /**
   * `/approve` then `/reject` two seconds later, or a batch of webhooks. Both
   * land before the workflow wakes up. It must consume them one at a time and
   * keep moving — the run must never hang.
   */
  it("two decisions in one burst do not wedge the run (Y2)", async () => {
    const scenario = new Scenario({
      risk: "dusuk",
      gate: (step, visit) =>
        step === "5" && visit === 1
          ? {
              // A refusable decision FIRST, so the gate must go round its loop
              // and consume the second one from the same batch. With a single
              // slot the refusal's own reset erases the approval behind it and
              // the run waits for a decision that was already delivered.
              kind: "burst",
              decisions: [approval("5", { actorGroup: "product-owners" }), approval("5")],
            }
          : { kind: "approve" },
    });
    const run = await runTicket(env, scenario);

    // It closed at all — the defect parked the run forever, holding a signal it
    // never looked at — and it closed on the decision from the same batch,
    // without a single reminder having to coax a human into resending.
    expect(run.status).toBe("done");
    expect(scenario.journal.find((e) => e.title === "karar reddedildi")?.detail).toContain(
      "wrong_group",
    );
    expect(scenario.escalations.filter((e) => e.step === "5")).toEqual([]);
  });

  /**
   * ADO reports a finished build exactly once. A green result that lands while
   * engineering is still running must survive until the workflow looks.
   */
  it("a green build delivered during the fix is not lost (O1)", async () => {
    const scenario = new Scenario({
      risk: "dusuk",
      ci: [{ status: "failed", buildId: 920 }, { status: "succeeded", buildId: 921 }],
    });
    const run = await runTicket(env, scenario);
    expect(run.status).toBe("done");
  });
});

describe("the M54 gate counter survives the rejection loop (K4)", () => {
  it("three rejections at the same gate hand the ticket over", async () => {
    const scenario = new Scenario({
      risk: "dusuk",
      gate: (step) => (step === "5" ? { kind: "reject_always", reason: "yetersiz" } : { kind: "approve" }),
    });
    const run = await runTicket(env, scenario);

    expect(run.status).toBe("handover");
    expect(scenario.handovers.some((h) => h.includes("M54"))).toBe(true);
    // Three strikes, not an unbounded spin: the gate opened exactly three times.
    expect(scenario.opened.filter((s) => s === "5")).toHaveLength(3);
  });

  /**
   * M30: the rejection loop re-enters the workflow, and the agent session must
   * come through it. A re-entry that reset the token would start a fresh
   * session on the second rejection and lose everything the agent had learned.
   */
  /**
   * The rejection happens at gate 12, AFTER engineering has already opened a
   * session — so the continuation must carry the token. Re-entering with the
   * original input instead resets it to `null` and the next turn silently
   * starts a brand-new session, losing everything the agent had learned.
   */
  it("the resume token survives re-entry (M30)", async () => {
    const scenario = new Scenario({
      risk: "dusuk",
      gate: (step, visit) =>
        step === "12" && visit === 1 ? { kind: "reject_once", reason: "isimlendirme" } : { kind: "approve" },
    });
    const run = await runTicket(env, scenario);

    expect(run.status).toBe("done");
    // Exactly one turn opened a session; every later turn resumed it. Two fresh
    // starts would mean the continuation dropped the token.
    const fresh = scenario.engineering.filter((e) => e.resumeToken === null);
    expect(fresh).toHaveLength(1);
    // And the turn AFTER the re-entry is a resumed one, not a restart.
    expect(scenario.engineering.at(-1)?.resumeToken).toBe("session-1");
  });
});

describe("the engineering loop is bounded on every failure mode (M52/M54)", () => {
  it("a protected-path violation hands over on the FIRST turn", async () => {
    const scenario = new Scenario({ risk: "dusuk" });
    const run = await runTicket(env, scenario, {
      runEngineering: async (_ticket, resumeToken, task) => {
        scenario.engineering.push({ resumeToken, task });
        return {
          ok: false,
          resumeToken: resumeToken ?? "session-1",
          changedFiles: 1,
          diffSummary: "+1 -0",
          handoverReason: "korumalı yol ihlali (M52): db/migrations/001.sql",
        };
      },
    });

    expect(run.status).toBe("handover");
    expect(scenario.engineering).toHaveLength(1);
    expect(scenario.handovers[0]).toContain("M52");
  });

  it("a reviewer that never approves stops after three turns", async () => {
    const scenario = new Scenario({ risk: "dusuk" });
    const run = await runTicket(env, scenario, {
      reviewDiff: async () => ({ approved: false, findings: ["adlandırma", "test yok"] }),
    });

    expect(run.status).toBe("handover");
    expect(scenario.engineering).toHaveLength(3);
    // The findings were carried into the next turn rather than thrown away.
    expect(scenario.engineering[1]?.task).toBe("adlandırma\ntest yok");
  });
});
