import type {
  ApplicationRecord,
  DataClass,
  GateDecision,
  Locale,
  RiskTier,
  RoutingRule,
  RunId,
  StepId,
  TicketKey,
  WorkMode,
} from "@maestro/contracts";
import type { AuditChain } from "@maestro/audit";
import type { AgentTurnRequest, AgentTurnResult, CommandSpec } from "@maestro/execution";
import type { JournalDeps } from "@maestro/memory";
import type { EscalationLadder, NotifyRouting } from "@maestro/notify";
import type {
  LlmPort,
  NotifyPort,
  PublishPort,
  ScanPort,
  ScmPort,
  SecretPort,
  StoragePort,
  WorkPort,
} from "@maestro/ports";

/**
 * Everything an activity needs, as INTERFACES.
 *
 * M44: no concrete driver is named anywhere in this package — `worker.ts`
 * resolves them from the registry and hands the result in. That is also what
 * keeps the activity tests offline: the same seams take fakes.
 */

/**
 * What a run is, beyond its ticket key.
 *
 * Activities receive a `TicketKey` and nothing else (the workflow may not carry
 * mutable business state through its arguments), so every fact an activity
 * needs about the run is read back from here. The store is the run's row in the
 * database; in tests it is a Map.
 */
export interface RunContext {
  readonly runId: RunId;
  readonly ticket: TicketKey;
  /**
   * `null` for an analysis-only run: the binding carried no application, so
   * there is no repository, no branch that means anything, and no PR to open.
   * Intake only ever starts the `analiz` flow that way, and the workflow hands
   * over before the engineering half — so the code paths that NEED an app
   * (`delivery.ts`, fan-out's self-exclusion) treat `null` as "refuse loudly"
   * or "no self to exclude", never as a blank app to write into.
   */
  readonly app: ApplicationRecord | null;
  readonly dataClass: DataClass;
  readonly mode: WorkMode;
  readonly locale: Locale;
  /** Prompt-variant this run is pinned to (M38). */
  readonly variantId: string;
  /** Analysis template pinned at run start (M83). */
  readonly templateVersion: string;
  /**
   * The step the run is on, as Studio's ticket list reads it.
   *
   * Carried on the context because the WORKFLOW advances it (`goto`) while the
   * screens read it from Postgres: without a write path the two disagree, and
   * every run showed step 0 no matter how far it had got.
   */
  readonly step: string;
  /**
   * The run's lifecycle state as the ROW carries it. Studio's lists filter on
   * it, so a run Temporal has completed must say so here too — otherwise every
   * finished ticket keeps showing as live, and intake keeps joining a run that
   * is over instead of starting a new one.
   *
   * A union rather than `string`: the column is a Prisma enum, and the store's
   * own `notIn` filter is written against these three names.
   */
  readonly status: RunLifecycle;
  readonly workspacePath: string;
  /** False after an M65 archive — the clone is gone, the context is not. */
  readonly workspacePresent: boolean;
  /** The repo's ADDITIONS to the M52 deny-list, from `.maestro.yaml` (M71). */
  readonly protectedPaths: readonly string[];
  /** The repo's own lint/build/test commands (`.maestro.yaml`, M71). */
  readonly verification: readonly CommandSpec[];
  readonly branch: string;
  readonly targetBranch: string;
  readonly risk: RiskTier | null;
  readonly prId: number | null;
  /** Resume token of the live agent session (M30); null before the first turn. */
  readonly resumeToken: string | null;
}

/** The three states `WorkflowRun.status` can hold. */
export type RunLifecycle = "running" | "done" | "cancelled";

export interface RunContextStore {
  get(ticket: TicketKey): Promise<RunContext>;
  patch(ticket: TicketKey, changes: Partial<RunContext>): Promise<void>;
}

/** One open (or closed) approval gate — the escalation ladder's anchor (M88). */
export interface GateRecord {
  readonly runId: RunId;
  readonly step: StepId;
  readonly ownerGroup: string;
  readonly openedAt: string;
  /** Ladder steps already sent; the ladder never fires the same one twice. */
  readonly firedStepIds: readonly string[];
  readonly closedAt: string | null;
}

export interface GateStore {
  /** Idempotent: re-opening an open gate returns the existing record. */
  open(runId: RunId, step: StepId, ownerGroup: string, at: string): Promise<GateRecord>;
  get(runId: RunId, step: StepId): Promise<GateRecord | null>;
  markFired(runId: RunId, step: StepId, stepIds: readonly string[]): Promise<void>;
  close(runId: RunId, step: StepId, at: string): Promise<void>;
  /** Approvers of already-closed gates — the evidence package's signature chain. */
  decisions(runId: RunId): Promise<GateDecision[]>;
}

/**
 * Operational settings (M71). All of them live in the database and are read
 * through here, so this package holds no second copy of any default.
 */
export interface ParamReader {
  escalationLadder(runId: RunId): Promise<EscalationLadder>;
  notifyRouting(runId: RunId): Promise<NotifyRouting>;
  routingRules(ticket: TicketKey): Promise<RoutingRule[]>;
  /** Publish targets for a document kind (M47). */
  publishTargets(runId: RunId, doc: "analysis" | "evidence_summary"): Promise<string[]>;
}

