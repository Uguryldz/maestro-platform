import type { WorkflowHandle } from "@temporalio/client";
import type {
  AnalysisDoc,
  CiResultSignal,
  FlowType,
  GateDecision,
  RiskTier,
  ScanResult,
  StepId,
} from "@maestro/contracts";
import type { MaestroActivities, StatusMoveRequest, StatusMoveResult } from "../src/activities.js";
import { clarificationAnsweredSignal, gateDecisionSignal } from "../src/signals.js";
import type { TicketStatusMap, TicketWorkflowInput } from "../src/ticket-workflow.js";

/**
 * The world one workflow run happens in: the fixtures it is fed, the record of
 * what it asked for, and the stubs that answer it.
 *
 * Everything real is a stub, which is the point: with no I/O in the way the
 * time-skipping server runs sixteen days of waiting in milliseconds, and the
 * assertions are about the FLOW — which gate opened, which step it went back
 * to, which session it resumed — not about any adapter.
 */

export const TICKET = "PAY-101";
export const REPO = { adoProject: "BANK", adoRepo: "pay" } as const;

export function analysisDoc(risk: RiskTier): AnalysisDoc {
  return {
    templateVersion: "analysis@1.0.0",
    language: "tr",
    purpose: "ödeme akışında hata düzeltmesi",
    scope: { included: ["pay-api"], excluded: [] },
    impactMatrix: [{ appId: "pay", impacted: true, summary: "ana repo", source: "primary_repo_discovery" }],
    acceptanceCriteria: ["hata tekrarlanmıyor"],
    uiApiChanges: "yok",
    testApproach: "birim + entegrasyon",
    riskAndRollback: { risk: "düşük", mitigation: "feature flag", rollback: "revert" },
    riskTier: risk,
    riskReason: "sınırlı kapsam",
    clarificationsUsed: [],
  };
}

export function approval(step: StepId, over: Partial<GateDecision> = {}): GateDecision {
  const group = step === "4" ? "product-owners" : step === "9" || step === "11" ? "qa" : "tech-leads";
  return {
    step,
    decision: "approve",
    actorUserId: `${group}-${step}@bank`,
    actorGroup: group,
    sodVerified: true,
    signatureSeq: 1,
    source: "jira",
    at: "2026-08-09T09:00:00+03:00",
    ...over,
  } as GateDecision;
}

export function ciSignal(over: Partial<CiResultSignal> = {}): CiResultSignal {
  return {
    ticketKey: TICKET,
    ...REPO,
    prId: 77,
    buildId: 1001,
    status: "succeeded",
    finishedAt: "2026-08-09T10:00:00+03:00",
    ...over,
  };
}

/** A clean run of the mandatory trio (M27). */
export const PASS_SCAN: ScanResult = {
  tool: "gitleaks",
  imageDigest: "sha256:aa",
  startedAt: "2026-08-09T09:00:00+03:00",
  finishedAt: "2026-08-09T09:00:01+03:00",
  findings: [],
  outcome: "pass",
};

/** What a gate does when it opens: approve at once, wait, or reject first. */
export type GatePolicy =
  | { kind: "approve" }
  | { kind: "approve_after_hours"; hours: number }
  | { kind: "reject_once"; reason: string }
  /** Rejects on every visit — the M54 counter's test subject. */
  | { kind: "reject_always"; reason: string }
  /**
   * Two decisions delivered back to back, before the workflow has processed the
   * first. A real Jira user typing `/approve` and then `/reject` produces this,
   * and so does a webhook batch.
   */
  | { kind: "burst"; decisions: readonly GateDecision[] };

