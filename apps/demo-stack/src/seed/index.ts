import type { AuditChain } from "@maestro/audit";
import type { GateDecision, StepId } from "@maestro/contracts";
import { GATES_BY_RISK } from "@maestro/contracts";
import type { ReadModels } from "@maestro/bff";
import {
  InMemoryAppRegistry,
  InMemoryCostReader,
  InMemoryEvidenceReader,
  InMemoryGateBoard,
  InMemoryJournalReader,
  InMemoryKnowledgeIndex,
  InMemoryRunCatalog,
  InMemoryRunnerFleet,
  InMemoryScanReader,
} from "@maestro/bff";
import type { InMemoryRunGateway } from "../fakes/run-gateway.js";
import { callsFor, evidenceFor, openGateOf } from "./cost-evidence.js";
import { journalFor, summaryFor } from "./journal.js";
import {
  DEMO_APPS,
  demoAccounts,
  demoKnowledge,
  demoRepoCards,
  demoRunners,
  demoSandboxes,
  demoScans,
} from "./platform.js";
import { DEMO_RUNS } from "./runs-data.js";
import { runRecordOf, runStateOf, stampBefore } from "./runs.js";
import { actorOf } from "./users.js";

/**
 * Fill the stores. One pass over the runs produces every derived record —
 * catalog row, execution state, journal, summary, call log, open gate, evidence
 * package and audit trail — so all eight describe the same run by construction.
 */

export interface SeedInput {
  readonly read: ReadModels;
  readonly runs: InMemoryRunGateway;
  readonly audit: AuditChain;
  readonly at: Date;
}

/** What was seeded, for the boot banner and the README's honest inventory. */
export interface SeedSummary {
  readonly runs: number;
  readonly openGates: number;
  readonly journalEntries: number;
  readonly costRows: number;
  readonly evidencePackages: number;
  readonly auditEvents: number;
  readonly knowledgeDocs: number;
  readonly confidentialDocs: number;
  readonly runners: number;
  readonly unreachableRunners: number;
  readonly applications: number;
  readonly accounts: number;
}

export async function seedInto(input: SeedInput): Promise<SeedSummary> {
  const { read, runs, audit, at } = input;
  const stores = concreteStores(read);

  for (const app of DEMO_APPS) stores.apps.put(app);
  for (const card of demoRepoCards(at)) stores.apps.putRepoCard(card);
  for (const runner of demoRunners(at)) stores.runners.put(runner);
  for (const box of demoSandboxes(at)) stores.runners.putSandbox(box);
  for (const scan of demoScans(at)) stores.scans.put(scan);
  const knowledge = demoKnowledge(at);
  for (const doc of knowledge) stores.knowledge.put(doc);

  let journalEntries = 0;
  let costRows = 0;
  let openGates = 0;
  let evidencePackages = 0;

  for (const run of DEMO_RUNS) {
    stores.runs.put(runRecordOf(run, at));
    runs.put(runStateOf(run, at));

    const journal = journalFor(run, at);
    for (const entry of journal) stores.journal.append(entry);
    stores.journal.putSummary(runStateOf(run, at).runId, summaryFor(run));
    journalEntries += journal.length;

    const calls = callsFor(run, journal);
    for (const call of calls) stores.cost.put(call);
    costRows += calls.length;

    const gate = openGateOf(run, at);
    if (gate !== null) {
      stores.gates.open(gate);
      openGates += 1;
    }

    // The approvals a closed run collected, recorded in the trail FIRST so the
    // manifest's `signatureSeq` is a real position in the hash chain rather than
    // a number chosen to look like one (M33/M56).
    const approvals = await recordApprovals(run, audit, at);
    const evidence = evidenceFor(run, approvals, at);
    if (evidence !== null) {
      stores.evidence.put(evidence);
      evidencePackages += 1;
    }
  }

  const head = await audit.head();
  return {
    runs: DEMO_RUNS.length,
    openGates,
    journalEntries,
    costRows,
    evidencePackages,
    auditEvents: head?.seq ?? 0,
    knowledgeDocs: knowledge.length,
    confidentialDocs: knowledge.filter((doc) => doc.dataClass === "gizli").length,
    runners: demoRunners(at).length,
    unreachableRunners: demoRunners(at).filter((runner) => runner.state === "unreachable").length,
    applications: DEMO_APPS.length,
    accounts: demoAccounts(at).length,
  };
}

