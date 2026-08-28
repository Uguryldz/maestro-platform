import { GATES_BY_RISK, type StepId } from "@maestro/contracts";
import { ago, ist } from "./clock.js";
import { DEMO_TICKETS, type DemoTicket } from "./tickets.js";

/**
 * Signed approval decisions (M51). The primary channel is a Jira `/approve`
 * comment, Studio is secondary.
 *
 * A decision has no `signatureSeq` here: the signature *is* the sequence number
 * of the audit record the decision produced, and that number is only known once
 * the whole chain is laid out. `src/demo/decisions.ts` closes the loop.
 */
export interface DemoGateIntent {
  ticketKey: string;
  step: StepId;
  decision: "approve" | "reject";
  actorUserId: string;
  actorGroup: string;
  source: "jira" | "studio";
  at: Date;
  reason?: string;
}

/**
 * Who signs which gate. The pairs are what makes separation of duties real:
 * the PO gate and the Tech Lead gate are held by different people, and the PR
 * gate is held by a third (M32/M92 — `sod.qa_split` ships off, so one QA may
 * sign both QA gates).
 */
const APPROVER_BY_STEP: Record<string, { actorUserId: string; actorGroup: string }> = {
  "4": { actorUserId: "ayse.kaya@ugurbank.local", actorGroup: "product-owners" },
  "5": { actorUserId: "mert.demir@ugurbank.local", actorGroup: "tech-leads" },
  "9": { actorUserId: "deniz.yalcin@ugurbank.local", actorGroup: "qa" },
  "11": { actorUserId: "deniz.yalcin@ugurbank.local", actorGroup: "qa" },
  "12": { actorUserId: "ayse.kaya@ugurbank.local", actorGroup: "tech-leads" },
};

export class UnknownGateStepError extends Error {
  constructor(step: string) {
    super(`no approver configured for gate step ${step}`);
    this.name = "UnknownGateStepError";
  }
}

function approverFor(step: StepId): { actorUserId: string; actorGroup: string } {
  const approver = APPROVER_BY_STEP[step];
  if (approver === undefined) throw new UnknownGateStepError(step);
  return approver;
}

/**
 * The gates a closed run must show: exactly `GATES_BY_RISK[risk]`, spread
 * evenly across the run's working window so each decision lands strictly
 * between the intake entries and the closure entry.
 */
function gatesForClosedRun(ticket: DemoTicket): DemoGateIntent[] {
  if (ticket.risk === null) return [];
  const steps = GATES_BY_RISK[ticket.risk];
  const span = ticket.ageHours - ticket.idleHours;
  return steps.map((step, index) => ({
    ticketKey: ticket.key,
    step,
    decision: "approve" as const,
    ...approverFor(step),
    source: "jira" as const,
    at: ago(ticket.ageHours - (span * (index + 1)) / (steps.length + 1)),
  }));
}

/**
 * UGURPAY-501's decisions are transcribed from the mock's journal, timestamps
 * included — it is the ticket the detail screen opens, so its story has to be
 * the mock's story rather than a generated one. Its risk tier is `orta`
 * (gates 4/5/11/12); the extra QA scenario gate at step 9 is the tier being
 * raised by hand, which M51 explicitly allows in the raising direction.
 */
const UGURPAY_501_GATES: DemoGateIntent[] = [
  {
    ticketKey: "UGURPAY-501",
    step: "4",
    decision: "approve",
    ...approverFor("4"),
    source: "jira",
    at: ist("2026-07-31T14:20:00"),
  },
  {
    ticketKey: "UGURPAY-501",
    step: "5",
    decision: "approve",
    ...approverFor("5"),
    source: "jira",
    at: ist("2026-08-01T09:15:00"),
  },
  {
    ticketKey: "UGURPAY-501",
    step: "9",
    decision: "approve",
    ...approverFor("9"),
    source: "jira",
    at: ist("2026-08-01T13:05:00"),
  },
  {
    ticketKey: "UGURPAY-501",
    step: "11",
    decision: "approve",
    ...approverFor("11"),
    source: "studio",
    at: ist("2026-08-01T14:02:00"),
  },
  {
    // The PR thread that sent UGURPAY-501 back to engineering (step 12b).
    ticketKey: "UGURPAY-501",
    step: "12",
    decision: "reject",
    ...approverFor("12"),
    source: "jira",
    at: ist("2026-08-04T16:11:00"),
    reason: "limit üst sınırı konfigden okunmalı, env değil",
  },
];

/** Every signed decision in the demo, oldest first. */
export const DEMO_GATE_INTENTS: readonly DemoGateIntent[] = [
  ...UGURPAY_501_GATES,
  ...DEMO_TICKETS.filter((ticket) => ticket.status === "done").flatMap(gatesForClosedRun),
].sort((a, b) => a.at.getTime() - b.at.getTime());

/**
 * Separation of duties, computed rather than asserted (M32).
 *
 * A decision used to carry `sodVerified: true` unconditionally, which records
 * the *claim* that SoD held, not the fact. The rule: the analysis gate (4) and
 * the Tech Lead gate (5) of one run may not be signed by the same person, and
 * neither may the Tech Lead gate and the PR gate (12).
 */
const SOD_PAIRS: readonly (readonly [StepId, StepId])[] = [
  ["4", "5"],
  ["5", "12"],
];

export function verifyGateSod(
  gate: DemoGateIntent,
  runGates: readonly DemoGateIntent[],
): boolean {
  for (const [left, right] of SOD_PAIRS) {
    const other = gate.step === left ? right : gate.step === right ? left : null;
    if (other === null) continue;
    const counterpart = runGates.find((candidate) => candidate.step === other);
    if (counterpart !== undefined && counterpart.actorUserId === gate.actorUserId) return false;
  }
  return true;
}

/** Decisions of one run, oldest first. */
export function gatesOfRun(ticketKey: string): DemoGateIntent[] {
  return DEMO_GATE_INTENTS.filter((gate) => gate.ticketKey === ticketKey);
}
