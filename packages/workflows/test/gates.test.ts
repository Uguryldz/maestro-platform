import { describe, expect, it } from "vitest";
import type { GateDecision, StepId } from "@maestro/contracts";
import { canCloseGate, gatesFor, isApprovalGate } from "../src/gates.js";

const base: Omit<GateDecision, "step" | "decision"> = {
  actorUserId: "ayse.kaya@bank",
  actorGroup: "tech-leads",
  sodVerified: true,
  signatureSeq: 1,
  source: "jira",
  at: "2026-08-09T10:00:00+03:00",
};

const approve = (step: StepId, over: Partial<GateDecision> = {}): GateDecision =>
  ({ ...base, step, decision: "approve", ...over }) as GateDecision;

describe("the gate set per risk tier (M51)", () => {
  it("a critical run opens every approval gate, and exactly the full set", () => {
    for (const gate of gatesFor("kritik")) {
      expect(isApprovalGate(gate)).toBe(true);
    }
    // Five approval gates, not six: step 2b is an unbounded human WAIT, not a
    // gate, and it exists at every tier (M51, clarified 2026-08-09).
    expect(gatesFor("kritik")).toEqual(["4", "5", "9", "11", "12"]);
  });

  it("each tier is a prefix-free subset of the critical set", () => {
    expect(gatesFor("dusuk")).toEqual(["5", "12"]);
    expect(gatesFor("orta")).toEqual(["4", "5", "11", "12"]);
    for (const tier of ["dusuk", "orta", "kritik"] as const) {
      for (const gate of gatesFor(tier)) expect(isApprovalGate(gate)).toBe(true);
    }
  });
});

describe("canCloseGate — fail-closed on every axis", () => {
  it("accepts the right group at the right step", () => {
    expect(canCloseGate(approve("5"), "5", new Map())).toEqual({ ok: true });
  });

  it("refuses a decision aimed at another step", () => {
    expect(canCloseGate(approve("5"), "12", new Map())).toEqual({
      ok: false,
      reason: "wrong_step",
    });
  });

  it("refuses the wrong group — a PO cannot close the Tech Lead gate", () => {
    const asPo = approve("5", { actorGroup: "product-owners" });
    expect(canCloseGate(asPo, "5", new Map())).toEqual({ ok: false, reason: "wrong_group" });
  });

  it("refuses an approval that never passed SoD verification", () => {
    const unverified = approve("5", { sodVerified: false });
    expect(canCloseGate(unverified, "5", new Map())).toEqual({ ok: false, reason: "not_verified" });
  });

  it("enforces four eyes: the step-4 approver cannot also sign step 5 (M32)", () => {
    const previous = new Map<StepId, string>([["4", "ayse.kaya@bank"]]);
    expect(canCloseGate(approve("5"), "5", previous)).toEqual({
      ok: false,
      reason: "sod_violation",
    });
    const other = approve("5", { actorUserId: "mert.demir@bank" });
    expect(canCloseGate(other, "5", previous)).toEqual({ ok: true });
  });

  it("enforces the QA split when it applies (M92)", () => {
    const previous = new Map<StepId, string>([["9", "deniz@bank"]]);
    const same = approve("11", { actorGroup: "qa", actorUserId: "deniz@bank" });
    expect(canCloseGate(same, "11", previous)).toEqual({ ok: false, reason: "sod_violation" });
  });

  it("waives the cross-gate rule for a master admin (single-admin exemption)", () => {
    // selfApproveAllowed=true lets the same person sign both gates so a
    // one-admin install is not deadlocked. Only the cross-gate rule is waived —
    // the other checks still stand.
    const step4and5 = new Map<StepId, string>([["4", "ugur@bank"]]);
    const sameOn5 = approve("5", { actorUserId: "ugur@bank" });
    expect(canCloseGate(sameOn5, "5", step4and5, true)).toEqual({ ok: true });

    const step9and11 = new Map<StepId, string>([["9", "ugur@bank"]]);
    const sameOn11 = approve("11", { actorGroup: "qa", actorUserId: "ugur@bank" });
    expect(canCloseGate(sameOn11, "11", step9and11, true)).toEqual({ ok: true });
  });

  it("still enforces wrong_group even for a master admin (only SoD is waived)", () => {
    // The exemption is narrow: a master admin signing the wrong owner group is
    // still refused. selfApproveAllowed only touches the cross-gate signature.
    const wrongGroup = approve("5", { actorGroup: "developers", actorUserId: "ugur@bank" });
    expect(canCloseGate(wrongGroup, "5", new Map(), true)).toEqual({
      ok: false,
      reason: "wrong_group",
    });
  });

  // Stopping the flow needs no authority; letting it through does.
  it("lets any rejection close the gate, even an unverified one", () => {
    const reject: GateDecision = {
      ...base,
      step: "5",
      decision: "reject",
      reason: "kapsam yanlış",
      sodVerified: false,
      actorGroup: "someone-else",
    } as GateDecision;
    expect(canCloseGate(reject, "5", new Map())).toEqual({ ok: true });
  });
});
