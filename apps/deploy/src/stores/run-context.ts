import type { ApplicationRecord } from "@maestro/contracts";
import type { RunContext, RunContextStore } from "@maestro/workflows";

/**
 * `CommandSpec`, taken from the interface rather than imported.
 *
 * The type lives in `@maestro/execution`, which this package does not depend
 * on and should not start depending on for one structural shape. Deriving it
 * from `RunContext` is also strictly safer: if the contract's verification
 * shape changes, this alias changes with it and the mapper below stops
 * compiling, which is exactly the notification we want.
 */
type CommandSpec = RunContext["verification"][number];

/**
 * The Postgres-backed `RunContextStore` (Dalga 5).
 *
 * M44 clean room: `@maestro/workflows` defines the interface and never imports
 * Prisma — its activity tests all run offline against a Map. This is the real
 * one, and it lives in the composition root for the same reason
 * `PrismaUserDirectory` does: the package that owns the interface must stay
 * free of the driver.
 *
 * The delegate is structural rather than `PrismaClient["workflowRun"]`. That is
 * the house pattern (see `users.ts`) and it buys two things: this file
 * typechecks before `prisma generate` has run, and the four methods below are a
 * written-down statement of exactly how much of the table this store may touch.
 */

/** The `WorkflowRun` row as read back, joined to its application. */
export interface RunRow {
  id: string;
  ticketKey: string;
  /**
   * The FK, read alongside the joined row so `get` can tell two nulls apart:
   * `appId === null` is an analysis-only run (the binding named no
   * application, deliberately), while `appId !== null` with a `null` join is a
   * row pointing at an application that is gone — the incomplete-context
   * failure it has always been.
   */
  appId: string | null;
  step: string;
  /**
   * Read as a plain `string`, not the narrowed union.
   *
   * The WRITE side (`RunUpdate`) is narrow so a typo cannot reach the column,
   * but the read side takes whatever the row holds: Prisma's generated enum is
   * its own type, and narrowing here makes the real delegate structurally
   * incompatible with this interface for no safety the database is not already
   * enforcing.
   */
  status: string;
  mode: string;
  risk: string | null;
  dataClass: string;
  locale: string;
  variantId: string;
  templateVersion: string;
  workspacePath: string;
  workspacePresent: boolean;
  protectedPathsJson: unknown;
  verificationJson: unknown;
  branch: string;
  targetBranch: string;
  prId: number | null;
  resumeToken: string | null;
  application: ApplicationRow | null;
}

export interface ApplicationRow {
  appId: string;
  displayName: string;
  adoProject: string;
  adoRepo: string;
  platform: string;
  jiraComponent: string | null;
  maestroYamlPresent: boolean;
  createdVia: string;
}

/**
 * The columns `patch` may write. Every one is optional — that is the point.
 *
 * `risk` is typed as the contract's tier union rather than `string` because
 * the column is a Prisma enum; see `TERMINAL_STATUSES` for why that strictness
 * is the useful kind.
 */
export interface RunUpdate {
  /** The step the workflow has reached; Studio's ticket list reads this column. */
  step?: string;
  /**
   * The run's lifecycle state. Written when the workflow ENDS: `get` filters on
   * `status notIn TERMINAL_STATUSES`, so a finished run that never sets this
   * stays "live" forever and the ticket can never start a second run.
   */
  status?: NonNullable<RunContext["status"]>;
  risk?: NonNullable<RunContext["risk"]>;
  locale?: string;
  variantId?: string;
  templateVersion?: string;
  workspacePath?: string;
  workspacePresent?: boolean;
  protectedPathsJson?: string[];
  /**
   * The verification commands as WRITTEN. `CommandSpec`'s own fields are
   * `readonly`, and Prisma's JSON input type rejects that — reasonably, since
   * it serialises the value. The write shape is the same data with mutable
   * fields, which is also the shape `parseCommands` validates on the way back.
   */
  verificationJson?: Array<{ name: string; command: string[] }>;
  branch?: string;
  targetBranch?: string;
  prId?: number | null;
  resumeToken?: string | null;
}