/**
 * Write a closed run's approval chain into the audit trail and return the
 * decisions, each carrying the `seq` its record actually got.
 *
 * The gates are the ones the run's RISK TIER demands (`GATES_BY_RISK`), not a
 * fixed list: a `dusuk` run really does collect two approvals and an `orta` one
 * four, and a manifest claiming otherwise would misstate the control that was
 * applied. The actor is the role's holder, so an auditor reading the trail sees
 * a Tech Lead on the Tech Lead gate.
 */
async function recordApprovals(
  run: (typeof DEMO_RUNS)[number],
  audit: AuditChain,
  at: Date,
): Promise<GateDecision[]> {
  if (run.status !== "done") return [];

  const decisions: GateDecision[] = [];
  const gates = GATES_BY_RISK[run.risk];
  for (const [index, step] of gates.entries()) {
    const owner = APPROVER_OF_STEP[step];
    if (owner === undefined) continue;

    // Spaced through the run's life so the trail reads as a sequence of
    // decisions rather than a batch written at closure.
    const hoursAgo = run.updatedHoursAgo + (gates.length - index) * 4;
    const stamp = stampBefore(at, hoursAgo);
    const event = await audit.append({
      actor: actorOf(owner.username),
      action: "GATE_APPROVE",
      subject: run.ticketKey,
      at: stamp,
      meta: { step, group: owner.group, source: "studio" },
    });

    decisions.push({
      step,
      decision: "approve",
      actorUserId: actorOf(owner.username),
      actorGroup: owner.group,
      sodVerified: true,
      signatureSeq: event.seq,
      source: "studio",
      at: stamp,
    });
  }
  return decisions;
}

/** Who signed which gate, matching the roster's roles and the gate directory. */
const APPROVER_OF_STEP: Readonly<Partial<Record<StepId, { username: string; group: string }>>> = {
  "4": { username: "can.ozturk", group: "product-owners" },
  "5": { username: "mert.demir", group: "tech-leads" },
  "9": { username: "deniz.yilmaz", group: "qa" },
  "11": { username: "deniz.yilmaz", group: "qa" },
  "12": { username: "mert.demir", group: "tech-leads" },
};

/**
 * The read models as the concrete stores they are.
 *
 * `ReadModels` is an interface of readers; seeding needs the writers the
 * in-memory implementations add. The cast is checked at runtime rather than
 * asserted: a caller who passed a differently-backed read model would otherwise
 * fail later, inside a `put` that does not exist, with a stack trace pointing at
 * the wrong file.
 */
function concreteStores(read: ReadModels): {
  runs: InMemoryRunCatalog;
  journal: InMemoryJournalReader;
  gates: InMemoryGateBoard;
  apps: InMemoryAppRegistry;
  knowledge: InMemoryKnowledgeIndex;
  runners: InMemoryRunnerFleet;
  cost: InMemoryCostReader;
  scans: InMemoryScanReader;
  evidence: InMemoryEvidenceReader;
} {
  const expect = <T>(value: unknown, type: new (...args: never[]) => T, name: string): T => {
    if (!(value instanceof type)) {
      throw new Error(`demo seed: read.${name} must be the in-memory store to be seedable`);
    }
    return value;
  };
  return {
    runs: expect(read.runs, InMemoryRunCatalog, "runs"),
    journal: expect(read.journal, InMemoryJournalReader, "journal"),
    gates: expect(read.gates, InMemoryGateBoard, "gates"),
    apps: expect(read.apps, InMemoryAppRegistry, "apps"),
    knowledge: expect(read.knowledge, InMemoryKnowledgeIndex, "knowledge"),
    runners: expect(read.runners, InMemoryRunnerFleet, "runners"),
    cost: expect(read.cost, InMemoryCostReader, "cost"),
    scans: expect(read.scans, InMemoryScanReader, "scans"),
    evidence: expect(read.evidence, InMemoryEvidenceReader, "evidence"),
  };
}
