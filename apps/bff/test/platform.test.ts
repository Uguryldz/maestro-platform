import { describe, expect, it } from "vitest";
import { PARAM_DEFINITIONS } from "./helpers.js";
import {
  GATE,
  JOURNAL_AI,
  JOURNAL_HUMAN,
  OTHER_RUN,
  PUBLIC_DOC,
  RUNNER,
  RUN_ID,
  SECRET_DOC,
  TICKET,
  studioHarness,
} from "./studio-fixtures.js";

/**
 * The BFF's `MaestroPlatform` (M101). maestro-mcp injects this, so these tests
 * are the contract: an AI holding a borrowed token gets exactly what the person
 * holding it would get, and nothing on this interface can close a gate.
 */

const MEMBER = "uye.kisi";
const MEMBER_ACTOR = "uye.kisi@ugurbank.local";
/** The same person's token in an AI's hands (M101). */
const DELEGATED_ACTOR = `ai-via:${MEMBER_ACTOR}`;
const ADMIN_ACTOR = "yonetici@ugurbank.local";

async function platformHarness(): ReturnType<typeof studioHarness> {
  const h = await studioHarness({ groups: { "tech-leads": [MEMBER] } });
  await h.addUser({ username: MEMBER, groups: ["maestro-ugurpay"] });
  await h.addUser({ username: "yonetici", roles: ["admin"], groups: [] });
  return h;
}

