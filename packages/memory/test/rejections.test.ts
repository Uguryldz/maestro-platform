import { GateDecision } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { openRejections, reviewGateDecisions } from "../src/rejections.js";
import { SAMPLE_EMAIL, testMasker } from "./fakes/support.js";

function gate(input: {
  step: GateDecision["step"];
  decision: GateDecision["decision"];
  signatureSeq: number;
  reason?: string;
  at?: string;
  actorGroup?: string;
  actorUserId?: string;
  sodVerified?: boolean;
}): GateDecision {
  return GateDecision.parse({
    step: input.step,
    decision: input.decision,
    actorUserId: input.actorUserId ?? "u.yildiz",
    actorGroup: input.actorGroup ?? "tech-leads",
    sodVerified: input.sodVerified ?? true,
    signatureSeq: input.signatureSeq,
    source: "studio",
    at: input.at ?? "2026-08-07T09:00:00+03:00",
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

describe("openRejections", () => {
  const identity = (text: string): string => text;

  it("keeps a rejection open until the same step is approved", () => {
    const open = openRejections(
      [
        gate({ step: "5", decision: "reject", signatureSeq: 1, reason: "no tests" }),
        gate({ step: "5", decision: "approve", signatureSeq: 2 }),
        gate({ step: "12", decision: "reject", signatureSeq: 3, reason: "PR too wide" }),
      ],
      identity,
    );
    expect(open.map((item) => item.step)).toEqual(["12"]);
    expect(open[0]?.reason).toBe("PR too wide");
  });

  it("does not let one group's approval close another group's rejection (Y-4/M32)", () => {
    // A four-eyes gate carries two signatures (PO ≠ TL, M32). Closing "the
    // latest decision on this step" would let either group erase the other's
    // rejection — and the agent would never see what it still owes.
    const open = openRejections(
      [
        gate({
          step: "5",
          decision: "reject",
          signatureSeq: 1,
          reason: "migration touched",
          actorGroup: "tech-leads",
        }),
        gate({
          step: "5",
          decision: "approve",
          signatureSeq: 2,
          actorGroup: "product-owners",
          actorUserId: "u.demir",
        }),
      ],
      identity,
    );
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      step: "5",
      actorGroup: "tech-leads",
      reason: "migration touched",
    });
  });

  it("closes a rejection when the group that rejected approves", () => {
    const open = openRejections(
      [
        gate({ step: "5", decision: "reject", signatureSeq: 1, reason: "no tests", actorGroup: "tech-leads" }),
        gate({ step: "5", decision: "approve", signatureSeq: 2, actorGroup: "tech-leads" }),
      ],
      identity,
    );
    expect(open).toEqual([]);
  });

  it("does not let an approval that failed the SoD check close anything (Y-4/M32)", () => {
    const decisions = [
      gate({ step: "5", decision: "reject", signatureSeq: 1, reason: "no tests" }),
      gate({ step: "5", decision: "approve", signatureSeq: 2, sodVerified: false }),
    ];
    const { open, suspect } = reviewGateDecisions(decisions, identity);
    expect(open.map((item) => item.step)).toEqual(["5"]);
    expect(suspect).toHaveLength(1);
    expect(suspect[0]).toMatchObject({ step: "5", decision: "approve", sodVerified: false });
  });

  it("lets a rejection win a tie, whatever order the decisions arrive in (Y-4)", () => {
    const at = "2026-08-07T09:00:00+03:00";
    const approve = gate({ step: "5", decision: "approve", signatureSeq: 7, at });
    const reject = gate({ step: "5", decision: "reject", signatureSeq: 7, at, reason: "tie" });
    // Two rows with the same signed position: fail closed, not by array order.
    expect(openRejections([approve, reject], identity).map((r) => r.step)).toEqual(["5"]);
    expect(openRejections([reject, approve], identity).map((r) => r.step)).toEqual(["5"]);
  });

  it("orders by the signed chain, not by array order", () => {
    const open = openRejections(
      [
        gate({ step: "5", decision: "approve", signatureSeq: 9 }),
        gate({ step: "5", decision: "reject", signatureSeq: 2, reason: "early" }),
      ],
      identity,
    );
    expect(open).toEqual([]);
  });

  it("masks the reason on its way out (M82)", () => {
    const masker = testMasker();
    const open = openRejections(
      [gate({ step: "9", decision: "reject", signatureSeq: 1, reason: `ask ${SAMPLE_EMAIL}` })],
      (text) => masker.text(text),
    );
    expect(open[0]?.reason).toMatch(/\[EMAIL_1\.[0-9a-f]+\]/);
    expect(open[0]?.reason).not.toContain(SAMPLE_EMAIL);
  });
});
