import type {
  ApplicationRecord,
  GateDecision,
  JournalEntry,
  StepId,
  TicketSnapshot,
} from "@maestro/contracts";
import type { JournalStore, MaskedJournalEntry } from "@maestro/memory";
import { EscalationLadder, type NotifyRouting } from "@maestro/notify";
import type { GateRecord, RunContext } from "../src/impl/deps.js";

/** Fixtures and in-memory stores the activity tests share. */

export const APP: ApplicationRecord = {
  appId: "pay",
  displayName: "Ödeme",
  adoProject: "BANK",
  adoRepo: "pay",
  platform: "linux-node",
  jiraComponent: "payments",
  maestroYamlPresent: true,
  createdVia: "import",
};

export const SNAPSHOT: TicketSnapshot = {
  key: "PAY-101",
  projectKey: "PAY",
  issueType: "Bug",
  summary: "ödeme iki kez düşüyor",
  description: "müşteri iki kez ücretlendiriliyor",
  reporter: "reporter@bank",
  assignee: null,
  components: ["payments"],
  labels: ["maestro"],
  parentKey: null,
  createdAt: "2026-08-01T09:00:00+03:00",
  updatedAt: "2026-08-01T09:00:00+03:00",
};

export function runContext(over: Partial<RunContext> = {}): RunContext {
  return {
    runId: "run-pay-101-0001",
    ticket: "PAY-101",
    step: "0",
    status: "running",
    app: APP,
    dataClass: "dahili",
    mode: "full_auto",
    locale: "tr",
    variantId: "v1",
    templateVersion: "analysis@1.0.0",
    workspacePath: "/w/pay-101",
    workspacePresent: true,
    protectedPaths: [],
    verification: [{ name: "test", command: ["pnpm", "test"] }],
    branch: "maestro/PAY-101",
    targetBranch: "main",
    risk: null,
    prId: null,
    resumeToken: null,
    ...over,
  };
}

/** Append-only, exactly like the real one: no update, no delete. */
export class MemoryJournalStore implements JournalStore {
  readonly entries: JournalEntry[] = [];

  maxSeq(runId: string): Promise<number | null> {
    const seqs = this.entries.filter((e) => e.runId === runId).map((e) => e.seq);
    return Promise.resolve(seqs.length === 0 ? null : Math.max(...seqs));
  }

  insert(entry: MaskedJournalEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }

  list(runId: string, fromSeq = 0): Promise<JournalEntry[]> {
    return Promise.resolve(
      this.entries.filter((e) => e.runId === runId && e.seq >= fromSeq).sort((a, b) => a.seq - b.seq),
    );
  }
}

export class MemoryGateStore {
  readonly records = new Map<string, GateRecord>();
  readonly closed: GateDecision[] = [];

  private key(runId: string, step: StepId): string {
    return `${runId}:${step}`;
  }

  open(runId: string, step: StepId, ownerGroup: string, at: string): Promise<GateRecord> {
    const existing = this.records.get(this.key(runId, step));
    if (existing !== undefined) return Promise.resolve(existing);
    const record: GateRecord = { runId, step, ownerGroup, openedAt: at, firedStepIds: [], closedAt: null };
    this.records.set(this.key(runId, step), record);
    return Promise.resolve(record);
  }

  get(runId: string, step: StepId): Promise<GateRecord | null> {
    return Promise.resolve(this.records.get(this.key(runId, step)) ?? null);
  }

  markFired(runId: string, step: StepId, stepIds: readonly string[]): Promise<void> {
    const record = this.records.get(this.key(runId, step));
    if (record !== undefined) {
      this.records.set(this.key(runId, step), {
        ...record,
        firedStepIds: [...record.firedStepIds, ...stepIds],
      });
    }
    return Promise.resolve();
  }

  close(runId: string, step: StepId, at: string): Promise<void> {
    const record = this.records.get(this.key(runId, step));
    if (record !== undefined) this.records.set(this.key(runId, step), { ...record, closedAt: at });
    return Promise.resolve();
  }

  decisions(): Promise<GateDecision[]> {
    return Promise.resolve(this.closed);
  }
}

/** The three-step ladder the M88 default describes: 24h, 72h, 7d (delegate). */
export const LADDER: EscalationLadder = EscalationLadder.parse({
  steps: [
    { id: "s24", afterHours: 24, channel: "teams", event: "gate_reminder" },
    { id: "s72", afterHours: 72, channel: "teams", event: "escalation" },
    { id: "s168", afterHours: 168, channel: "teams", event: "escalation", action: "delegate" },
  ],
});

export const ROUTING: NotifyRouting = { default: ["teams"], byEvent: {} };