/** Who a notification goes to. Group → corporate addresses (M71). */
export interface DirectoryReader {
  membersOf(group: string): Promise<string[]>;
  /**
   * The directory group that answers to a workflow ROLE (`product-owners`,
   * `tech-leads`, `qa`).
   *
   * The two vocabularies are not the same, and pretending they are cost a live
   * gate: `GATE_OWNER` named `product-owners`, `openGate` wrote that onto the
   * gate record, and the BFF asked Jira about `jira-users-uyildiz` — the group
   * that actually exists. Both sides then verified a real approver against a
   * DIFFERENT group, the BFF said yes, the worker said "üyelik doğrulanamadı",
   * and a correct approval was refused with no way to tell why from either log.
   *
   * Resolving here means the group written onto the gate is the group the
   * decision is checked against, because it is one lookup instead of two
   * guesses. A deployment whose directory uses the role names needs no mapping.
   */
  groupForRole(role: string): Promise<string>;
}

/** One doing-role turn (`@maestro/execution`'s `AgentExecution`). */
export interface AgentTurnRunner {
  runTurn(req: AgentTurnRequest): Promise<AgentTurnResult>;
  endRun(runId: string): void;
}

/**
 * Temporal retries activities, so every write goes through here: the guard
 * remembers the key and replays the first result instead of writing twice.
 * Production backs it with a table; tests back it with a Map.
 */
export interface IdempotencyGuard {
  once<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/** Message-catalog lookup (M104), injected so this package owns no catalog. */
export type Translate = (locale: Locale, key: string, params?: Record<string, string>) => string;

/**
 * Putting a FILE on the ticket (M103r) — the analysis Word/PDF, so nobody has
 * to drag them in by hand.
 *
 * A seam rather than a `WorkPort` method, because `WorkPort` is FROZEN
 * (packages/ports) and attaching a binary is not part of it. The capability is
 * real on the concrete Jira Cloud driver (`addAttachment`), and the
 * composition root — the one place allowed to name a driver (M44) — passes
 * that method in. This package still imports nothing from an adapter: it
 * declares the SHAPE it needs and takes whatever satisfies it, which is also
 * what keeps the tests offline.
 *
 * OPTIONAL on purpose. A deployment on a driver with no attachment API (the DC
 * driver today) is a supported deployment: the documents are still generated
 * and still stored durably, and the delivery says in the journal that the
 * ticket did not get them. Making this required would either break those
 * deployments or force a no-op stub that lies about what happened.
 */
export interface DocAttacher {
  addAttachment(
    ticket: TicketKey,
    fileName: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ ids: string[] }>;
}

/**
 * Moving the ticket ITSELF — the desk-to-desk part of "dinleme kuralı" mode B.
 *
 * The same shape and the same reason as `DocAttacher` above: `WorkPort` is
 * FROZEN and its `transition()` takes a per-workflow transition ID, which is
 * meaningless outside the one project that issued it. What a listening rule
 * names is a STATUS ("İNCELEMEDE"), so the capability this package needs is
 * "move to the status called X" — real on the concrete Jira Cloud driver
 * (`transitionToStatus`), absent on Data Center. The composition root matches
 * the shape to a driver; this package imports no adapter.
 *
 * `move` NEVER throws, and that is the whole contract rather than a nicety: the
 * policy the ticket workflow was built for is "warn but continue". A status the
 * operator's board does not offer, a service account without Transition Issues,
 * a 5xx — none of them may cost a run whose analysis is finished and approved.
 * So the outcome comes back as data (`moved` plus a `reason`) and the caller
 * writes it into the journal, where an operator can read WHY the ticket stayed
 * where it was.
 *
 * OPTIONAL, like `DocAttacher`: a deployment on a driver that cannot transition
 * is a supported deployment. It stays in comment-only mode, which is exactly
 * what every rule did before the status map existed.
 */
export interface StatusMover {
  move(ticket: TicketKey, statusName: string): Promise<{ moved: boolean; reason?: string }>;
}

export interface ActivityDeps {
  readonly runs: RunContextStore;
  readonly gates: GateStore;
  readonly params: ParamReader;
  readonly directory: DirectoryReader;
  readonly work: WorkPort;
  readonly scm: ScmPort;
  readonly llm: LlmPort;
  readonly scan: ScanPort;
  readonly storage: StoragePort;
  /**
   * D5: resolved and wired, but no activity in this package reads it yet. It
   * stays because the push credential the engineering turn needs (`scm`'s
   * `getPushCredential`) is issued through it, and the seam is what keeps that
   * a composition-root decision rather than a driver import. Delete it only
   * together with that plan.
   */
  readonly secrets: SecretPort;
  readonly notify: NotifyPort;
  readonly publish: PublishPort;
  readonly memory: JournalDeps;
  readonly execution: AgentTurnRunner;
  readonly audit: AuditChain;
  readonly idempotency: IdempotencyGuard;
  /**
   * Absent on a deployment whose work driver cannot attach files (M103r). The
   * analysis documents are then generated and stored, but not put on the
   * ticket — and the journal says so.
   */
  readonly docAttacher?: DocAttacher;
  /**
   * Absent on a deployment whose work driver cannot move a ticket between
   * statuses. The flow then runs exactly as it always has — comments only — and
   * the journal says the move was skipped for want of the capability.
   */
  readonly statusMover?: StatusMover;
  readonly translate: Translate;
  readonly now: () => Date;
}

/** Actor recorded on everything the worker writes (M33 actor conventions). */
export const WORKER_ACTOR = "maestro-worker";