export interface ScenarioOptions {
  risk?: RiskTier;
  /** What the listening rule asked for; absent is the full pipeline. */
  flow?: FlowType;
  /**
   * The run's application. Absent means the fixture default (`"pay"`), which
   * is what every scenario written before analysis-only bindings expects;
   * `null` OMITS the field from the start input — the shape intake produces
   * for an analysis-only binding — so a scenario can prove what the workflow
   * does when there is genuinely no repository.
   */
  appId?: string | null;
  /**
   * The rule's Jira status map ("durum eşlemesi"). Absent is comment-only mode
   * — the ticket is never moved — which is what every scenario written before
   * the map existed expects, and what `scenario.moves` then proves stayed true.
   */
  statusMap?: TicketStatusMap;
  /**
   * What the driver answers for a given move. Defaults to a clean `moved:true`.
   * A scenario returns `{moved:false, reason:"forbidden"}` to exercise the
   * warn-but-continue policy — the run must finish anyway.
   */
  statusMove?: (move: StatusMoveRequest) => StatusMoveResult;
  mode?: TicketWorkflowInput["mode"];
  gate?: (step: StepId, visit: number) => GatePolicy;
  /**
   * Decisions sent the moment the workflow ANNOUNCES it is heading for a gate
   * (the `adım <step>` journal line), which happens before `openGate` runs.
   *
   * This is the race a Jira comment wins routinely: the approver is already
   * looking at the ticket and answers as the gate is being opened. A stub that
   * can only speak from inside `openGate` can never reproduce it, so a workflow
   * that drops early decisions would look correct forever.
   */
  earlyDecision?: (step: StepId, visit: number) => GateDecision | null;
  /** Lets a scenario make the directory refuse a decision (gate stays open). */
  directory?: (decision: GateDecision) => { accepted: true } | { accepted: false; reason: string };
  /**
   * User ids that are master admins (four-eyes group). A member may sign both
   * sides of the cross-gate four-eyes rule; everyone else still needs a second
   * person. Empty by default, so the strict rule holds unless a scenario opts in.
   */
  masterAdmins?: ReadonlySet<string>;
  /**
   * The build-validation results the CI gate will be given, in order. The last
   * one is repeated once the queue runs dry, which is what a real pipeline does
   * too: it reports the branch's current state every time it is asked.
   */
  ci?: readonly Partial<CiResultSignal>[];
  /**
   * Whether the reporter eventually answers the step 2b question.
   *
   * The 2b wait is UNBOUNDED by design (M61) — nothing auto-rejects and nothing
   * times out into a decision — so a scenario that puts a run there and never
   * answers hangs until the driver's turn ceiling, which is a stuck test rather
   * than a failed assertion. Answering from the stub is the reporter typing
   * their reply; `false` is what a test asking "does it really wait?" wants.
   */
  answerClarification?: boolean;
}

/** Records what the workflow asked for, and drives it through its stubs. */
export class Scenario {
  readonly opened: StepId[] = [];
  /**
   * Every board move the workflow ASKED for, in order.
   *
   * Recording the requests rather than the results is what makes "a run with no
   * status map attempts no transition" assertable: an empty array proves the
   * workflow never scheduled the activity at all, which is a stronger claim
   * than "the activity decided to do nothing".
   */
  readonly moves: StatusMoveRequest[] = [];
  /** Set when the `analiz` flow handed the analysis back to the requester. */
  delivered = false;
  /**
   * Every discovery the workflow SCHEDULED, by appId. Recording the requests
   * (like `moves`) is what makes "a run with no application never asks for
   * discovery" assertable: an empty array proves the activity was never
   * scheduled, which is a stronger claim than a stub deciding to do nothing.
   */
  readonly discoveries: string[] = [];
  readonly escalations: Array<{ step: StepId; hours: number }> = [];
  readonly journal: Array<{ kind: string; title: string; detail: string }> = [];
  readonly engineering: Array<{ resumeToken: string | null; task: string }> = [];
  readonly decisions: GateDecision[] = [];
  readonly handovers: string[] = [];
  readonly ciSignals: CiResultSignal[] = [];
  readonly visits = new Map<StepId, number>();
  /** Visits counted for the pre-gate hook, kept apart from `visits`. */
  readonly earlyVisits = new Map<StepId, number>();
  handle: WorkflowHandle | null = null;
  /** True while the run is parked at 10b waiting for a build result. */
  ciGateOpen = false;
  private consumedCi = 0;
  /** Which build index the driver has already sent; -1 = nothing sent yet. */
  private sentForBuild = -1;
  private readonly ciQueue: CiResultSignal[];

