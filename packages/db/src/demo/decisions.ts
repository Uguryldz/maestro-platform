import type { Prisma } from "@prisma/client";
import { actionInfo, assertActor, GENESIS, sealEvent } from "@maestro/audit";
import type { AuditEvent, GateDecision } from "@maestro/contracts";
import { ago } from "./clock.js";
import { AMBIENT_AUDIT_EVENTS, type DemoAuditIntent } from "./audit-ambient.js";
import { DEMO_GATE_INTENTS, gatesOfRun, verifyGateSod } from "./gates.js";
import { DEMO_PARAM_VERSIONS } from "./params.js";
import { DEMO_TICKETS } from "./tickets.js";

/**
 * The single ordered story of the demo installation.
 *
 * Gate decision, audit record and evidence approval used to be three
 * independently authored lists, so they disagreed: a decision claimed signature
 * #81390 that no audit row carried, and a closed run's evidence package listed
 * no approvals at all. Here they are one array:
 *
 *   ① every table that implies an audit record produces its intents;
 *   ② the intents are sorted by time and sealed into one hash chain;
 *   ③ a gate decision's `signatureSeq` *is* the `seq` of the record it produced.
 *
 * The chain itself is not re-implemented: `sealEvent` (hash + canonical meta),
 * `GENESIS`, `assertActor` and `actionInfo` all come from `@maestro/audit`,
 * which M33 makes the only implementation. Only the loop is local, because the
 * dataset has to stay a pure synchronous fixture while `AuditChain` is async
 * around a store; `test/seed-demo.test.ts` re-verifies the result with the same
 * package's `verifyChain`, so a divergence would fail the suite.
 */

interface ChainIntent extends DemoAuditIntent {
  /** Set on gate records so the decision can find its own signature. */
  gateRef?: string;
}

const gateRef = (ticketKey: string, step: string): string => `${ticketKey}#${step}`;

/** ① Every run announces itself (M33: no run without a start record). */
const RUN_STARTED: ChainIntent[] = DEMO_TICKETS.map((ticket) => ({
  at: ago(ticket.ageHours),
  actor: "maestro-worker",
  action: "RUN_STARTED",
  subject: ticket.key,
  meta: {
    ticketKey: ticket.key,
    appId: ticket.appId,
    mode: ticket.mode,
    dataClass: ticket.dataClass,
    risk: ticket.risk,
  },
}));

/** Runs parked at a gate opened it when they last changed state. */
const GATE_OPENED: ChainIntent[] = DEMO_TICKETS.filter((t) => t.status === "gate").map((ticket) => ({
  at: ago(ticket.idleHours),
  actor: "maestro-worker",
  action: "GATE_OPEN",
  subject: `${ticket.key} · ${ticket.step}`,
  meta: { ticketKey: ticket.key, step: ticket.step, risk: ticket.risk },
}));

/** A failed run is a CI result, not a mystery. */
const CI_RESULTS: ChainIntent[] = DEMO_TICKETS.filter((t) => t.status === "fail").map((ticket) => ({
  at: ago(ticket.idleHours),
  actor: "maestro-worker",
  action: "CI_RESULT",
  subject: `${ticket.key} · build validation failed`,
  meta: { ticketKey: ticket.key, status: "failed" },
}));

/** Every signed decision, human actor and all (`GATE_*` is humanOnly). */
const GATE_DECIDED: ChainIntent[] = DEMO_GATE_INTENTS.map((gate) => ({
  at: gate.at,
  actor: gate.actorUserId,
  action: gate.decision === "approve" ? "GATE_APPROVE" : "GATE_REJECT",
  subject: `${gate.ticketKey} · ${gate.step}`,
  gateRef: gateRef(gate.ticketKey, gate.step),
  meta: {
    ticketKey: gate.ticketKey,
    step: gate.step,
    actorGroup: gate.actorGroup,
    source: gate.source,
    sodVerified: verifyGateSod(gate, gatesOfRun(gate.ticketKey)),
    ...(gate.reason === undefined ? {} : { reason: gate.reason }),
  },
}));

/** A closed run merged its PR and then closed. */
const CLOSURES: ChainIntent[] = DEMO_TICKETS.filter((t) => t.status === "done").flatMap((ticket) => [
  {
    at: ago(ticket.idleHours + 0.5),
    actor: "maestro-worker",
    action: "PR_MERGED" as const,
    subject: `${ticket.key} · PR merged`,
    meta: { ticketKey: ticket.key, appId: ticket.appId },
  },
  {
    at: ago(ticket.idleHours),
    actor: "maestro-worker",
    action: "RUN_CLOSED" as const,
    subject: `${ticket.key} · kanıt paketi arşivlendi`,
    meta: { ticketKey: ticket.key, retentionYears: 10 },
  },
]);

