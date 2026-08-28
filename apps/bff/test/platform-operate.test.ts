import { describe, expect, it } from "vitest";
import { KILL_SWITCH_PROPOSAL_KEY } from "../src/platform/index.js";
import { UGURPAY_BINDING } from "./helpers.js";
import { GATE, RUN_ID, TICKET, studioHarness } from "./studio-fixtures.js";

/**
 * The operate half of `MaestroPlatform` (M101). Everything here changes
 * something, so each test asks the question the packet brief asks: does the
 * check that should have stopped it actually stop it, and does the effect
 * reach the workflow as a SIGNAL rather than as a decision.
 */

const MEMBER = "uye.kisi";
const MEMBER_ACTOR = "uye.kisi@ugurbank.local";
const DELEGATED_ACTOR = `ai-via:${MEMBER_ACTOR}`;
const ADMIN_ACTOR = "yonetici@ugurbank.local";

async function operateHarness(): ReturnType<typeof studioHarness> {
  const h = await studioHarness();
  await h.addUser({ username: MEMBER, groups: ["maestro-ugurpay"] });
  await h.addUser({ username: "yonetici", roles: ["admin"], groups: ["maestro-ugurpay"] });
  return h;
}

describe("setWorkMode", () => {
  it("delivers a modeChange signal and audits it", async () => {
    const h = await operateHarness();

    const result = await h.platform.setWorkMode(MEMBER_ACTOR, {
      runId: RUN_ID,
      mode: "ai_assist",
      reason: "insan devraldı",
    });

    expect(result).toMatchObject({ runId: RUN_ID, mode: "ai_assist" });
    expect(h.runs.signals).toHaveLength(1);
    expect(h.runs.signals[0]).toMatchObject({ name: "modeChange", arg: { mode: "ai_assist" } });
    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).toContain("MODE_CHANGED");
  });

  it("refuses a run the caller cannot see", async () => {
    const h = await operateHarness();
    await expect(
      h.platform.setWorkMode(MEMBER_ACTOR, { runId: "run-UGURWEB-104", mode: "full_auto", reason: "x" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.runs.signals).toHaveLength(0);
  });

  /** M58: nothing writes while the switch is on. */
  it("refuses while the kill switch is engaged", async () => {
    const h = await operateHarness();
    await h.killSwitch.set({ level: "all", actor: ADMIN_ACTOR, reason: "olay", at: "2026-08-09T09:00:00.000Z" });

    await expect(
      h.platform.setWorkMode(MEMBER_ACTOR, { runId: RUN_ID, mode: "full_auto", reason: "x" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.runs.signals).toHaveLength(0);
  });
});

describe("pauseRun and resumeRun", () => {
  it("pauses by handing the run to a human", async () => {
    const h = await operateHarness();

    const result = await h.platform.pauseRun(MEMBER_ACTOR, { runId: RUN_ID, reason: "inceleme" });

    expect(result).toMatchObject({ runId: RUN_ID, status: "paused" });
    expect(h.runs.signals[0]).toMatchObject({ arg: { mode: "human_only" } });
  });

  /** Resuming must not be a quiet promotion of what the AI may do. */
  it("resumes to the run's own mode rather than to full_auto", async () => {
    const h = await operateHarness();
    h.read.runs.put({ ...(await h.read.runs.get(TICKET))!, mode: "ai_assist" });

    await h.platform.resumeRun(MEMBER_ACTOR, { runId: RUN_ID, reason: "devam" });

    expect(h.runs.signals[0]).toMatchObject({ arg: { mode: "ai_assist" } });
  });
});

describe("retryStep", () => {
  it("retries the step the run is actually on", async () => {
    const h = await operateHarness();

    const result = await h.platform.retryStep(MEMBER_ACTOR, {
      runId: RUN_ID,
      step: "5",
      reason: "geçici hata",
    });

    expect(result).toMatchObject({ runId: RUN_ID, step: "5" });
    expect(h.runs.signals).toHaveLength(1);
  });

  /** Rewinding past a completed step would undo work later steps built on. */
  it("refuses a step the run has already moved past", async () => {
    const h = await operateHarness();

    await expect(
      h.platform.retryStep(MEMBER_ACTOR, { runId: RUN_ID, step: "3", reason: "x" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.runs.signals).toHaveLength(0);
  });
});

describe("startWorkflow", () => {
  /**
   * M102: the packet brief's own warning — an unbound project must not be
   * processed, and a tool that could start a run in one would be a way around
   * the binding entirely.
   */
  it("refuses a ticket whose project was never bound", async () => {
    const h = await operateHarness();

    // An admin clears the project-access check (cross-project role), so the
    // refusal here is the BINDING one — which is the check that matters: the
    // single global webhook delivers every project's traffic, and an unbound
    // project must not be processed no matter who asks.
    await expect(
      h.platform.startWorkflow(ADMIN_ACTOR, { ticketKey: "UGURKREDI-9", mode: undefined }),
    ).rejects.toMatchObject({ status: 409, code: "intake_unbound" });
    expect(h.runs.started).toHaveLength(0);
  });

  it("refuses a project the caller does not belong to", async () => {
    const h = await operateHarness();
    h.bindings.put({ ...UGURPAY_BINDING, projectKey: "UGURWEB" });

    await expect(
      h.platform.startWorkflow(MEMBER_ACTOR, { ticketKey: "UGURWEB-500", mode: undefined }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("starts a bound ticket and returns its run id", async () => {
    const h = await operateHarness();

    const result = await h.platform.startWorkflow(MEMBER_ACTOR, {
      ticketKey: "UGURPAY-900",
      mode: undefined,
    });

    expect(result.ticketKey).toBe("UGURPAY-900");
    expect(result.runId).toBe("run-UGURPAY-900");
    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).toContain("RUN_STARTED");
  });

  it("rejects a malformed ticket key", async () => {
    const h = await operateHarness();
    await expect(
      h.platform.startWorkflow(MEMBER_ACTOR, { ticketKey: "nope", mode: undefined }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses while the kill switch is engaged", async () => {
    const h = await operateHarness();
    await h.killSwitch.set({ level: "intake_only", actor: ADMIN_ACTOR, reason: "bakım", at: "2026-08-09T09:00:00.000Z" });

    await expect(
      h.platform.startWorkflow(MEMBER_ACTOR, { ticketKey: "UGURPAY-901", mode: undefined }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("assignApp", () => {
  it("refuses an application that is not in the registry", async () => {
    const h = await operateHarness();

    await expect(
      h.platform.assignApp(MEMBER_ACTOR, { ticketKey: "UGURPAY-902", appId: "yok-boyle" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("assigns a registered application and audits it", async () => {
    const h = await operateHarness();

    const result = await h.platform.assignApp(MEMBER_ACTOR, {
      ticketKey: "UGURPAY-902",
      appId: "ugurpay",
    });

    expect(result).toMatchObject({ ticketKey: "UGURPAY-902", appId: "ugurpay" });
    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).toContain("ASSIGN_APP");
  });
});

/**
 * M71/M101: the tool files a proposal and MUST NOT apply the change. The
 * interface has no shape that means "applied", and this is what enforces it.
 */
describe("proposeParamChange", () => {
  it("queues a guarded key for four eyes without applying it", async () => {
    const h = await operateHarness();

    const proposal = await h.platform.proposeParamChange(DELEGATED_ACTOR, {
      key: "gate.set",
      scopeRef: null,
      value: { "4": "product-owners" },
      reason: "yeni kapı seti",
    });

    expect(proposal.status).toBe("pending_four_eyes");
    expect(proposal.approverGroup).toBe("maestro-admins");
    // Queued, not applied: the live value list is still empty.
    expect(await h.params.values()).toHaveLength(0);
    expect(await h.params.pending()).toHaveLength(1);
  });

  /** An unguarded key would otherwise be changed outright by a tool call. */
  it("refuses an unguarded key rather than applying it", async () => {
    const h = await operateHarness();

    await expect(
      h.platform.proposeParamChange(DELEGATED_ACTOR, {
        key: "reminder.channel",
        scopeRef: null,
        value: "smtp",
        reason: "x",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses while the kill switch is engaged", async () => {
    const h = await operateHarness();
    await h.killSwitch.set({ level: "all", actor: ADMIN_ACTOR, reason: "olay", at: "2026-08-09T09:00:00.000Z" });

    await expect(
      h.platform.proposeParamChange(ADMIN_ACTOR, { key: "gate.set", scopeRef: null, value: {}, reason: "x" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("proposeKillSwitch", () => {
  it("files a proposal and does not flip the switch", async () => {
    const h = await operateHarness();

    const proposal = await h.platform.proposeKillSwitch(ADMIN_ACTOR, {
      level: "stop_all",
      reason: "olay müdahalesi",
    });

    expect(proposal.status).toBe("pending_four_eyes");
    // The switch itself is untouched — a second human confirms it in Studio.
    expect((await h.killSwitch.get()).level).toBe("off");
    const pending = await h.params.pending();
    expect(pending.find((change) => change.key === KILL_SWITCH_PROPOSAL_KEY)).toBeDefined();
  });

  it("refuses a caller who is not an admin", async () => {
    const h = await operateHarness();

    await expect(
      h.platform.proposeKillSwitch(MEMBER_ACTOR, { level: "stop_all", reason: "x" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  /** Proposing to stop must keep working once the platform is stopping. */
  it("still accepts a proposal while the switch is already engaged", async () => {
    const h = await operateHarness();
    await h.killSwitch.set({ level: "intake_only", actor: ADMIN_ACTOR, reason: "bakım", at: "2026-08-09T09:00:00.000Z" });

    const proposal = await h.platform.proposeKillSwitch(ADMIN_ACTOR, {
      level: "stop_all",
      reason: "durum kötüleşti",
    });

    expect(proposal.status).toBe("pending_four_eyes");
  });
});

describe("notifyGateOwner", () => {
  it("posts the catalog reminder and audits the nudge", async () => {
    const h = await operateHarness();
    h.read.gates.open(GATE);

    const result = await h.platform.notifyGateOwner(MEMBER_ACTOR, {
      runId: RUN_ID,
      step: "5",
      message: null,
    });

    expect(result).toMatchObject({ runId: RUN_ID, step: "5", notified: "tech-leads" });
    // The sentence comes from the catalog (M104), rendered with real numbers.
    expect(h.work.lastComment(TICKET)).toBe(`${TICKET} 4 gündür 5 kapısında bekliyor`);
    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).toContain("MCP_TOOL_CALL");
  });

  /** A reminder about a decision nobody is waiting for is a mistake to report. */
  it("refuses when no gate is open at that step", async () => {
    const h = await operateHarness();

    await expect(
      h.platform.notifyGateOwner(MEMBER_ACTOR, { runId: RUN_ID, step: "12", message: null }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.work.comments).toHaveLength(0);
  });

  it("returns nothing about whether the gate was decided", async () => {
    const h = await operateHarness();
    h.read.gates.open(GATE);

    const result = await h.platform.notifyGateOwner(MEMBER_ACTOR, {
      runId: RUN_ID, step: "5", message: "lütfen bakar mısın",
    });

    expect(Object.keys(result).sort()).toEqual(["notified", "runId", "step"]);
  });
});