/**
 * The columns `create` writes.
 *
 * Deliberately smaller than `RunUpdate`: everything the run learns LATER —
 * branch, workspace, risk, prId, resumeToken — is left to the schema defaults
 * and filled by `patch` as the workflow discovers it. Writing invented values
 * here would put a branch name in the row before anything created a branch.
 *
 * `appId` is nullable in the schema (M99), and since analysis-only bindings it
 * is genuinely OPTIONAL here too: intake starts an `analiz` run with no
 * application when the binding named none, and the column honestly stays NULL.
 * Omitted rather than written as an explicit null so a caller that HAS an app
 * writes exactly the row it always wrote.
 */
export interface RunCreate {
  id: string;
  ticketKey: string;
  appId?: string;
  mode: NonNullable<RunContext["mode"]>;
  dataClass: NonNullable<RunContext["dataClass"]>;
  step: string;
  /**
   * Literal rather than `string`, for the reason `TERMINAL_STATUSES` gives:
   * the column is a Prisma enum and the generated client rejects a widened
   * `string`. A run opens `running` and nothing else, so the type says so —
   * a typo'd status is then a compile error rather than a row the store's own
   * `notIn` filter would never match.
   */
  status: "running";
  startedAt: Date;
  locale?: string;
  variantId?: string;
  templateVersion?: string;
  workspacePath?: string;
  workspacePresent?: boolean;
}

/** The three `PrismaClient.workflowRun` methods this store uses, and no more. */
export interface RunDelegate {
  findFirst(args: {
    where: { ticketKey: string; status: { notIn: TerminalStatus[] } };
    orderBy: { startedAt: "desc" };
    include: { application: true };
  }): Promise<RunRow | null>;
  update(args: { where: { id: string }; data: RunUpdate }): Promise<unknown>;
  create(args: { data: RunCreate }): Promise<unknown>;
}

/**
 * Statuses that mean "this run is over". `get` reads the newest run that is
 * NOT one of them, which is the same definition of "live" the partial unique
 * index uses (migration 0002, widened by 0011) — one place to change it, and
 * the store and the database agree on which run a ticket means.
 *
 * `fail` joined the set in 0011, and it had to join both halves at once. Until
 * then nothing ever wrote the status, so the omission was invisible; the
 * reconciler (`reconcile.ts`) writes it, and a `fail` row that still counted as
 * live would have been the worse bug of the two — the ticket's live slot stays
 * occupied, so `get` keeps handing activities a dead run's context and the next
 * `/ai-start` on that ticket dies on the unique index with P2002. A failed run
 * is over. Re-running it is the whole point of noticing it failed.
 *
 * The literal type is load-bearing: `WorkflowRun.status` is a Prisma enum, and
 * a `string[]` filter is rejected by the generated client. That rejection is
 * welcome — it is what stops a typo'd status from becoming a filter that
 * silently matches nothing and makes every run look live.
 */
