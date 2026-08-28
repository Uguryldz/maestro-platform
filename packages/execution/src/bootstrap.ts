import type { JournalEntry, LivingSummary } from "@maestro/contracts";
import { createProtectedPathMatcher } from "./protected-paths.js";

/**
 * M30, "context is never lost". A doing role gets its history exactly once:
 *  · a NEW session is opened with the ticket journal + the living summary +
 *    the state of the working copy as its first context;
 *  · a RESUMED session gets the task only — the vendor session already holds
 *    everything, and re-sending it would cost quota and contradict the
 *    transcript the model is continuing from.
 * Pure: no clock, no filesystem, no model. Wave 3 assembles the inputs.
 */
export interface WorkspaceState {
  readonly path: string;
  /** False when the sandbox is fresh — M30's "no workspace, bootstrap instead". */
  readonly present: boolean;
  readonly branch: string | null;
  readonly baseSha: string | null;
  /** Files already dirty before this turn (a previous turn's work). */
  readonly dirtyFiles: readonly string[];
}

export interface BootstrapContext {
  readonly ticketKey: string;
  readonly runId: string;
  readonly task: string;
  /** Ticket ledger, oldest first. Trimmed to the newest entries if long. */
  readonly journal: readonly JournalEntry[];
  readonly livingSummary: LivingSummary | null;
  readonly workspace: WorkspaceState;
  /** The repo's ADDITIONS to the M52 deny-list; the prompt shows the effective
   * list (platform floor included) so the agent is told before it is judged. */
  readonly protectedPaths: readonly string[];
  readonly mcpServers: readonly string[];
}

export interface BootstrapLimits {
  readonly maxJournalEntries: number;
  readonly maxDetailChars: number;
  readonly maxDirtyFiles: number;
}

export const DEFAULT_BOOTSTRAP_LIMITS: BootstrapLimits = {
  maxJournalEntries: 40,
  maxDetailChars: 600,
  maxDirtyFiles: 50,
};

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} chars trimmed]`;
}

function list(items: readonly string[], max: number): string {
  if (items.length === 0) return "  (none)";
  const shown = items.slice(0, max).map((i) => `  - ${i}`);
  if (items.length > max) shown.push(`  - … and ${items.length - max} more`);
  return shown.join("\n");
}

function journalSection(entries: readonly JournalEntry[], limits: BootstrapLimits): string {
  if (entries.length === 0) return "  (empty — this is the first thing that ever happened on this ticket)";
  const trimmed = entries.slice(-limits.maxJournalEntries);
  const skipped = entries.length - trimmed.length;
  const head = skipped > 0 ? [`  (${skipped} older entries omitted; the living summary above covers them)`] : [];
  return [
    ...head,
    ...trimmed.map((e) => {
      const detail = e.detail === "" ? "" : `\n      ${clip(e.detail, limits.maxDetailChars)}`;
      return `  #${e.seq} [${e.at}] ${e.actor}/${e.kind}: ${e.title}${detail}`;
    }),
  ].join("\n");
}

function workspaceSection(ws: WorkspaceState, limits: BootstrapLimits): string {
  if (!ws.present) {
    return [
      `  path: ${ws.path}`,
      "  state: NOT PRESENT — the sandbox is fresh. Nothing from a previous turn",
      "  survives on disk, so the journal and the summary above are the whole context.",
    ].join("\n");
  }
  return [
    `  path: ${ws.path}`,
    `  branch: ${ws.branch ?? "(detached)"}`,
    `  base commit: ${ws.baseSha ?? "(unknown)"}`,
    "  already-modified files:",
    list(ws.dirtyFiles, limits.maxDirtyFiles),
  ].join("\n");
}

/** The first-turn context block. English because it is a model prompt, not a
 * user-facing string — M104 governs what humans read, not this. */
export function buildSessionBootstrap(
  ctx: BootstrapContext,
  limits: BootstrapLimits = DEFAULT_BOOTSTRAP_LIMITS,
): string {
  const summary =
    ctx.livingSummary === null
      ? "  (none yet)"
      : `  (covers journal entries up to #${ctx.livingSummary.upToSeq})\n  ${ctx.livingSummary.text}`;

  // The EFFECTIVE list, not just the repo's additions: the gate judges against
  // the platform floor too, and a rule the agent was never shown is a trap.
  const protectedPaths = createProtectedPathMatcher(ctx.protectedPaths).patterns;

  return [
    `# Session bootstrap — ticket ${ctx.ticketKey}, run ${ctx.runId}`,
    "",
    "You are continuing work that already has a history. Everything below is that",
    "history; it is given once, at the start of this session, and will not be",
    "repeated on later turns of the same session.",
    "",
    "## Living summary",
    summary,
    "",
    "## Ticket journal (append-only, oldest first)",
    journalSection(ctx.journal, limits),
    "",
    "## Workspace",
    workspaceSection(ctx.workspace, limits),
    "",
    "## Protected paths — do not modify (M52)",
    list(protectedPaths, protectedPaths.length),
    "  A change under any of these fails the session and hands the ticket to a human.",
    "  Renaming a file into or out of one counts as changing it.",
    "  If the task cannot be done without touching one, say so instead of doing it.",
    "",
    "## Tools",
    "  These MCP servers are configured for this session:",
    list(ctx.mcpServers, ctx.mcpServers.length),
    "",
    "## Task",
    ctx.task,
    "",
  ].join("\n");
}

/**
 * What goes to the model this turn. The resume branch is not an optimisation:
 * re-sending the bootstrap would tell a model that already remembers the
 * ticket that it is starting over.
 */
export function composeTurnPrompt(
  ctx: BootstrapContext,
  isResume: boolean,
  limits: BootstrapLimits = DEFAULT_BOOTSTRAP_LIMITS,
): string {
  return isResume ? ctx.task : buildSessionBootstrap(ctx, limits);
}
