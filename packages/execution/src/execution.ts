import type { DataClass } from "@maestro/contracts";
import type { LoadedPiiPolicy, OutboundCall, PiiBoundaryResult } from "@maestro/pii";
import type { LlmPort } from "@maestro/ports";
import { type BootstrapContext, type BootstrapLimits, composeTurnPrompt } from "./bootstrap.js";
import { ciFingerprint } from "./ci-fingerprint.js";
import { createReportJournal, runVerification, type SessionReport, summarizeDiff, verificationFailures } from "./collect.js";
import { DataClassChangedError, WorkspaceProbeError } from "./errors.js";
import { createProtectedPathMatcher, findProtectedViolations, type ProtectedPathViolation } from "./protected-paths.js";
import { handoverDecision, type HandoverDecision, type StrikeKey, type StrikeLedgerPort, type StrikeState } from "./strikes.js";
import type { ChangedFile, CommandResult, CommandSpec, VerificationRunner, WorkspaceProbe } from "./types.js";

export interface AgentTurnRequest {
  readonly context: BootstrapContext;
  readonly dataClass: DataClass;
  readonly variantId: string;
  /** Present → resume (no bootstrap is re-sent), absent → new session (M30). */
  readonly resumeToken?: string;
  readonly verification: readonly CommandSpec[];
}

export type FailureReason = "protected_path" | "verification";

export type AgentTurnResult =
  | { readonly status: "ok"; readonly report: SessionReport }
  | {
      readonly status: "failed";
      readonly reason: FailureReason;
      readonly report: SessionReport;
      readonly handover: HandoverDecision;
    }
  | { readonly status: "queued"; readonly resumeAt: string }
  | { readonly status: "degraded"; readonly messageKey: string }
  | { readonly status: "blocked"; readonly messageKey: string };

/**
 * The two collaborators that are bound to ONE turn's workspace and signal.
 *
 * Passed to `runTurn` rather than held on the instance so a runner can build
 * them per turn — a probe carries the run's workspace volume and the
 * `AbortSignal` a `stop_all` fires, and one built at construction would hold
 * the first run's copy of both. Omitted, the instance's own are used, which is
 * what every in-memory test does.
 */
export interface TurnCollaborators {
  readonly probe: WorkspaceProbe;
  readonly verifier: VerificationRunner;
}

export interface AgentExecutionDeps {
  readonly llm: LlmPort;
  readonly probe: WorkspaceProbe;
  readonly verifier: VerificationRunner;
  readonly strikes: StrikeLedgerPort;
  /** Must have been through `loadPiiPolicy` — `defaultPiiPolicy()` has. */
  readonly piiPolicy: LoadedPiiPolicy;
  /** Masked report sink (journal row + StoragePort body). */
  readonly journalSink: OutboundCall<SessionReport, unknown>;
  readonly now: () => Date;
  readonly bootstrapLimits?: BootstrapLimits;
  /**
   * How many runs may hold an open journal writer at once. Each writer keeps a
   * masking session — and with it a ReverseMap of real values — alive, so this
   * is a memory-of-secrets bound, not a performance knob.
   */
  readonly maxOpenRuns?: number;
}

type JournalWriter = (report: SessionReport) => Promise<PiiBoundaryResult<unknown>>;

interface RunJournal {
  readonly dataClass: DataClass;
  readonly write: JournalWriter;
}

export const DEFAULT_MAX_OPEN_RUNS = 8;

/**
 * One doing-role turn, end to end: bootstrap or resume → agent session →
 * protected-path gate → verification → masked journal write → strike/handover.
 * The order matters: M52 stops the flow on a protected diff, and a green build
 * on top of an illegal change would read like an endorsement of it.
 */
export class AgentExecution {
  /**
   * One journal writer — and therefore one masking session — per RUN.
   *
   * Per run, not per data class: the writer's session is the token vocabulary,
   * and its ReverseMap holds the real values behind every token it minted. Two
   * tickets that happen to share a data class used to share the writer, so
   * ticket A's IBAN and ticket B's got the same token in their journals — and
   * A's real values stayed reachable, in memory, for as long as B kept running.
   */
  private readonly journals = new Map<string, RunJournal>();

  constructor(private readonly deps: AgentExecutionDeps) {}

