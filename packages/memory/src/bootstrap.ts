import type { GateDecision, JournalEntry, LivingSummary } from "@maestro/contracts";
import { renderBlocks, type TextBlock } from "./blocks.js";
import type { JournalMasker } from "./masking.js";
import {
  compileProtectedPaths,
  DEFAULT_PROTECTED_PATHS,
  type ProtectedPathHit,
} from "./protected-paths.js";
import {
  reviewGateDecisions,
  type OpenRejection,
  type SuspectDecision,
} from "./rejections.js";
import { buildLivingSummary, type SummaryOptions } from "./summary.js";
import { clip, oneLine } from "./summary-format.js";
import type { Clock } from "./types.js";

/** Bootstrap text ceiling. Generous — this is a prompt, not a database column. */
export const BOOTSTRAP_MAX_CHARS = 16000;
/** A commit message or reviewer note is a sentence, not a pasted build log. */
export const MAX_NOTE_CHARS = 500;
const MAX_LISTED_FILES = 30;
const MAX_LISTED_REJECTIONS = 10;
const MAX_LISTED_PATTERNS = 40;
/** `buildLivingSummary` refuses to work below this, so never ask it to. */
const MIN_SUMMARY_CHARS = 400;
/** Section worth in the last-resort trim: the diff goes before the summary. */
const VALUE = { summary: 30, diff: 10 } as const;

export interface DiffSummaryInput {
  readonly sha?: string;
  readonly filesChanged: readonly string[];
  readonly insertions?: number;
  readonly deletions?: number;
  /** Free text (a commit message, a reviewer note) — masked before it is used. */
  readonly note?: string;
}

export interface DiffDigest {
  readonly sha?: string;
  readonly fileCount: number;
  readonly files: readonly string[];
  readonly insertions?: number;
  readonly deletions?: number;
  readonly note?: string;
}

export interface BootstrapInput {
  readonly runId: string;
  readonly ticketKey: string;
  /** Masked journal entries (whatever `appendJournal` wrote). */
  readonly entries: readonly JournalEntry[];
  readonly gateDecisions?: readonly GateDecision[];
  readonly lastDiff?: DiffSummaryInput;
  /** From `.maestro.yaml` (M71); defaults to the M52 built-ins. */
  readonly protectedPaths?: readonly string[];
  /** False after an M65 archive: the clone is gone, the context is not. */
  readonly workspacePresent: boolean;
  /** True when the Agent SDK session file could be restored (resume possible). */
  readonly sessionRestored?: boolean;
}

export interface BootstrapDeps {
  readonly masker: JournalMasker;
  readonly clock: Clock;
  readonly summary?: SummaryOptions;
  readonly maxChars?: number;
}

export interface BootstrapPackage {
  readonly runId: string;
  readonly ticketKey: string;
  readonly generatedAt: string;
  readonly upToSeq: number;
  readonly summary: LivingSummary;
  readonly openRejections: readonly OpenRejection[];
  /** Recorded decisions that failed their SoD check (M32) — never closers. */
  readonly suspectDecisions: readonly SuspectDecision[];
  readonly diff?: DiffDigest;
  readonly protectedPaths: readonly string[];
  readonly protectedPathHits: readonly ProtectedPathHit[];
  readonly workspacePresent: boolean;
  readonly sessionRestored: boolean;
  /** The masked, bounded text handed to the agent as its opening context. */
  readonly text: string;
}

function diffDigest(
  input: DiffSummaryInput,
  mask: (text: string) => string,
): { digest: DiffDigest; rawFiles: readonly string[] } {
  const files = input.filesChanged.map((file) => mask(file));
  return {
    rawFiles: input.filesChanged,
    digest: {
      ...(input.sha === undefined ? {} : { sha: input.sha }),
      fileCount: input.filesChanged.length,
      files,
      ...(input.insertions === undefined ? {} : { insertions: input.insertions }),
      ...(input.deletions === undefined ? {} : { deletions: input.deletions }),
      ...(input.note === undefined
        ? {}
        : { note: clip(mask(oneLine(input.note)), MAX_NOTE_CHARS) }),
    },
  };
}

function diffBlock(digest: DiffDigest): TextBlock {
  const counters = [
    digest.sha === undefined ? undefined : `sha ${digest.sha}`,
    `${digest.fileCount} file(s)`,
    digest.insertions === undefined ? undefined : `+${digest.insertions}`,
    digest.deletions === undefined ? undefined : `-${digest.deletions}`,
  ].filter((part): part is string => part !== undefined);
  const lines = [counters.join(" · ")];
  if (digest.note !== undefined) lines.push(`note: ${digest.note}`);
  for (const file of digest.files.slice(0, MAX_LISTED_FILES)) lines.push(`- ${file}`);
  if (digest.files.length > MAX_LISTED_FILES) {
    lines.push(`- (+${digest.files.length - MAX_LISTED_FILES} more files)`);
  }
  return {
    heading: () => "## last diff",
    lines,
    value: VALUE.diff,
    from: "tail",
    omitted: (dropped) => `(${dropped} further diff lines omitted)`,
  };
}

function rejectionBlock(rejections: readonly OpenRejection[]): TextBlock {
  const all = rejections.map(
    (item) => `step ${item.step} · ${item.at} · ${item.actorGroup}: ${item.reason}`,
  );
  // Newest first out of the printer, and what was left out is stated rather
  // than silently dropped (verifier O-11).
  const shown = all.slice(-MAX_LISTED_REJECTIONS);
  const dropped = all.length - shown.length;
  return {
    heading: () => "## open rejections (address these first)",
    lines: shown,
    // Guaranteed: what the agent still owes is the reason it was resumed.
    value: Infinity,
    ...(dropped === 0 ? {} : { note: `(${dropped} earlier open rejections omitted)` }),
  };
}

