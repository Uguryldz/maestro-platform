import type { Prisma } from "@prisma/client";
import { STEP_META, type StepId } from "@maestro/contracts";
import { ago, demoRunId } from "./clock.js";
import { DEMO_GATE_DECISIONS } from "./decisions.js";
import { DEMO_TICKETS } from "./tickets.js";

/**
 * Step events.
 *
 * `kind` is `STEP_META[step].kind` — the contract's own classification of the
 * step — and nothing else. It used to be derived from the *run's status*
 * (`gate → human_gate`, `done → system`, otherwise `ai`), which produced three
 * lies the moment a run sat on an unusual step: `2b` (a human WAIT, not an
 * approval gate) was recorded as `human_gate`, `6b` (the security scan, a
 * system step) as `ai`, and `10b` (the automatic CI gate) as `ai`.
 */
function kindOf(step: StepId): Prisma.StepEventCreateManyInput["kind"] {
  return STEP_META[step].kind;
}

/** One "entered this step" event per run, so every run has a visible trail. */
const ENTERED: Prisma.StepEventCreateManyInput[] = DEMO_TICKETS.map((ticket) => ({
  runId: demoRunId(ticket.key),
  step: ticket.step,
  kind: kindOf(ticket.step),
  at: ago(ticket.idleHours),
  dataJson: { event: "step_entered", status: ticket.status },
}));

/**
 * The signed decisions, stored as the step event a reviewer reads. `dataJson`
 * is a complete `GateDecision`, signature included, so the Studio detail screen
 * and the evidence package show the same record.
 */
const DECIDED: Prisma.StepEventCreateManyInput[] = DEMO_GATE_DECISIONS.map((decision) => {
  const { ticketKey, ...gateDecision } = decision;
  return {
    runId: demoRunId(ticketKey),
    step: gateDecision.step,
    kind: kindOf(gateDecision.step),
    at: new Date(gateDecision.at),
    dataJson: gateDecision as unknown as Prisma.InputJsonValue,
  };
});

export const STEP_EVENTS: Prisma.StepEventCreateManyInput[] = [...ENTERED, ...DECIDED];
