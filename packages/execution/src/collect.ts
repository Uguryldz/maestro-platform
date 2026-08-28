import {
  compiledProfileFor,
  guardEgress,
  withPiiBoundary,
  type LoadedPiiPolicy,
  type OutboundCall,
  type PiiBoundaryResult,
} from "@maestro/pii";
import type { ProtectedPathViolation } from "./protected-paths.js";
import type { StrikeState } from "./strikes.js";
import type { ChangedFile, CommandResult, CommandSpec, DiffSummary, VerificationRunner } from "./types.js";

/**
 * What one agent session produced — the object the journal, the evidence
 * package and the Studio timeline are built from, so it holds facts and no
 * prose.
 */
export interface SessionReport {
  readonly runId: string;
  readonly ticketKey: string;
  /** M30: hand this back to `LlmPort.agentSession` to continue the session. */
  readonly resumeToken: string;
  readonly workspacePath: string;
  readonly finalText: string;
  readonly changedFiles: readonly ChangedFile[];
  readonly diff: DiffSummary;
  readonly commands: readonly CommandResult[];
  readonly protectedViolations: readonly ProtectedPathViolation[];
  readonly strikes: StrikeState | null;
  readonly at: string;
}

export function summarizeDiff(files: readonly ChangedFile[]): DiffSummary {
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    insertions += file.insertions;
    deletions += file.deletions;
  }
  return { files: files.length, insertions, deletions };
}

/**
 * Runs every command in order, failures included — it does NOT stop at the
 * first red, or the human taking the handover has to run the rest by hand.
 */
export async function runVerification(
  runner: VerificationRunner,
  workspacePath: string,
  specs: readonly CommandSpec[],
): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const spec of specs) {
    results.push(await runner.run(workspacePath, spec));
  }
  return results;
}

export function verificationFailures(results: readonly CommandResult[]): CommandResult[] {
  return results.filter((r) => r.exitCode !== 0);
}

export interface ReportJournalOptions<TOut> {
  /**
   * A policy that went through `loadPiiPolicy` (`defaultPiiPolicy()` already
   * has). The brand is the point: a hand-written literal skips every
   * fail-closed rule loading applies, and the journal is the one place that
   * must not be masked by a weakened profile.
   */
  readonly policy: LoadedPiiPolicy;
  /** Declared data class of the ticket; an unknown value falls to `gizli`. */
  readonly dataClass: unknown;
  /** Where the masked report goes (PG journal row + StoragePort body, M30). */
  readonly sink: OutboundCall<SessionReport, TOut>;
  readonly boundary?: string;
}

export const JOURNAL_BOUNDARY = "execution/session-report";

/**
 * M20/M82: the copy that is stored is the masked copy. `withPiiBoundary` is the
 * only way into the sink because the sink's parameter is `Masked<SessionReport>`
 * — a caller holding a raw report simply cannot call it, and the boundary runs
 * `assertNoPii` before the sink sees the payload, so a masker that missed
 * something raises `PiiLeakError` instead of writing an IBAN into the journal.
 * Command output is masked with the rest: a failing test that prints a customer
 * record is exactly how a diff summary leaks (v1's defect was a working masker
 * nobody called).
 *
 * The writer holds ONE masking session for its whole lifetime
 * (`sessionScope: "boundary"`). A journal is written turn after turn and read
 * back, and an agent quotes its own earlier — already masked — output; with a
 * session per call those tokens belong to no session, so the next pass strips
 * their brackets and the row stops recording that a value was removed there.
 * Keep one writer per run and per data class, which is what `AgentExecution`
 * does.
 *
 * The sink is additionally wrapped in `guardEgress`, so the tripwire sits at
 * the LAST hop before the journal rather than at this package's boundary. The
 * type alone (`Masked<SessionReport>`) stops a caller inside this package from
 * writing a raw report; it does nothing about the sink itself being handed a
 * payload that was sealed elsewhere, or about a masker that let something
 * through. `guardEgress` re-checks both, against the same compiled profile the
 * masker used, immediately before the row is written.
 */
export function createReportJournal<TOut>(
  opts: ReportJournalOptions<TOut>,
): (report: SessionReport) => Promise<PiiBoundaryResult<TOut>> {
  const boundary = opts.boundary ?? JOURNAL_BOUNDARY;
  return withPiiBoundary<SessionReport, TOut>(
    { policy: opts.policy, dataClass: opts.dataClass, boundary, sessionScope: "boundary" },
    guardedJournalSink(opts),
  );
}

/**
 * The last hop before the row is written. Split out from `createReportJournal`
 * so the tripwire is reachable on its own: it is the half that has to hold when
 * something OTHER than this package's boundary produced the payload.
 */
export function guardedJournalSink<TOut>(opts: ReportJournalOptions<TOut>): OutboundCall<SessionReport, TOut> {
  const boundary = opts.boundary ?? JOURNAL_BOUNDARY;
  const { profile } = compiledProfileFor(opts.policy, opts.dataClass);
  return guardEgress<SessionReport, TOut>({ profile, boundary: `${boundary} (egress)` }, opts.sink);
}
