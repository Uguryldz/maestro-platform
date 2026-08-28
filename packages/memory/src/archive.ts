import type { JournalEntry } from "@maestro/contracts";
import { MemoryArgumentError } from "./errors.js";
import { sessionArchiveKey } from "./session.js";

/** M65: a workspace idle for 60 days is removed from the runner's disk. */
export const WORKSPACE_MAX_IDLE_DAYS = 60;

const MS_PER_DAY = 86_400_000;

export interface ArchiveDecisionInput {
  readonly ticketKey: string;
  readonly runId: string;
  /** Last time anything happened on this ticket — usually the journal's tail. */
  readonly lastActivityAt: string;
  readonly now: string;
  readonly workspacePresent: boolean;
  /** Operator override (M71 parameter); defaults to 60. */
  readonly maxIdleDays?: number;
}

export type ArchiveDecision =
  | {
      readonly archive: false;
      readonly reason: "workspace_absent" | "within_idle_limit";
      readonly idleDays: number;
      readonly maxIdleDays: number;
    }
  | {
      readonly archive: true;
      readonly reason: "idle_limit_reached";
      readonly idleDays: number;
      readonly maxIdleDays: number;
      /** Where the session file belongs once the workspace is gone. */
      readonly sessionKey: string;
    };

function toMillis(what: string, iso: string): number {
  const millis = Date.parse(iso);
  if (Number.isNaN(millis)) throw new MemoryArgumentError(what, `not a date: ${iso}`);
  return millis;
}

/** Whole days between two instants; clock skew reads as 0, never as negative. */
export function idleDaysBetween(lastActivityAt: string, now: string): number {
  const elapsed = toMillis("now", now) - toMillis("lastActivityAt", lastActivityAt);
  return Math.max(0, Math.floor(elapsed / MS_PER_DAY));
}

/**
 * The journal's own answer to "when did anything last happen here?".
 *
 * By instant, not by `max(seq)` (verifier O-6): `JournalDraft.at` lets a
 * caller replay a recorded event at its own time, so the newest row can carry
 * an older timestamp than the row before it. Reading the tail seq would then
 * report a ticket worked on yesterday as idle for months and delete its
 * workspace. Ties fall back to the higher seq, which keeps the answer
 * deterministic.
 *
 * The run id is required and checked (verifier O-7): a caller that hands in a
 * mixed list would otherwise archive one run's workspace on another run's
 * silence.
 */
export function latestActivityAt(
  runId: string,
  entries: readonly JournalEntry[],
): string | null {
  let latest: JournalEntry | undefined;
  let latestMillis = -Infinity;
  for (const entry of entries) {
    if (entry.runId !== runId) {
      throw new MemoryArgumentError(
        "latestActivityAt",
        `entry #${entry.seq} belongs to ${entry.runId}, not ${runId}`,
      );
    }
    const millis = toMillis(`entry #${entry.seq}`, entry.at);
    if (latest === undefined || millis > latestMillis || (millis === latestMillis && entry.seq > latest.seq)) {
      latest = entry;
      latestMillis = millis;
    }
  }
  return latest?.at ?? null;
}

/**
 * Should this workspace be archived and deleted (M65)?
 *
 * A pure decision, so the janitor that acts on it is testable without a disk,
 * a clock or a bucket. It only ever says "delete the workspace" — the journal
 * and the session file are kept, which is precisely why the deletion costs no
 * context: what comes back is `buildBootstrapPackage`, and the ~5 minutes lost
 * are the clone and the build.
 */
export function decideWorkspaceArchive(input: ArchiveDecisionInput): ArchiveDecision {
  const maxIdleDays = input.maxIdleDays ?? WORKSPACE_MAX_IDLE_DAYS;
  if (!Number.isInteger(maxIdleDays) || maxIdleDays < 1) {
    throw new MemoryArgumentError("maxIdleDays", "must be a positive integer");
  }
  const idleDays = idleDaysBetween(input.lastActivityAt, input.now);
  if (!input.workspacePresent) {
    return { archive: false, reason: "workspace_absent", idleDays, maxIdleDays };
  }
  if (idleDays < maxIdleDays) {
    return { archive: false, reason: "within_idle_limit", idleDays, maxIdleDays };
  }
  return {
    archive: true,
    reason: "idle_limit_reached",
    idleDays,
    maxIdleDays,
    // The archive year comes from the last activity, not from today (verifier
    // D-12): 60 idle days regularly cross a new year, and a key minted from
    // `now` would land in a directory the resume path has no reason to scan.
    sessionKey: sessionArchiveKey({
      ticketKey: input.ticketKey,
      runId: input.runId,
      at: input.lastActivityAt,
    }),
  };
}