describe("actor resolution", () => {
  it("refuses an actor the audit trail could not classify", async () => {
    const h = await platformHarness();
    await expect(
      h.platform.listRuns("not an actor", { status: undefined, ticketKey: undefined, appId: undefined, limit: 10 }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a system actor, which carries no RBAC to apply", async () => {
    const h = await platformHarness();
    await expect(
      h.platform.listRuns("maestro-worker", { status: undefined, ticketKey: undefined, appId: undefined, limit: 10 }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a deactivated account's delegated token", async () => {
    const h = await platformHarness();
    await h.users.remove(MEMBER);

    await expect(
      h.platform.listRuns(DELEGATED_ACTOR, { status: undefined, ticketKey: undefined, appId: undefined, limit: 10 }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("listRuns", () => {
  it("scopes to the acting user's projects", async () => {
    const h = await platformHarness();
    h.read.runs.put(OTHER_RUN);

    const runs = await h.platform.listRuns(MEMBER_ACTOR, {
      status: undefined,
      ticketKey: undefined,
      appId: undefined,
      limit: 50,
    });

    expect(runs.map((run) => run.ticketKey)).toEqual([TICKET]);
  });

  /** M101: an AI gets what the human would get — no wider, and nothing extra. */
  it("gives a delegated token exactly the human's scope", async () => {
    const h = await platformHarness();
    h.read.runs.put(OTHER_RUN);

    const asHuman = await h.platform.listRuns(MEMBER_ACTOR, {
      status: undefined, ticketKey: undefined, appId: undefined, limit: 50,
    });
    const asAi = await h.platform.listRuns(DELEGATED_ACTOR, {
      status: undefined, ticketKey: undefined, appId: undefined, limit: 50,
    });

    expect(asAi.map((r) => r.ticketKey)).toEqual(asHuman.map((r) => r.ticketKey));
  });

  it("filters by status", async () => {
    const h = await platformHarness();

    const gated = await h.platform.listRuns(MEMBER_ACTOR, {
      status: "gate", ticketKey: undefined, appId: undefined, limit: 50,
    });
    const running = await h.platform.listRuns(MEMBER_ACTOR, {
      status: "running", ticketKey: undefined, appId: undefined, limit: 50,
    });

    expect(gated).toHaveLength(1);
    expect(running).toHaveLength(0);
  });

  it("clamps a limit above the ceiling instead of honouring it", async () => {
    const h = await platformHarness();
    for (let index = 0; index < 5; index += 1) {
      h.read.runs.put({ ...OTHER_RUN, ticketKey: `UGURPAY-70${index}` });
    }

    const runs = await h.platform.listRuns(ADMIN_ACTOR, {
      status: undefined, ticketKey: undefined, appId: undefined, limit: 10_000,
    });

    expect(runs.length).toBeLessThanOrEqual(200);
  });
});

describe("getRun", () => {
  it("refuses a run in a project the caller cannot see", async () => {
    const h = await platformHarness();
    await expect(h.platform.getRun(MEMBER_ACTOR, "run-UGURWEB-104")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("reports the open gate and how long it has waited", async () => {
    const h = await platformHarness();
    h.read.gates.open(GATE);

    const detail = await h.platform.getRun(MEMBER_ACTOR, RUN_ID);

    expect(detail.appId).toBe("ugurpay");
    expect(detail.mode).toBe("full_auto");
    expect(detail.state.status).toBe("gate");
    expect(detail.pendingGate).toMatchObject({ step: "5", ownerGroup: "tech-leads", waitingDays: 4 });
  });

  it("reports no pending gate when none is open", async () => {
    const h = await platformHarness();
    const detail = await h.platform.getRun(MEMBER_ACTOR, RUN_ID);
    expect(detail.pendingGate).toBeNull();
  });
});

describe("getJournal", () => {
  it("returns entries from the requested sequence", async () => {
    const h = await platformHarness();
    h.read.journal.append(JOURNAL_AI);
    h.read.journal.append(JOURNAL_HUMAN);

    const entries = await h.platform.getJournal(MEMBER_ACTOR, RUN_ID, { fromSeq: 2, limit: 10 });

    expect(entries.map((entry) => entry.seq)).toEqual([2]);
  });

  it("refuses a stranger's journal", async () => {
    const h = await platformHarness();
    await expect(
      h.platform.getJournal(MEMBER_ACTOR, "run-UGURWEB-104", { fromSeq: 0, limit: 10 }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("getParams", () => {
  it("refuses a caller without the admin surface role", async () => {
    const h = await platformHarness();
    await expect(
      h.platform.getParams(MEMBER_ACTOR, { scope: undefined, scopeRef: undefined }),
    ).rejects.toMatchObject({ status: 403 });
  });

  /** A key that was never changed still governs the flow; `null` would read as unset. */
  it("reports the definition's default when nothing was ever set", async () => {
    const h = await platformHarness();

    const params = await h.platform.getParams(ADMIN_ACTOR, { scope: undefined, scopeRef: undefined });

    const reminder = params.find((param) => param.key === "reminder.channel");
    expect(reminder).toMatchObject({ value: "teams", version: 0, guarded: false });
    expect(params.find((param) => param.key === "gate.set")?.guarded).toBe(true);
    expect(params).toHaveLength(PARAM_DEFINITIONS.length);
  });

  it("reports the applied value and its version once one is set", async () => {
    const h = await platformHarness();
    await h.params.apply({
      key: "reminder.channel",
      scopeRef: null,
      value: "smtp",
      version: 1,
      changedBy: ADMIN_ACTOR,
      approvedBy: null,
      at: "2026-08-09T09:00:00.000Z",
    });

    const params = await h.platform.getParams(ADMIN_ACTOR, { scope: undefined, scopeRef: undefined });

    expect(params.find((param) => param.key === "reminder.channel")).toMatchObject({
      value: "smtp",
      version: 1,
    });
  });
});

describe("searchKnowledge", () => {
  it("drops a gizli hit rather than masking it", async () => {
    const h = await platformHarness();
    h.read.knowledge.put(PUBLIC_DOC);
    h.read.knowledge.put(SECRET_DOC);

    const hits = await h.platform.searchKnowledge(MEMBER_ACTOR, {
      text: "analiz",
      appId: undefined,
      limit: 10,
    });

    // A redacted snippet would still disclose that the document exists.
    expect(hits.map((hit) => hit.id)).toEqual(["kb-1"]);
    expect(hits[0]?.dataClass).toBe("dahili");
  });
});

describe("listPendingGates", () => {
  it("lists the gate with its waiting time", async () => {
    const h = await platformHarness();
    h.read.gates.open(GATE);

    const gates = await h.platform.listPendingGates(MEMBER_ACTOR, {
      ownerGroup: undefined,
      olderThanDays: undefined,
      limit: 50,
    });

    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ ticketKey: TICKET, step: "5", waitingDays: 4 });
  });

  it("honours olderThanDays", async () => {
    const h = await platformHarness();
    h.read.gates.open(GATE);

    const gates = await h.platform.listPendingGates(MEMBER_ACTOR, {
      ownerGroup: undefined,
      olderThanDays: 30,
      limit: 50,
    });

    expect(gates).toHaveLength(0);
  });

  it("does not show a stranger's gates", async () => {
    const h = await platformHarness();
    h.read.gates.open({ ...GATE, ticketKey: "UGURWEB-104" });

    const gates = await h.platform.listPendingGates(MEMBER_ACTOR, {
      ownerGroup: undefined, olderThanDays: undefined, limit: 50,
    });

    expect(gates).toHaveLength(0);
  });
});

describe("quotaStatus and runnerHealth", () => {
  it("refuse a caller without the operator role", async () => {
    const h = await platformHarness();
    await expect(
      h.platform.quotaStatus(MEMBER_ACTOR, { scope: undefined, scopeRef: undefined }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(h.platform.runnerHealth(MEMBER_ACTOR)).rejects.toMatchObject({ status: 403 });
  });

  it("report the pool and the fleet to an admin", async () => {
    const h = await platformHarness();
    h.read.runners.put(RUNNER);

    const quota = await h.platform.quotaStatus(ADMIN_ACTOR, { scope: undefined, scopeRef: undefined });
    const fleet = await h.platform.runnerHealth(ADMIN_ACTOR);

    expect(quota).toHaveLength(2);
    expect(quota.find((row) => row.scopeRef === "claude-sub-03")).toMatchObject({
      usedTokens: 100,
      limitTokens: 100,
      throttled: true,
    });
    expect(fleet[0]).toMatchObject({ runnerId: "lnx-01", state: "busy", activeSandboxes: 2 });
  });
});

/**
 * M32/M101. The guarantee is structural — there is no method to test for
 * absence of, so the test asserts the shape of the interface itself.
 */
describe("the gate decision is unreachable", () => {
  it("exposes no method that closes a gate, sets a verdict or merges a PR", async () => {
    const h = await platformHarness();
    const names = Object.keys(h.platform);

    for (const forbidden of ["approveGate", "rejectGate", "decideGate", "mergePr", "setVerdict"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

/**
 * The interface is only useful if the server actually hands one out — a
 * platform that existed but was never decorated onto the app would leave
 * maestro-mcp with nothing to inject.
 */
describe("the server exposes the platform", () => {
  it("decorates the app with every method the interface declares", async () => {
    const h = await platformHarness();

    expect(h.app.platform).toBeDefined();
    for (const method of [
      "listRuns", "getRun", "getJournal", "getParams", "proposeParamChange",
      "proposeKillSwitch", "startWorkflow", "assignApp", "getRepoCard",
      "searchKnowledge", "listPendingGates", "quotaStatus", "runnerHealth",
      "setWorkMode", "pauseRun", "resumeRun", "retryStep", "notifyGateOwner",
    ]) {
      expect(typeof (h.app.platform as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });

  it("reads through the same container the REST routes use", async () => {
    const h = await platformHarness();

    // The run seeded for the REST tests is the run the platform sees: one
    // source of truth, not two that can disagree about a step.
    const viaPlatform = await h.app.platform.listRuns(ADMIN_ACTOR, {
      status: undefined, ticketKey: undefined, appId: undefined, limit: 10,
    });
    expect(viaPlatform.map((run) => run.ticketKey)).toEqual([TICKET]);
  });
});