function suspectBlock(suspect: readonly SuspectDecision[]): TextBlock {
  return {
    heading: () => "## decisions that failed the SoD check (M32)",
    lines: suspect.map(
      (item) =>
        `step ${item.step} · ${item.at} · ${item.actorGroup}/${item.actorUserId}: ` +
        `${item.decision} NOT counted — separation of duties unverified`,
    ),
    value: Infinity,
  };
}

function protectedBlock(patterns: readonly string[], hits: readonly ProtectedPathHit[]): TextBlock {
  const lines = patterns.slice(0, MAX_LISTED_PATTERNS).map((pattern) => `- ${pattern}`);
  if (patterns.length > MAX_LISTED_PATTERNS) {
    lines.push(`- (+${patterns.length - MAX_LISTED_PATTERNS} more patterns)`);
  }
  if (hits.length > 0) {
    lines.push(
      `!! the last diff already touches protected paths: ${hits
        .map((hit) => `${hit.file} (${hit.pattern})`)
        .join(", ")}`,
    );
  }
  return {
    heading: () => "## protected paths (M52 — a diff here stops the flow)",
    lines,
    value: Infinity,
  };
}

function length(blocks: readonly TextBlock[]): number {
  return renderBlocks(blocks, Infinity).length;
}

/**
 * The context an agent is handed when a session is (re)opened — M30's third
 * leg and the whole point of M65.
 *
 * A workspace that has been idle for 60 days is deleted from disk; the journal
 * and the session file stay in the archive. This package is what makes that
 * deletion cheap: everything the agent needs to carry on — what happened, what
 * the last diff was, which gates rejected it and why, which paths it must not
 * touch — is rebuilt from the record, not from the missing clone. The only
 * thing lost is the ~5 minutes it takes to clone and build again.
 *
 * The sections an agent must never resume without — the two status lines, the
 * open rejections, the unverified signatures and the M52 protected paths — are
 * written first and are exempt from the budget (verifier Y-3: a single 40 000
 * character rejection reason used to push the protected-path warning out of
 * the text entirely). Only the summary and the diff give way, and both say so
 * when they do.
 */
export function buildBootstrapPackage(
  input: BootstrapInput,
  deps: BootstrapDeps,
): BootstrapPackage {
  const maxChars = deps.maxChars ?? BOOTSTRAP_MAX_CHARS;
  const mask = (text: string): string => deps.masker.text(text);
  const review = reviewGateDecisions(input.gateDecisions ?? [], mask);
  const protectedPaths = input.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const diff = input.lastDiff === undefined ? undefined : diffDigest(input.lastDiff, mask);

  // Matching runs on the real paths; only the reported copy is masked.
  const compiled = compileProtectedPaths(protectedPaths);
  const hits: ProtectedPathHit[] = [];
  for (const file of diff?.rawFiles ?? []) {
    const pattern = compiled.match(file);
    if (pattern !== undefined) hits.push({ file: mask(file), pattern });
  }

  const sessionRestored = input.sessionRestored ?? false;
  const guaranteed: TextBlock[] = [
    {
      lines: [
        `# bootstrap · ${input.ticketKey} · run ${input.runId}`,
        input.workspacePresent
          ? "workspace: present on the runner."
          : "workspace: ABSENT — the clone was removed after 60 days of inactivity (M65). " +
            "Recreate it from the repository; the context below is complete and nothing has been lost.",
        sessionRestored
          ? "session: restored from the archive — this is a continuation, not a fresh start."
          : "session: no agent session file available — start a new session from this context.",
      ],
      value: Infinity,
    },
  ];
  if (review.open.length > 0) guaranteed.push(rejectionBlock(review.open));
  if (review.suspect.length > 0) guaranteed.push(suspectBlock(review.suspect));
  guaranteed.push(protectedBlock(compiled.patterns, hits));

  // Whatever the guaranteed sections did not need is the summary's, less a
  // slice for the diff digest.
  const room = maxChars - length(guaranteed);
  const summaryBudget = Math.max(
    MIN_SUMMARY_CHARS,
    Math.floor(room * (diff === undefined ? 0.95 : 0.75)),
  );
  const summary = buildLivingSummary(input.runId, input.entries, {
    ...deps.summary,
    maxChars: Math.min(deps.summary?.maxChars ?? Infinity, summaryBudget),
    guard: deps.masker,
  });

  const blocks = [
    ...guaranteed,
    {
      heading: (): string => "## living summary",
      lines: summary.text.split("\n"),
      value: VALUE.summary,
      from: "tail" as const,
      omitted: (dropped: number): string => `(${dropped} further summary lines omitted)`,
    },
    ...(diff === undefined ? [] : [diffBlock(diff.digest)]),
  ];
  const text = renderBlocks(blocks, maxChars);

  // Every field a caller supplied was masked on its way in (the journal
  // entries by whoever wrote them). Re-masking the assembled text would
  // de-fang the tokens of *other* sessions — `[EMAIL_1.ab12]` would silently
  // become `EMAIL_1.ab12` and the reader would lose the fact that something
  // was removed there (verifier O-9). So the whole is verified, not re-masked.
  deps.masker.assertClean(text, "bootstrap");

  return {
    runId: input.runId,
    ticketKey: input.ticketKey,
    generatedAt: deps.clock.now(),
    upToSeq: summary.upToSeq,
    summary,
    openRejections: review.open,
    suspectDecisions: review.suspect,
    ...(diff === undefined ? {} : { diff: diff.digest }),
    protectedPaths: compiled.patterns,
    protectedPathHits: hits,
    workspacePresent: input.workspacePresent,
    sessionRestored,
    text,
  };
}
