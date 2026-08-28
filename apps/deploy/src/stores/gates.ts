import { GateDecision, type AuditAction, type StepId } from "@maestro/contracts";
import type { GateRecord, GateStore } from "@maestro/workflows";

/**
 * The Postgres-backed `GateStore` (M88).
 *
 * Two things make this more than a table wrapper:
 *
 *  1. `open` is idempotent at the DATABASE level, not in a read-then-write.
 *     `openedAt` is the escalation ladder's anchor, so a duplicated signal
 *     that moved it would silently restart the ladder on a gate that has been
 *     waiting three days.
 *  2. `decisions` does not read a decisions table, because there is no such
 *     table and there must not be. A gate decision's `signatureSeq` IS the seq
 *     of the audit record it produced (M33), so the audit chain is the only
 *     place a signed approval can honestly come from — a second copy would be
 *     a second answer to "who approved this", and the copy is the one that
 *     cannot be verified.
 */

/** The `Gate` row as read back. */
export interface GateRow {
  runId: string;
  step: string;
  ownerGroup: string;
  openedAt: Date;
  firedStepIds: string[];
  closedAt: Date | null;
}

export interface GateDelegate {
  findUnique(args: {
    where: { runId_step: { runId: string; step: string } };
  }): Promise<GateRow | null>;
  update(args: {
    where: { runId_step: { runId: string; step: string } };
    data: { firedStepIds?: { push: string[] }; closedAt?: Date };
  }): Promise<unknown>;
}

/**
 * The insert half of `open`, kept behind a seam.
 *
 * Prisma's query builder cannot express `ON CONFLICT DO NOTHING` on a composite
 * key (that is the whole of K-1), so this one statement is raw SQL — and raw
 * SQL is exactly what the offline suite must be able to substitute, which is
 * why it is an interface rather than a private method.
 */
export interface GateClaim {
  /** Inserts the gate if `(runId, step)` is free. Resolves either way. */
  insertIfAbsent(runId: string, step: string, ownerGroup: string, openedAt: Date): Promise<void>;
}

/**
 * `GateClaim` over raw SQL — the same statement shape as `sqlClaimExecutor`.
 *
 * `firedStepIds` is written as an explicit empty `text[]`: the column is NOT
 * NULL with no default, and a gate is born with no ladder step fired.
 *
 * Values go through `$1..$5`, so a step id never reaches the SQL text.
 */
export function sqlGateClaim(sql: {
  query<R>(text: string, params: readonly unknown[]): Promise<R[]>;
}): GateClaim {
  return {
    async insertIfAbsent(
      runId: string,
      step: string,
      ownerGroup: string,
      openedAt: Date,
    ): Promise<void> {
      await sql.query(
        `INSERT INTO "Gate" ("runId", "step", "ownerGroup", "openedAt", "firedStepIds", "closedAt")
         VALUES ($1, $2, $3, $4, ARRAY[]::text[], NULL)
         ON CONFLICT ("runId", "step") DO NOTHING`,
        [runId, step, ownerGroup, openedAt],
      );
    },
  };
}

/**
 * The two audit actions that record a human decision on a gate (M33).
 *
 * `GATE_APPROVE`/`GATE_REJECT` are `humanOnly` in `@maestro/audit`'s action
 * table, which is what makes a decision found here a decision a PERSON signed
 * — an AI or a service account cannot produce one of these records at all.
 */
const DECISION_ACTIONS = ["GATE_APPROVE", "GATE_REJECT"] as const;
type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** The `AuditLog` rows a decision is reconstructed from. */
export interface AuditRow {
  seq: bigint;
  at: Date;
  actor: string;
  action: AuditAction;
  metaJson: unknown;
}

export interface AuditDelegate {
  findMany(args: {
    where: {
      action: { in: DecisionAction[] };
      metaJson: { path: string[]; equals: string };
    };
    orderBy: { seq: "asc" };
  }): Promise<AuditRow[]>;
}

export class GateNotFoundError extends Error {
  constructor(runId: string, step: string) {
    super(`gate: no gate ${step} on run ${runId}`);
    this.name = "GateNotFoundError";
  }
}

export class PrismaGateStore implements GateStore {
  constructor(
    private readonly gates: GateDelegate,
    private readonly audit: AuditDelegate,
    /** Resolves the run a decision belongs to; the audit row keys by ticket. */
    private readonly ticketOfRun: (runId: string) => Promise<string>,
    /** The insert, as ONE statement Postgres resolves. See `open`. */
    private readonly claim: GateClaim,
  ) {}

  /**
   * Idempotent at the DATABASE level: one statement, resolved by Postgres.
   *
   * This used to be a Prisma `upsert` with an empty `update`, on the theory
   * that the loser's update would write nothing and hand back the existing
   * row. That theory was wrong, and a live database said so: on a composite
   * primary key Prisma does NOT compile `upsert` into `ON CONFLICT`. It issues
   * a `SELECT` and then a bare `INSERT` — the read-then-write race the shape
   * was chosen to avoid. Measured on a cold row (the gate's FIRST open, which
   * is the only moment the race exists), six workers over twenty rounds: 94 of
   * 120 calls failed with `P2002`.
   *
   * What that costs in the bank is not a loud crash. `openedAt` is the M88
   * escalation ladder's anchor, so the call that raises the gate is the call
   * that starts the ladder. A worker whose `open` throws never notifies the
   * approver group, the ladder never begins, and the run sits waiting for an
   * approval nobody was asked for — silence, not a page.
   *
   * `INSERT ... ON CONFLICT DO NOTHING` is the same instrument
   * `sqlClaimExecutor` uses in `idempotency.ts`, and for the same reason: the
   * conflict is settled inside one statement, so there is no window between
   * the look and the write. The follow-up read is unconditional rather than
   * "only if I lost" — the winner's own row is the row every caller must
   * return, and reading it back keeps all racers on ONE anchor instead of the
   * instant each of them happened to pass in.
   */
  async open(runId: string, step: StepId, ownerGroup: string, at: string): Promise<GateRecord> {
    await this.claim.insertIfAbsent(runId, step, ownerGroup, new Date(at));
    const row = await this.gates.findUnique({ where: { runId_step: { runId, step } } });
    // The row cannot be absent: the statement above either inserted it or found
    // it already there. If it IS absent something deleted a gate mid-open, and
    // a caller that continued would escalate a gate that no longer exists.
    if (row === null) throw new GateNotFoundError(runId, step);
    return toRecord(row);
  }