  constructor(readonly options: ScenarioOptions = {}) {
    this.ciQueue = (options.ci ?? [{}]).map((over) => ciSignal(over));
  }

  /**
   * The build result the pipeline is currently reporting.
   *
   * The queue only advances when the workflow has actually LOOKED at the
   * current result (`verifyCiOrigin` is its only way of doing so). Advancing on
   * send instead would let the pipeline push the next result over one the
   * workflow never saw — and the rejected-foreign-signal case would silently
   * stop being tested.
   */
  nextCi(): CiResultSignal {
    const index = Math.min(this.consumedCi, this.ciQueue.length - 1);
    const signal = this.ciQueue[index] ?? ciSignal();
    this.ciSignals.push(signal);
    return signal;
  }

  noteCiConsumed(): void {
    this.consumedCi += 1;
  }

  /**
   * One send per build. The latch re-arms only when a NEW build result becomes
   * current (the workflow looked at the last one and asked engineering for a
   * fix), which is precisely when a real pipeline would run again and report.
   */
  takeCiSend(): boolean {
    if (this.sentForBuild === this.consumedCi) return false;
    this.sentForBuild = this.consumedCi;
    return true;
  }

  get risk(): RiskTier {
    return this.options.risk ?? "dusuk";
  }

  policy(step: StepId): GatePolicy {
    const visit = (this.visits.get(step) ?? 0) + 1;
    this.visits.set(step, visit);
    return this.options.gate?.(step, visit) ?? { kind: "approve" };
  }

  async signal(decision: GateDecision): Promise<void> {
    await this.handle?.signal(gateDecisionSignal, decision);
  }

  /**
   * Fires the pre-gate hook for a step the workflow has just announced.
   * Returns whether anything was sent, so the caller can tell "nobody answered
   * early" from "an early answer was delivered and then lost".
   */
  async signalEarly(step: StepId): Promise<boolean> {
    const visit = (this.earlyVisits.get(step) ?? 0) + 1;
    this.earlyVisits.set(step, visit);
    const decision = this.options.earlyDecision?.(step, visit) ?? null;
    if (decision === null) return false;
    await this.signal(decision);
    return true;
  }
}

