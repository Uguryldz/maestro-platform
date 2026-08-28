import { t } from "@maestro/config";
import type { Db } from "@maestro/db";
import { createJournalMasker, journalStoreFromDb } from "@maestro/memory";
import { defaultPiiPolicy } from "@maestro/pii";
import type { CoreDeps } from "@maestro/workflows";
import type { PublishRunDeps } from "../boot.js";
import { buildCoreStores, type CoreStoreOptions } from "./core.js";
import { PrismaPublishState } from "./publish-state.js";
import type { SqlExecutor } from "./sql.js";

/**
 * `CoreDeps` for the worker — everything the activities need that is not a
 * port, assembled from one database handle.
 *
 * This is the file `MISSING_CORE_DEPS` used to stand in for. Every member is
 * now a real Postgres-backed store; see `core.ts` for the six run-scoped ones
 * and why they live in the composition root rather than in
 * `@maestro/workflows` (M44 clean room).
 */

export interface WorkerCoreOptions {
  /** Raw SQL, for the idempotency claim. */
  readonly sql: SqlExecutor;
  /** Runs a callback inside one transaction — the audit chain lock needs it. */
  readonly transactions: CoreStoreOptions["transactions"];
  /**
   * The doing-role turn runner. It needs a workspace probe, a verification
   * runner and a strike ledger — runner-fleet collaborators, not stores — so
   * the process that owns the runner pool supplies it.
   */
  readonly execution: CoreDeps["execution"];
  /** Workflow role -> directory group; see `CoreStoreOptions.resolveRole`. */
  readonly resolveRole?: CoreStoreOptions["resolveRole"];
  readonly now?: () => Date;
}

export interface WorkerCore {
  readonly core: CoreDeps;
  /** The publisher's two run-scoped collaborators, from the same stores. */
  readonly publishRunDeps: PublishRunDeps;
}

export function buildWorkerCore(db: Db, options: WorkerCoreOptions): WorkerCore {
  const now = options.now ?? ((): Date => new Date());
  const stores = buildCoreStores(db, {
    sql: options.sql,
    transactions: options.transactions,
    ...(options.resolveRole === undefined ? {} : { resolveRole: options.resolveRole }),
  });

  const core: CoreDeps = {
    runs: stores.runs,
    gates: stores.gates,
    params: stores.params,
    directory: stores.directory,
    idempotency: stores.idempotency,
    audit: stores.audit,
    /**
     * The journal was never missing: `journalStoreFromDb` has shipped since
     * wave 1, append-only and keyed by `(runId, seq)`. The masker is the real
     * one — journal text passes the M20 boundary before it is stored, which is
     * not optional for a store that feeds the evidence package.
     */
    memory: {
      store: journalStoreFromDb(db.journalEntry),
      /**
       * Pinned to the STRICTEST profile, deliberately.
       *
       * `createJournalMasker` resolves its profile once, at construction, from
       * a single `dataClass` — but one worker serves runs of every class off
       * the same task queue, and `JournalDeps` carries one masker for all of
       * them. Passing anything less than the strictest value would mean a
       * `gizli` run's journal masked with a `dahili` profile, which is an M18
       * boundary violation that nothing downstream would notice.
       *
       * `dataClass: "gizli"` is not a claim that every run is confidential; it
       * is the fail-closed reading of "we cannot know yet". Over-masking a
       * `dahili` journal costs readability; under-masking a `gizli` one is a
       * disclosure. See the ARAYÜZ İSTEĞİ in packages/db/RAPOR-dalga5.md — a
       * per-entry masker is the real fix and it needs `JournalDeps` to change.
       */
      masker: createJournalMasker({ policy: defaultPiiPolicy(), dataClass: "gizli" }),
      // `@maestro/memory`'s clock reports an ISO string, not a Date — the
      // journal's `at` is a contract `IsoDateTime`. Derived from the same
      // `now` so every timestamp this worker writes agrees.
      clock: { now: (): string => now().toISOString() },
    },
    execution: options.execution,
    translate: t,
    now,
  };

  return {
    core,
    publishRunDeps: {
      /**
       * The publisher asks by RUN ID; the context store answers by TICKET.
       * Resolving through `gates`' own identity lookup would be a second
       * definition of the same thing, so the run row is read once here and the
       * store is asked for the rest.
       */
      runContext: async (runId) => {
        const row = await db.workflowRun.findUnique({
          where: { id: runId },
          select: { ticketKey: true },
        });
        if (row === null) throw new Error(`publish: run ${runId} does not exist`);
        const context = await stores.runs.get(row.ticketKey);
        return {
          ticketKey: context.ticket,
          // `PublishRunContext.app` models "no application" as absence; the run
          // context models it as `null` (analysis-only run). Same fact, two
          // spellings — the publisher then simply has no repo-docs target,
          // which is correct: there is no repository to receive them.
          ...(context.app === null ? {} : { app: context.app }),
          dataClass: context.dataClass,
          /**
           * The approvers' addresses and the pinned template version are the
           * two things the evidence summary exists to state, and the masker
           * would otherwise redact both — an `[EMAIL_1]` where the approver's
           * name should be destroys the only fact the document is kept for
           * (M82/M83).
           */
          piiExemptions: [
            context.templateVersion,
            ...(await approverAddresses(stores, runId)),
          ].filter((value) => value.length > 0),
        };
      },
      state: new PrismaPublishState(db.publishState, now),
    },
  };
}

/**
 * The corporate addresses of everyone who signed a gate on this run.
 *
 * Read from the decisions the audit chain holds, which is the same source the
 * evidence package's signature list uses — so the document and its exemption
 * list cannot disagree about who approved.
 */
async function approverAddresses(
  stores: ReturnType<typeof buildCoreStores>,
  runId: string,
): Promise<string[]> {
  const decisions = await stores.gates.decisions(runId);
  return [...new Set(decisions.map((decision) => decision.actorUserId))];
}
