import { describe, expect, it } from "vitest";
import { OPERATE_METHODS, type OperateHalf } from "../src/platform/index.js";
import { GATE, RUN_ID, studioHarness } from "./studio-fixtures.js";
import type { Harness } from "./helpers.js";

/**
 * The kill switch, audited across the WHOLE operate half (M58).
 *
 * This file exists because of a real escape: `notifyGateOwner` was written
 * without the `assertWritable` call its six siblings had, so with the platform
 * stopped an AI could still post a comment to the bank's Jira. The switch was
 * six-sevenths of a switch, and the method that got missed was the one that
 * reaches outside the process.
 *
 * So the coverage here is DERIVED rather than listed. The cases come from
 * `OPERATE_METHODS`, which comes from the same `Record<keyof OperateHalf, true>`
 * the gate itself is built from — an eighth operate method cannot be added
 * without appearing in this suite, and cannot be added to the type without
 * appearing in that record. A hand-written list of seven `it` blocks is exactly
 * what failed the first time: it can be complete on the day it is written and
 * quietly incomplete a commit later.
 */

const MEMBER_ACTOR = "uye.kisi@ugurbank.local";
const ADMIN_ACTOR = "yonetici@ugurbank.local";
const AT = "2026-08-09T09:00:00.000Z";

async function operateHarness(): Promise<Harness> {
  const h = await studioHarness();
  await h.addUser({ username: "uye.kisi", groups: ["maestro-ugurpay"] });
  await h.addUser({ username: "yonetici", roles: ["admin"], groups: ["maestro-ugurpay"] });
  return h;
}

/**
 * A legal call for each operate method — the arguments a working call would
 * carry, so a refusal is the kill switch and not a validation error. Typed
 * against `OperateHalf` so a signature change breaks this file at build time
 * rather than turning a case into a 400 that still "passes" as a rejection.
 */
const CALLS: Record<keyof OperateHalf, (platform: Harness["platform"], actor: string) => Promise<unknown>> = {
  startWorkflow: (platform, actor) =>
    platform.startWorkflow(actor, { ticketKey: "UGURPAY-901", mode: undefined }),
  assignApp: (platform, actor) =>
    platform.assignApp(actor, { ticketKey: "UGURPAY-902", appId: "ugurpay" }),
  setWorkMode: (platform, actor) =>
    platform.setWorkMode(actor, { runId: RUN_ID, mode: "ai_assist", reason: "x" }),
  pauseRun: (platform, actor) => platform.pauseRun(actor, { runId: RUN_ID, reason: "x" }),
  resumeRun: (platform, actor) => platform.resumeRun(actor, { runId: RUN_ID, reason: "x" }),
  retryStep: (platform, actor) =>
    platform.retryStep(actor, { runId: RUN_ID, step: "5", reason: "x" }),
  notifyGateOwner: (platform, actor) =>
    platform.notifyGateOwner(actor, { runId: RUN_ID, step: "5", message: null }),
};

describe("kill switch covers every operate method", () => {
  /**
   * The list the cases are derived from must be the list the type declares.
   * Without this, `CALLS` and `OPERATE_METHODS` could drift into agreeing with
   * each other while both omitting a method the interface actually has.
   */
  it("derives its cases from the operate half itself", async () => {
    const h = await operateHarness();

    expect([...OPERATE_METHODS].sort()).toEqual(Object.keys(CALLS).sort());
    // Every derived name is a real method on the composed platform, not a
    // string that only exists in this test.
    for (const name of OPERATE_METHODS) {
      expect(typeof h.platform[name]).toBe("function");
    }
    expect(OPERATE_METHODS.length).toBeGreaterThanOrEqual(7);
  });

  for (const level of ["all", "intake_only"] as const) {
    describe(`level=${level}`, () => {
      for (const name of OPERATE_METHODS) {
        it(`refuses ${name}`, async () => {
          const h = await operateHarness();
          h.read.gates.open(GATE);
          await h.killSwitch.set({ level, actor: ADMIN_ACTOR, reason: "olay", at: AT });

          await expect(CALLS[name](h.platform, MEMBER_ACTOR)).rejects.toMatchObject({
            status: 409,
            code: "kill_switch",
          });

          // Refused means nothing happened, not "rejected after the effect".
          // The Jira comment is the one that leaves the process, and it is the
          // one the missing check let through.
          expect(h.runs.signals).toHaveLength(0);
          expect(h.work.comments).toHaveLength(0);
        });
      }
    });
  }

  /**
   * The other half of the claim: with the switch off, these same calls are not
   * refused. Without this the suite would pass against a platform that refuses
   * everything always, which is a stopped platform, not a switched one.
   */
  it("lets the same calls through with the switch off", async () => {
    const h = await operateHarness();
    h.read.gates.open(GATE);

    for (const name of OPERATE_METHODS) {
      const outcome = await CALLS[name](h.platform, MEMBER_ACTOR).then(
        () => null,
        (error: unknown) => error,
      );
      expect(outcome, `${name} was refused with the switch off`).not.toMatchObject({
        code: "kill_switch",
      });
    }
    // And the effects the switch was suppressing actually happen.
    expect(h.work.comments.length).toBeGreaterThan(0);
    expect(h.runs.signals.length).toBeGreaterThan(0);
  });

  /**
   * The check runs before the body: a stopped platform must not reach a read
   * model or an outbound port at all, so refusing does not depend on the rest
   * of the deployment being healthy.
   */
  it("refuses before touching the run's read model", async () => {
    const h = await operateHarness();
    await h.killSwitch.set({ level: "all", actor: ADMIN_ACTOR, reason: "olay", at: AT });

    // A run id that does not exist would be a 404 from `runOf`. It is a 409
    // instead, which can only mean the switch was consulted first.
    await expect(
      h.platform.pauseRun(MEMBER_ACTOR, { runId: "run-YOK-1", reason: "x" }),
    ).rejects.toMatchObject({ status: 409, code: "kill_switch" });
  });
});