export const TERMINAL_STATUSES = ["done", "cancelled", "fail"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * What intake knows when a run opens, and nothing more.
 *
 * Mirrors `SignalWithStartInput` (`apps/bff/src/gateway.ts`) plus the ids
 * Temporal minted, so the caller passes through what it already has rather
 * than assembling a `RunContext` it cannot yet fill.
 */
export interface NewRun {
  readonly runId: string;
  readonly ticket: string;
  /**
   * `null` for an analysis-only run — the binding named no application, so
   * there is no repository, no checkout and no engineering half. Mirrors
   * `OpenedRun.appId` (the gateway hands intake's answer straight through).
   */
  readonly appId: string | null;
  readonly mode: NonNullable<RunContext["mode"]>;
  readonly dataClass: NonNullable<RunContext["dataClass"]>;
  readonly startedAt: Date;
  readonly locale?: string;
  /**
   * The prompt variant and analysis template this run is PINNED to (M38/M83).
   *
   * Both are pinned at the start rather than read per activity, so publishing a
   * new agent version mid-run cannot change the rules under a ticket that is
   * already being analysed — and the document a reviewer approves is the one
   * the run was configured to produce.
   *
   * They are required, not optional. The column defaults to `""`, and an empty
   * variant reaches the gateway as a contract violation on the FIRST model
   * call: `variantId: Too small: expected string to have >=1 characters`,
   * three activity attempts deep, where it reads as a model problem rather
   * than a run that was opened without saying which agent it runs.
   */
  readonly variantId: string;
  readonly templateVersion: string;
  /**
   * The checkout step 3ö reads (M100), when there is one.
   *
   * Optional because the analysis is worse without a repository but not wrong:
   * `discoverRepo` treats an unavailable session as degraded and the analyst
   * carries on from the ticket alone — which is exactly what the pilot has
   * always done. A clone that failed must not stop a ticket from being
   * analysed.
   */
  readonly workspacePath?: string;
}

/**
 * Prisma's unique-constraint failure, recognised without importing the client.
 *
 * This package's stores are structural over their delegates (see `RunDelegate`)
 * so that they typecheck before `prisma generate` has run; importing
 * `PrismaClientKnownRequestError` for one error code would give that up. P2002
 * is the documented code and is stable across Prisma 5/6.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export class RunNotFoundError extends Error {
  constructor(ticket: string) {
    super(`run context: no live run for ticket ${ticket}`);
    this.name = "RunNotFoundError";
  }
}

export class IncompleteRunContextError extends Error {
  constructor(ticket: string, missing: string) {
    super(`run context: run for ticket ${ticket} has no ${missing}`);
    this.name = "IncompleteRunContextError";
  }
}

/**
 * A run opened without saying which agent — or which template — it runs on.
 *
 * Raised at the moment the row would be WRITTEN, which is the last place the
 * mistake is still cheap. The alternative is the failure this deployment
 * actually produced: `variantId: ""` is accepted here (the column defaults to
 * `""`, and `RunCreate.variantId` is optional), and surfaces ~19 activity
 * attempts later inside `LlmGateway.generateObject` as
 * `ZodError: variantId: Too small: expected string to have >=1 characters` —
 * a message that reads as a model problem and names neither the run nor the
 * caller that opened it. OPS-22 and OPS-23 died exactly that way.
 *
 * Fail-closed rather than defaulting HERE is deliberate. `run-pins.ts` already
 * owns the fallback (`DEFAULT_ANALYST_VARIANT`), and it can pick a sensible one
 * because it knows the deployment's variants. A second, silent default in the
 * store would paper over a miswired composition root and pin real bank tickets
 * to an agent nobody chose — the store's job is to refuse the row, not to guess
 * what it should have contained.
 */
export class UnpinnedRunError extends Error {
  constructor(ticket: string, missing: "variantId" | "templateVersion") {
    super(
      `run context: refusing to open run for ticket ${ticket} with an empty ${missing} — ` +
        `it is pinned at start (M38/M83) and an empty one fails the LLM gateway's contract ` +
        `on the first model call`,
    );
    this.name = "UnpinnedRunError";
  }
}

export class PrismaRunContextStore implements RunContextStore {
  constructor(private readonly runs: RunDelegate) {}

  /**
   * Fail-closed on both halves.
   *
   * No live run is an error rather than an empty context: an activity that
   * gets `{}` back would carry on with an invented branch name and an empty
   * app, and the first thing it does with either is write to a bank's repo.
   *
   * The application half distinguishes two nulls. A row whose `appId` IS set
   * but whose join came back empty points at an application that no longer
   * exists — the incomplete-context failure it has always been, and inventing
   * a blank `ApplicationRecord` for it would send the engineering turn at
   * repo "". A row whose `appId` is itself null is an analysis-only run: the
   * binding named no application on purpose, `RunContext.app` is honestly
   * `null`, and the activities that need an app refuse for themselves
   * (`appOf` in `impl/delivery.ts`).
   */
  async get(ticket: string): Promise<RunContext> {
    const row = await this.liveRun(ticket);
    if (row === null) throw new RunNotFoundError(ticket);
    if (row.appId !== null && row.application === null) {
      throw new IncompleteRunContextError(ticket, "application");
    }
    return toRunContext(row, row.application);
  }

  /**
   * Open the run's row. Called once, by intake, when Temporal reports that
   * `signalWithStart` actually STARTED an execution (`apps/bff/src/jira-intake.ts`).
   *
   * Every activity reads its context back from this row, so without it the
   * first activity of the first real run fails with `RunNotFoundError` — which
   * is precisely the state this deployment was in: a worker polling an empty
   * task queue because nothing ever wrote a run.
   *
   * Idempotent by intent, not by hope. Two webhook deliveries racing on one
   * ticket both reach here after Temporal has already collapsed them into one
   * execution, so both would try to insert. The pre-check makes the second one
   * a no-op; the partial unique index from migration 0002 is what makes it
   * SAFE, since it rejects a second live row even if both callers pass the
   * check simultaneously. Catching that rejection is deliberate: a unique
   * violation here means the row exists, which is the outcome the caller wanted.
   */
  async create(input: NewRun): Promise<void> {
    // Before the idempotency check, not after: a caller that passes an empty
    // pin has a wiring bug whether or not a row already exists, and letting the
    // second delivery of a webhook return quietly would hide it on exactly the
    // retry that made it reproducible.
    assertPinned(input);
    if ((await this.liveRun(input.ticket)) !== null) return;
    try {
      await this.runs.create({
        data: {
          id: input.runId,
          ticketKey: input.ticket,
          // Omitted, not written as null, for an analysis-only run: the column
          // stays at its schema default and a run that HAS an app writes the
          // exact row it always wrote.
          ...(input.appId === null ? {} : { appId: input.appId }),
          mode: input.mode,
          dataClass: input.dataClass,
          // The workflow's own first step and status. Anything else here would
          // make the row disagree with the execution it describes.
          step: "0",
          status: "running",
          startedAt: input.startedAt,
          variantId: input.variantId,
          templateVersion: input.templateVersion,
          ...(input.locale === undefined ? {} : { locale: input.locale }),
          ...(input.workspacePath === undefined
            ? {}
            : { workspacePath: input.workspacePath, workspacePresent: true }),
        },
      });
    } catch (error) {
      // Only the race is tolerated. Any other failure — a dead connection, a
      // constraint this code does not know about — must reach the caller, or
      // intake reports a started run that has no row and the failure surfaces
      // one activity later as "no live run".
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /**
   * Partial update: a field the caller did not name is left alone.
   *
   * `undefined` is Prisma's "do not touch this column", so the mapping below
   * must never turn an absent key into an explicit value. `prId` and
   * `resumeToken` are the two that can be set BACK to null deliberately, so
   * they are forwarded when present and only then — which is why the
   * `in`-checks below are not the same as a truthiness test.
   */
  async patch(ticket: string, changes: Partial<RunContext>): Promise<void> {
    const row = await this.liveRun(ticket);
    if (row === null) throw new RunNotFoundError(ticket);

    const data = toRunUpdate(changes);
    // Nothing to write is not an error — a caller that patched only fields this
    // store does not own (runId, ticket, app) asked for no change to the row.
    if (Object.keys(data).length === 0) return;
    await this.runs.update({ where: { id: row.id }, data });
  }

  /**
   * The newest non-terminal run for a ticket.
   *
   * "Newest" matters as much as "non-terminal": a ticket that was re-run after
   * a kill switch has several rows, and the partial unique index from migration
   * 0002 only guarantees one of them is LIVE. Ordering by `startedAt` descending
   * means a race that briefly leaves two live rows resolves to the current one
   * rather than the abandoned one.
   */
  private liveRun(ticket: string): Promise<RunRow | null> {
    return this.runs.findFirst({
      where: { ticketKey: ticket, status: { notIn: [...TERMINAL_STATUSES] } },
      orderBy: { startedAt: "desc" },
      include: { application: true },
    });
  }
}

/**
 * The column's string as the contract's union.
 *
 * `get` only ever returns rows the `notIn` filter let through, so in practice
 * this is `running`. Anything else means the filter and this mapper disagree,
 * and calling it `running` is the honest answer: the row IS live by the only
 * definition the store uses.
 */
function toLifecycle(status: string): RunContext["status"] {
  return status === "done" || status === "cancelled" ? status : "running";
}

/**
 * Both start-of-run pins, checked as the gateway will check them.
 *
 * `trim()` before the emptiness test because the gateway's schema is
 * `z.string().min(1)` on a value that reaches it verbatim: `" "` passes a bare
 * length check here, then fails there — which is the whole failure mode this
 * guard exists to stop, one space further along.
 */
function assertPinned(input: NewRun): void {
  if (input.variantId.trim() === "") throw new UnpinnedRunError(input.ticket, "variantId");
  if (input.templateVersion.trim() === "") {
    throw new UnpinnedRunError(input.ticket, "templateVersion");
  }
}

/** `Partial<RunContext>` -> the column subset, dropping absent keys. */
export function toRunUpdate(changes: Partial<RunContext>): RunUpdate {
  const data: RunUpdate = {};
  if (changes.step !== undefined) data.step = changes.step;
  if (changes.status !== undefined) data.status = changes.status;
  if (changes.risk !== undefined && changes.risk !== null) data.risk = changes.risk;
  if (changes.locale !== undefined) data.locale = changes.locale;
  // The pins are write-once-at-open in practice, but `patch` can reach the same
  // two columns — so the same emptiness rule applies here. Dropping an empty
  // pin rather than throwing is the right shape for a PARTIAL update: the
  // caller is asking to change other fields, and un-pinning a live run is not
  // a thing any caller means to do. Keeping the pinned value is the safe half
  // of the invariant `create` enforces at the other end.
  if (changes.variantId !== undefined && changes.variantId.trim() !== "") {
    data.variantId = changes.variantId;
  }
  if (changes.templateVersion !== undefined && changes.templateVersion.trim() !== "") {
    data.templateVersion = changes.templateVersion;
  }
  if (changes.workspacePath !== undefined) data.workspacePath = changes.workspacePath;
  if (changes.workspacePresent !== undefined) data.workspacePresent = changes.workspacePresent;
  if (changes.protectedPaths !== undefined) data.protectedPathsJson = [...changes.protectedPaths];
  if (changes.verification !== undefined) {
    data.verificationJson = changes.verification.map((spec) => ({
      name: spec.name,
      command: [...spec.command],
    }));
  }
  if (changes.branch !== undefined) data.branch = changes.branch;
  if (changes.targetBranch !== undefined) data.targetBranch = changes.targetBranch;
  // Both are nullable in the contract, so `null` is a value to write, not an
  // absence to skip. `"prId" in changes` is what distinguishes the two.
  if ("prId" in changes) data.prId = changes.prId ?? null;
  if ("resumeToken" in changes) data.resumeToken = changes.resumeToken ?? null;
  return data;
}

function toRunContext(row: RunRow, app: ApplicationRow | null): RunContext {
  return {
    runId: row.id,
    ticket: row.ticketKey,
    step: row.step,
    status: toLifecycle(row.status),
    // `null` only for an analysis-only row — `get` already refused the other
    // way a null join can happen (an appId pointing at a vanished application).
    app: app === null ? null : toApplication(app),
    dataClass: row.dataClass as RunContext["dataClass"],
    mode: row.mode as RunContext["mode"],
    locale: row.locale as RunContext["locale"],
    variantId: row.variantId,
    templateVersion: row.templateVersion,
    workspacePath: row.workspacePath,
    workspacePresent: row.workspacePresent,
    protectedPaths: parseStrings(row.protectedPathsJson),
    verification: parseCommands(row.verificationJson),
    branch: row.branch,
    targetBranch: row.targetBranch,
    risk: (row.risk as RunContext["risk"]) ?? null,
    prId: row.prId,
    resumeToken: row.resumeToken,
  };
}

function toApplication(row: ApplicationRow): ApplicationRecord {
  return {
    appId: row.appId,
    displayName: row.displayName,
    adoProject: row.adoProject,
    adoRepo: row.adoRepo,
    platform: row.platform as ApplicationRecord["platform"],
    jiraComponent: row.jiraComponent,
    maestroYamlPresent: row.maestroYamlPresent,
    createdVia: row.createdVia as ApplicationRecord["createdVia"],
  };
}

/**
 * A JSON column holds whatever was written. Anything that is not an array of
 * strings reads as "none" — for `protectedPaths` that is the SAFE direction
 * only because the M52 deny-list these add to lives in `@maestro/workflows`
 * and applies regardless; this column carries the repo's additions, and a
 * malformed value must not be able to remove a path from the base list.
 */
function parseStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * `CommandSpec[]` from a JSON column, structurally validated.
 *
 * A half-parsed command is worse than none: `{ name: "test" }` with no argv
 * would reach the runner as a spawn of `undefined`. Entries that are not a
 * name plus a non-empty string argv are dropped, so what comes back is always
 * runnable.
 */
function parseCommands(value: unknown): CommandSpec[] {
  if (!Array.isArray(value)) return [];
  const specs: CommandSpec[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, command } = entry as { name?: unknown; command?: unknown };
    if (typeof name !== "string" || name.length === 0) continue;
    if (!Array.isArray(command) || command.length === 0) continue;
    if (!command.every((part): part is string => typeof part === "string")) continue;
    specs.push({ name, command });
  }
  return specs;
}