/** Every stored parameter version above the installer's v1 is a change. */
const PARAM_CHANGES: ChainIntent[] = DEMO_PARAM_VERSIONS.map((version) => ({
  at: version.at as Date,
  actor: version.changedBy,
  action: "PARAM_CHANGED",
  subject: `${version.key}${version.scopeRef === "" ? "" : ` · ${String(version.scopeRef)}`} → v${version.version}`,
  meta: {
    key: version.key,
    scopeRef: version.scopeRef === "" ? null : String(version.scopeRef),
    version: version.version,
    approvedBy: version.approvedBy ?? null,
  },
}));

/**
 * ② One array, sorted by instant. `Array.prototype.sort` is stable, so events
 * that share an instant keep the order they were declared in and the dataset
 * stays byte-identical between builds.
 */
const ORDERED: ChainIntent[] = [
  ...RUN_STARTED,
  ...GATE_OPENED,
  ...CI_RESULTS,
  ...GATE_DECIDED,
  ...CLOSURES,
  ...PARAM_CHANGES,
  ...AMBIENT_AUDIT_EVENTS,
].sort((a, b) => a.at.getTime() - b.at.getTime());

const events: AuditEvent[] = [];
const signatureSeqByGate = new Map<string, number>();

let prevHash: string = GENESIS;
ORDERED.forEach((intent, index) => {
  const identity = assertActor(intent.actor);
  if (actionInfo(intent.action).humanOnly && identity.kind !== "human") {
    // Same rule `AuditChain.append` enforces: an approval a system account
    // could have written is not a control (M32/M101).
    throw new Error(`${intent.action} needs a human actor, demo row has ${intent.actor}`);
  }

  const event = sealEvent({
    seq: index + 1,
    at: intent.at.toISOString(),
    actor: intent.actor,
    action: intent.action,
    subject: intent.subject,
    prevHash,
    meta: intent.meta ?? {},
  });
  events.push(event);
  prevHash = event.hash;

  if (intent.gateRef !== undefined) signatureSeqByGate.set(intent.gateRef, event.seq);
});

/** The sealed chain, oldest first — the shape `@maestro/audit` verifies. */
export const DEMO_AUDIT_EVENTS: readonly AuditEvent[] = events;

export const AUDIT_LOG_ROWS: Prisma.AuditLogCreateManyInput[] = events.map((event) => ({
  seq: BigInt(event.seq),
  at: new Date(event.at),
  actor: event.actor,
  action: event.action,
  subject: event.subject,
  prevHash: event.prevHash,
  hash: event.hash,
  metaJson: event.meta as Prisma.InputJsonValue,
}));

/** ③ A decision plus the ticket it belongs to and the signature it earned. */
export interface DemoGateDecision extends GateDecision {
  ticketKey: string;
}

export const DEMO_GATE_DECISIONS: readonly DemoGateDecision[] = DEMO_GATE_INTENTS.map((gate) => {
  const seq = signatureSeqByGate.get(gateRef(gate.ticketKey, gate.step));
  if (seq === undefined) {
    throw new Error(`no audit record for gate ${gate.ticketKey}/${gate.step}`);
  }
  return {
    ticketKey: gate.ticketKey,
    step: gate.step,
    decision: gate.decision,
    actorUserId: gate.actorUserId,
    actorGroup: gate.actorGroup,
    sodVerified: verifyGateSod(gate, gatesOfRun(gate.ticketKey)),
    signatureSeq: seq,
    source: gate.source,
    at: gate.at.toISOString(),
    ...(gate.reason === undefined ? {} : { reason: gate.reason }),
  };
});

/** Decisions of one run, oldest first — used by evidence and the journal. */
export function decisionsOfRun(ticketKey: string): DemoGateDecision[] {
  return DEMO_GATE_DECISIONS.filter((decision) => decision.ticketKey === ticketKey);
}

/** The signature a given gate earned, for the journal's `imza #…` lines. */
export function signatureSeqOf(ticketKey: string, step: string): number {
  const seq = signatureSeqByGate.get(gateRef(ticketKey, step));
  if (seq === undefined) throw new Error(`no signature for gate ${ticketKey}/${step}`);
  return seq;
}