  async runTurn(req: AgentTurnRequest, turn?: TurnCollaborators): Promise<AgentTurnResult> {
    const ctx = req.context;
    const probe = turn?.probe ?? this.deps.probe;
    const verifier = turn?.verifier ?? this.deps.verifier;
    const isResume = req.resumeToken !== undefined;
    const outcome = await this.deps.llm.agentSession({
      workspacePath: ctx.workspace.path,
      task: composeTurnPrompt(ctx, isResume, this.deps.bootstrapLimits),
      mcpServers: [...ctx.mcpServers],
      dataClass: req.dataClass,
      variantId: req.variantId,
      ...(req.resumeToken === undefined ? {} : { resumeToken: req.resumeToken }),
    });

    switch (outcome.status) {
      case "queued":
        return { status: "queued", resumeAt: outcome.resumeAt };
      case "degraded":
        return { status: "degraded", messageKey: outcome.messageKey };
      case "blocked":
        return { status: "blocked", messageKey: outcome.messageKey };
      case "ok":
        break;
    }

    const changed = await this.inspect(probe, ctx.workspace.path);
    // The repo's list only ever ADDS to the M52 floor — see
    // `DEFAULT_PROTECTED_PATHS`. An empty list means "nothing extra", never
    // "nothing at all".
    const violations = findProtectedViolations(changed, createProtectedPathMatcher(ctx.protectedPaths));
    // M52 is fail-closed: stop here, do not spend a build on an illegal diff.
    const commands =
      violations.length > 0 ? [] : await runVerification(verifier, ctx.workspace.path, req.verification);
    const verdict = this.judge(ctx.runId, violations, commands);

    const report: SessionReport = {
      runId: ctx.runId,
      ticketKey: ctx.ticketKey,
      resumeToken: outcome.value.resumeToken,
      workspacePath: ctx.workspace.path,
      finalText: outcome.value.finalText,
      changedFiles: changed,
      diff: summarizeDiff(changed),
      commands,
      protectedViolations: violations,
      strikes: verdict?.state ?? null,
      at: this.deps.now().toISOString(),
    };
    await this.publish(report, req.dataClass);

    if (verdict === null) return { status: "ok", report };
    // A handover ends the run's AI-led life; nothing more will be journalled
    // under it, so its masking session (and its ReverseMap) goes now.
    if (verdict.handover.handover) this.endRun(ctx.runId);
    return { status: "failed", reason: verdict.reason, report, handover: verdict.handover };
  }

  /**
   * Drops a run's journal writer, and with it the map of real values behind its
   * tokens. Wave 3's workflow calls this when a ticket leaves the doing role;
   * a handover calls it on its own.
   */
  endRun(runId: string): void {
    this.journals.delete(runId);
  }

  /**
   * Everything the session left behind, INCLUDING `.git/` — which `git status`
   * cannot report on, so a probe that only ran `git status` would hand the M52
   * gate a clean sheet while `.git/hooks/post-checkout` sat there waiting to
   * run on the bank's own runner.
   */
  private async inspect(probe: WorkspaceProbe, workspacePath: string): Promise<readonly ChangedFile[]> {
    try {
      const [tracked, internal] = await Promise.all([
        probe.changedFiles(workspacePath),
        probe.internalChangedFiles(workspacePath),
      ]);
      return [...tracked, ...internal];
    } catch (cause) {
      throw new WorkspaceProbeError(workspacePath, cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Records a strike (or clears the run's) and returns why the turn failed. */
  private judge(
    runId: string,
    violations: readonly ProtectedPathViolation[],
    commands: readonly CommandResult[],
  ): { reason: FailureReason; state: StrikeState; handover: HandoverDecision } | null {
    if (violations.length > 0) {
      const key: StrikeKey = { runId, scope: "agent", ref: "protected_path" };
      const state = this.deps.strikes.record(key, violations.map((v) => `${v.path} (${v.pattern})`).join(", "));
      return { reason: "protected_path", state, handover: handoverDecision(state) };
    }
    const failures = verificationFailures(commands);
    if (failures.length > 0) {
      const ref = ciFingerprint(
        failures.map((f) => ({ name: f.name, exitCode: f.exitCode, output: `${f.stderrTail}\n${f.stdoutTail}` })),
      );
      const key: StrikeKey = { runId, scope: "ci", ref };
      const state = this.deps.strikes.record(key, failures.map((f) => `${f.name} exited ${f.exitCode}`).join(", "));
      return { reason: "verification", state, handover: handoverDecision(state) };
    }
    this.deps.strikes.clear({ runId, scope: "agent", ref: "protected_path" });
    return null;
  }

  private async publish(report: SessionReport, dataClass: DataClass): Promise<void> {
    const existing = this.journals.get(report.runId);
    if (existing !== undefined) {
      if (existing.dataClass !== dataClass) {
        throw new DataClassChangedError(report.runId, existing.dataClass, dataClass);
      }
      // Refresh recency so the LRU below evicts genuinely idle runs.
      this.journals.delete(report.runId);
      this.journals.set(report.runId, existing);
      await existing.write(report);
      return;
    }

    const entry: RunJournal = {
      dataClass,
      write: createReportJournal({ policy: this.deps.piiPolicy, dataClass, sink: this.deps.journalSink }),
    };
    this.journals.set(report.runId, entry);
    this.evictIdleRuns();
    await entry.write(report);
  }

  /** Insertion order is recency order; the oldest run's secrets go first. */
  private evictIdleRuns(): void {
    const limit = this.deps.maxOpenRuns ?? DEFAULT_MAX_OPEN_RUNS;
    while (this.journals.size > limit) {
      const oldest = this.journals.keys().next();
      if (oldest.done === true) return;
      this.journals.delete(oldest.value);
    }
  }
}
