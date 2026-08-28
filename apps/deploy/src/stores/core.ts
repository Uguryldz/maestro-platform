import { AuditChain } from "@maestro/audit";
import {
  PrismaAuditStore,
  postgresChainLock,
  type AuditLogDelegate,
  type TransactionRunner,
} from "./audit.js";
import { PrismaDirectoryReader, type DirectoryUserDelegate } from "./directory.js";
import {
  PrismaGateStore,
  sqlGateClaim,
  type AuditDelegate as GateAuditDelegate,
  type GateDelegate,
} from "./gates.js";
import {
  PrismaIdempotencyGuard,
  sqlClaimExecutor,
  type IdempotencyDelegate,
} from "./idempotency.js";
import {
  PrismaParamReader,
  projectOfTicket,
  type ParamScopeRefs,
  type ParamVersionDelegate,
  type RoutingRuleDelegate,
} from "./params.js";
import {
  PrismaRunContextStore,
  TERMINAL_STATUSES,
  type RunDelegate,
} from "./run-context.js";
import type { SqlExecutor } from "./sql.js";

/**
 * The run-scoped stores, assembled.
 *
 * Every one of them is Postgres-backed and every one lives here rather than in
 * the package that declares its interface: `@maestro/workflows` is M44 clean
 * room — no activity may import Prisma, which is what keeps its activity tests
 * offline against fakes. The composition root is the one place allowed to know
 * both sides, and it is where `PrismaUserDirectory` already lives.
 *
 * What this file does NOT build is the journal store (`JournalDeps.store`),
 * which is `@maestro/memory`'s interface and a separate piece of work.
 */

/**
 * The run-row lookup the scope resolvers need, on top of `RunDelegate`.
 *
 * It is declared here rather than in `run-context.ts` because it is not part
 * of the `RunContextStore`'s job: that store answers by TICKET, these
 * resolvers answer by RUN ID, and keeping the two delegates separate is what
 * documents that the context store never reaches for a run by id.
 */
export interface RunLookupDelegate {
  findUnique(args: {
    where: { id: string };
    select: { ticketKey: true; appId: true };
  }): Promise<{ ticketKey: string; appId: string | null } | null>;
}

/**
 * The Prisma delegates these stores need, named one by one.
 *
 * `auditLog` is an intersection because two stores read the same table in two
 * different ways: `PrismaAuditStore` walks the chain by `seq`, and
 * `PrismaGateStore` looks up a ticket's decisions by action and meta. Prisma's
 * real delegate is generic and satisfies both; naming both narrowings here is
 * what keeps each store's declared surface honest about what it touches.
 */
export interface CoreStoreDb {
  readonly workflowRun: RunDelegate & RunLookupDelegate;
  readonly gate: GateDelegate;
  readonly auditLog: AuditLogDelegate & GateAuditDelegate;
  readonly paramVersion: ParamVersionDelegate;
  readonly routingRule: RoutingRuleDelegate;
  readonly user: DirectoryUserDelegate;
  readonly idempotencyKey: IdempotencyDelegate;
}

export interface BuiltCoreStores {
  readonly runs: PrismaRunContextStore;
  readonly gates: PrismaGateStore;
  readonly params: PrismaParamReader;
  readonly directory: PrismaDirectoryReader;
  readonly idempotency: PrismaIdempotencyGuard;
  readonly audit: AuditChain;
}

export interface CoreStoreOptions {
  /**
   * Workflow role -> directory group (see `gate-directory.ts`'s
   * `roleResolver`). Passed in because the mapping is deployment config that
   * lives in the environment, and this module takes no env dependency.
   * Omitted means the role name IS the group.
   */
  readonly resolveRole?: (role: string) => string;

  /**
   * Raw SQL, for the two `INSERT ... ON CONFLICT DO NOTHING` claims.
   *
   * Both the idempotency key and the gate row need a conflict settled INSIDE
   * one statement, and Prisma's query builder emits `ON CONFLICT` for neither
   * (on a composite key it falls back to `SELECT`-then-`INSERT`, which is the
   * race itself). These are the only two places the stores leave the ORM.
   */
  readonly sql: SqlExecutor;
  /** Runs a callback inside one transaction — the audit chain lock needs it. */
  readonly transactions: TransactionRunner;
}

export class UnknownRunError extends Error {
  constructor(runId: string) {
    super(`run ${runId} does not exist`);
    this.name = "UnknownRunError";
  }
}

/**
 * Resolve a run's identity once, for the stores that key by it.
 *
 * `ParamReader` and `GateStore` both take a run id and need facts the run row
 * holds — its project (for parameter scope) and its ticket (to find the
 * decisions in the audit chain). Both lookups go through this one function so
 * there is a single definition of "which run does this id mean", and so an
 * unknown run is one error message rather than two.
 */
export function buildCoreStores(db: CoreStoreDb, options: CoreStoreOptions): BuiltCoreStores {
  const identityOf = async (
    runId: string,
  ): Promise<{ ticketKey: string; appId: string | null }> => {
    const row = await db.workflowRun.findUnique({
      where: { id: runId },
      select: { ticketKey: true, appId: true },
    });
    if (row === null) throw new UnknownRunError(runId);
    return row;
  };

  const scopeOf = async (runId: string): Promise<ParamScopeRefs> => {
    const identity = await identityOf(runId);
    return { projectKey: projectOfTicket(identity.ticketKey), appId: identity.appId };
  };

  const ticketOfRun = async (runId: string): Promise<string> => (await identityOf(runId)).ticketKey;

  return {
    runs: new PrismaRunContextStore(db.workflowRun),
    gates: new PrismaGateStore(db.gate, db.auditLog, ticketOfRun, sqlGateClaim(options.sql)),
    params: new PrismaParamReader(db.paramVersion, db.routingRule, scopeOf),
    directory: new PrismaDirectoryReader(db.user, options.resolveRole),
    idempotency: new PrismaIdempotencyGuard(db.idempotencyKey, sqlClaimExecutor(options.sql)),
    /**
     * The chain, locked by the DATABASE rather than by this process.
     * `LocalChainLock` (the default) only orders writers inside one Node
     * process; a second replica would fork the chain. See `audit.ts`.
     */
    audit: new AuditChain({
      store: new PrismaAuditStore(db.auditLog),
      lock: postgresChainLock(options.transactions),
    }),
  };
}

/** Re-exported so callers reading "which run is live" agree with the store. */
export { TERMINAL_STATUSES };