  async get(runId: string, step: StepId): Promise<GateRecord | null> {
    const row = await this.gates.findUnique({ where: { runId_step: { runId, step } } });
    return row === null ? null : toRecord(row);
  }

  /**
   * Appends with `push`, never with a read-modify-write.
   *
   * Two reminders resolving at the same instant would both read `["s24"]`,
   * both write `["s24","s72"]` and lose one of the two — and a ladder step
   * that was recorded as unfired fires again. `push` is a single UPDATE the
   * database serialises for us.
   *
   * A missing gate is an error rather than a no-op (the in-memory reference
   * double returns silently): marking a step fired on a gate that does not
   * exist means the ladder is escalating something nobody is waiting for, and
   * that is worth a page, not a shrug.
   */
  async markFired(runId: string, step: StepId, stepIds: readonly string[]): Promise<void> {
    if (stepIds.length === 0) return;
    await this.requireGate(runId, step);
    await this.gates.update({
      where: { runId_step: { runId, step } },
      data: { firedStepIds: { push: [...stepIds] } },
    });
  }

  /**
   * Closing a gate that was never opened is a bug, and it is reported as one.
   *
   * `at` is the decision's OWN timestamp — for a Jira command, the moment the
   * comment was written. That can legitimately predate the gate: the poller
   * re-reads a comment thread from the start after a restart, so an `/approve`
   * written before this gate opened arrives with its original time. The column
   * carries a `closedAt >= openedAt` check, and letting that fire killed the
   * run: the constraint violation is not retryable, so `recordGateDecision`
   * exhausted its attempts and the whole workflow failed with a live approval
   * on the table (OPS-36).
   *
   * The floor is the gate's own `openedAt`. It keeps the recorded time
   * truthful where it can be — a decision made while the gate was open keeps
   * its real timestamp — and refuses to write a nonsense interval where it
   * cannot, rather than refusing the decision. The AUDIT trail is untouched by
   * this: it already holds the decision's real time, signed and chained.
   */
  async close(runId: string, step: StepId, at: string): Promise<void> {
    const gate = await this.requireGate(runId, step);
    const decidedAt = new Date(at);
    const openedAt = new Date(gate.openedAt);
    await this.gates.update({
      where: { runId_step: { runId, step } },
      data: { closedAt: decidedAt < openedAt ? openedAt : decidedAt },
    });
  }

  /**
   * The run's signed approvals, rebuilt from the audit chain.
   *
   * Every field of a `GateDecision` is either the audit row's own (`seq` →
   * `signatureSeq`, `actor` → `actorUserId`, `at`, and the action → approve or
   * reject) or was written into its `meta` when the decision was recorded. The
   * result is parsed with the CONTRACT schema rather than cast: a row whose
   * meta is missing `actorGroup`, or a rejection with no reason, is not a
   * decision this platform can put in an evidence package, and letting it
   * through as a half-built object would put an unsigned approval in front of
   * an auditor.
   */
  async decisions(runId: string): Promise<GateDecision[]> {
    const ticket = await this.ticketOfRun(runId);
    const rows = await this.audit.findMany({
      where: {
        action: { in: [...DECISION_ACTIONS] },
        metaJson: { path: ["ticketKey"], equals: ticket },
      },
      orderBy: { seq: "asc" },
    });

    const decisions: GateDecision[] = [];
    for (const row of rows) {
      const meta = (typeof row.metaJson === "object" && row.metaJson !== null ? row.metaJson : {}) as
        Record<string, unknown>;
      decisions.push(
        GateDecision.parse({
          step: meta["step"],
          decision: row.action === "GATE_APPROVE" ? "approve" : "reject",
          actorUserId: row.actor,
          actorGroup: meta["actorGroup"],
          sodVerified: meta["sodVerified"] === true,
          signatureSeq: Number(row.seq),
          source: meta["source"],
          at: row.at.toISOString(),
          ...(typeof meta["reason"] === "string" ? { reason: meta["reason"] } : {}),
        }),
      );
    }
    return decisions;
  }

  private async requireGate(runId: string, step: StepId): Promise<GateRow> {
    const row = await this.gates.findUnique({ where: { runId_step: { runId, step } } });
    if (row === null) throw new GateNotFoundError(runId, step);
    return row;
  }
}

function toRecord(row: GateRow): GateRecord {
  return {
    runId: row.runId,
    step: row.step as StepId,
    ownerGroup: row.ownerGroup,
    openedAt: row.openedAt.toISOString(),
    firedStepIds: [...row.firedStepIds],
    closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
  };
}