export function makeActivities(
  scenario: Scenario,
  overrides: Partial<MaestroActivities> = {},
): MaestroActivities {
  const base: MaestroActivities = {
    resolveWorkMode: async () => ({ mode: "full_auto", dataClass: "dahili" }),
    matchApplication: async () => ({ via: "rule", ruleId: "r1", appId: "pay" }),
    runIntake: async () => ({ complete: true }),
    /**
     * The reporter, answering. Sent from HERE rather than from the driver loop
     * because this is the moment the question actually reaches them — the
     * workflow's `condition` is armed the instant this activity returns, and a
     * signal sent any earlier would be testing a race instead of the flow.
     */
    askClarification: async () => {
      if (scenario.options.answerClarification !== true) return;
      await scenario.handle?.signal(clarificationAnsweredSignal, {
        ticketKey: TICKET,
        answeredBy: "reporter@bank",
        text: "prod ortamı",
        at: "2026-08-09T09:30:00+03:00",
      });
    },
    discoverRepo: async (_ticket, appId) => {
      scenario.discoveries.push(appId);
      return { files: 12, modules: ["pay-core"] };
    },
    writeAnalysis: async () => ({ analysis: analysisDoc(scenario.risk), risk: scenario.risk }),
    publishAnalysis: async () => {},
    fanOutChildren: async () => [],

    // Answers with the ownerGroup it was given: these scenarios run on a
    // directory whose groups carry the role names, which is the no-mapping case.
    openGate: async (_ticket, step, ownerGroup) => {
      scenario.opened.push(step);
      const policy = scenario.policy(step);
      if (policy.kind === "approve") await scenario.signal(approval(step));
      if (policy.kind === "reject_once" || policy.kind === "reject_always") {
        await scenario.signal({ ...approval(step), decision: "reject", reason: policy.reason });
      }
      if (policy.kind === "burst") {
        // Deliberately NOT awaited one-by-one with a gap: the point is that both
        // land before the workflow gets a chance to process either.
        for (const decision of policy.decisions) await scenario.signal(decision);
      }
      return ownerGroup;
    },
    recordGateDecision: async (_ticket, decision) => {
      scenario.decisions.push(decision);
      // The directory accepts by default; a scenario can refuse to exercise the
      // "gate stays open, run survives" path.
      return scenario.options.directory?.(decision) ?? { accepted: true as const };
    },
    // No user is a master admin by default, so the strict four-eyes rule holds
    // in every existing scenario. A scenario opts a user in via `masterAdmins`.
    isMasterApprover: async (userId) => scenario.options.masterAdmins?.has(userId) ?? false,
    escalateGate: async (_ticket, step, waitingHours) => {
      scenario.escalations.push({ step, hours: waitingHours });
      const policy = scenario.options.gate?.(step, scenario.visits.get(step) ?? 1) ?? { kind: "approve" };
      // Reminders NEVER decide (M88); this only simulates the human who
      // eventually reacts to one of them.
      if (policy.kind === "approve_after_hours" && waitingHours >= policy.hours) {
        await scenario.signal(approval(step));
      }
      return null;
    },

    runEngineering: async (_ticket, resumeToken, task) => {
      scenario.engineering.push({ resumeToken, task });
      return { ok: true, resumeToken: resumeToken ?? "session-1", changedFiles: 3, diffSummary: "+30 -4" };
    },
    runScans: async () => [PASS_SCAN],
    reviewDiff: async () => ({ approved: true, findings: [] }),
    designTests: async () => ({ scenarios: 6 }),
    reviewTests: async () => ({ approved: true, findings: [] }),
    runTests: async () => ({ passed: true, total: 42, failed: 0, coveragePct: 88 }),

    openPullRequest: async () => ({ ...REPO, prId: 77 }),
    activatePullRequest: async () => {},
    verifyCiOrigin: async (_ticket, signal) => {
      scenario.noteCiConsumed();
      const ok = signal.adoProject === REPO.adoProject && signal.adoRepo === REPO.adoRepo;
      // Only an accepted GREEN build lets the workflow leave 10b, so that is
      // the only thing that stops the pipeline from reporting again.
      if (ok && signal.status === "succeeded") scenario.ciGateOpen = false;
      return ok;
    },
    mergePullRequest: async () => ({ mergeSha: "abcdef1" }),
    buildEvidencePackage: async () => ({ files: 4, storageKey: "evidence/2026/PAY-101/run/manifest.json" }),
    deliverAnalysis: async () => {
      scenario.delivered = true;
    },
    closeTicket: async () => {},

    /**
     * The board move, as the real activity behaves: it NEVER rejects. A
     * scenario that wants a refusal returns `moved:false` with a reason, and
     * the run must still reach `done` — that is the warn-but-continue policy
     * under test, and a stub that threw would test the opposite.
     */
    moveTicketStatus: async (_ticket, move) => {
      scenario.moves.push(move);
      const answer = scenario.options.statusMove?.(move);
      if (answer !== undefined) return answer;
      return { moved: move.status !== undefined, reassigned: move.toReporter === true };
    },

    journal: async (_ticket, kind, title, detail) => {
      scenario.journal.push({ kind, title, detail });
      // The workflow announces the step it has moved to; 10b is where a build
      // result is expected, and a re-entry after 12b opens the gate again.
      if (title === "adım 10b") scenario.ciGateOpen = true;
      // The announcement is the last thing before `openGate`, which is what
      // makes it the seam an early decision can be delivered through.
      const announced = title.startsWith("adım ") ? (title.slice(5) as StepId) : null;
      if (announced !== null && scenario.options.earlyDecision !== undefined) {
        await scenario.signalEarly(announced);
      }
    },
    handOverToHuman: async (_ticket, reason) => {
      scenario.handovers.push(reason);
    },
  };
  return { ...base, ...overrides };
}
