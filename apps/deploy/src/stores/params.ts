import type { RoutingRule } from "@maestro/contracts";
import { toContractProjectKey } from "@maestro/db";
import { EscalationLadder, NotifyRouting } from "@maestro/notify";
import type { ParamReader } from "@maestro/workflows";
import { z } from "zod";

/**
 * The Postgres-backed `ParamReader` (M71).
 *
 * The database is the SINGLE source of truth for every operational setting.
 * That is why this file contains no fallback ladder and no fallback routing: a
 * default compiled in here would be a second answer to "what is the escalation
 * ladder", and the compiled one would win exactly when the database row is
 * missing — which is the case where an operator most needs to be told.
 *
 * The shipped defaults live once, as DATA, in
 * `DEFAULT_PARAM_DEFINITIONS` (`@maestro/db`), and the installer seeds them as
 * version 1. A missing row here therefore means the install never ran or
 * somebody deleted a parameter, and both are refusals.
 *
 * Values are parsed with the CONSUMING package's own schema — `EscalationLadder`
 * and `NotifyRouting` come from `@maestro/notify`. A JSON column holds whatever
 * was written into it, and a ladder with a malformed step would otherwise
 * surface as an escalation that never fires.
 */

export interface ParamVersionRow {
  key: string;
  scopeRef: string;
  version: number;
  valueJson: unknown;
}

export interface ParamVersionDelegate {
  findMany(args: {
    where: { key: string; scopeRef: { in: string[] } };
    orderBy: { version: "desc" };
  }): Promise<ParamVersionRow[]>;
}

export interface RoutingRuleRow {
  ruleId: string;
  projectKey: string | null;
  conditionJson: unknown;
  effectJson: unknown;
  priority: number;
}

/**
 * `OR`, not `IN`.
 *
 * The obvious spelling — `projectKey: { in: [projectKey, null] }` — is wrong
 * twice over: Prisma's generated filter rejects a nullable member, and SQL
 * itself would too, because `x IN (NULL)` is never true. `NULL` means
 * "org-wide" in this column, so the org-wide rules would have silently
 * vanished from every routing decision. `OR [{ equals }, { equals: null }]`
 * is the predicate that actually matches both.
 */
export interface RoutingRuleDelegate {
  findMany(args: {
    where: { OR: [{ projectKey: string }, { projectKey: null }] };
    orderBy: [{ priority: "asc" }, { ruleId: "asc" }];
  }): Promise<RoutingRuleRow[]>;
}

/** Everything the reader needs to know about the run it is answering for. */
export interface ParamScopeRefs {
  /** Jira project of the run's ticket — the `project` scope's reference. */
  readonly projectKey: string;
  /** The run's application — the `application` scope's reference. */
  readonly appId: string | null;
}

export class MissingParamError extends Error {
  constructor(key: string) {
    super(
      `parameter ${key} has no stored value — settings live in the database (M71) and this ` +
        `package holds no compiled-in default. Run the installer's parameter seed.`,
    );
    this.name = "MissingParamError";
  }
}

export class InvalidParamError extends Error {
  constructor(key: string, detail: string) {
    super(`parameter ${key} is stored but not usable: ${detail}`);
    this.name = "InvalidParamError";
  }
}

/** `publish.targets`: one list per document kind (M47). */
const PublishTargets = z.object({
  analysis: z.array(z.string().min(1)),
  evidence_summary: z.array(z.string().min(1)),
});

/**
 * The parameter keys this reader looks up (M71).
 *
 * Named constants rather than literals at the call sites, because a PARAMETER
 * key and a MESSAGE key are the same shape — `notify.routing` could be either
 * — and `packages/config`'s catalog guard scans the monorepo for that shape to
 * catch a package emitting a message key the catalog lacks. Declaring them
 * here, once, keeps that guard reading real message keys instead of these, and
 * says plainly which rows this reader depends on.
 */
const PARAM_KEYS = {
  escalationLadder: "escalation.ladder",
  notifyRouting: "notify.routing",
  publishTargets: "publish.targets",
} as const;

export class PrismaParamReader implements ParamReader {
  constructor(
    private readonly versions: ParamVersionDelegate,
    private readonly rules: RoutingRuleDelegate,
    /** Run -> its scope references. The reader never guesses a project key. */
    private readonly scopeOf: (runId: string) => Promise<ParamScopeRefs>,
  ) {}

  async escalationLadder(runId: string): Promise<EscalationLadder> {
    return this.read(runId, PARAM_KEYS.escalationLadder, EscalationLadder);
  }

  async notifyRouting(runId: string): Promise<NotifyRouting> {
    return this.read(runId, PARAM_KEYS.notifyRouting, NotifyRouting);
  }

  async publishTargets(runId: string, doc: "analysis" | "evidence_summary"): Promise<string[]> {
    const targets = await this.read(runId, PARAM_KEYS.publishTargets, PublishTargets);
    return [...targets[doc]];
  }

  /**
   * Rules that can apply to a ticket: the ticket's own project plus the
   * org-wide ones (stored `NULL`, spelled `"*"` in the contract — the
   * translation is `@maestro/db`'s, never re-invented here).
   *
   * Ordered by priority, then by id. The tie-break is not decoration: two
   * rules at the same priority would otherwise be applied in whatever order
   * the planner returned them, and a routing decision that depends on the
   * query plan is a routing decision nobody can reproduce from the rules.
   */
  async routingRules(ticket: string): Promise<RoutingRule[]> {
    const projectKey = projectOfTicket(ticket);
    const rows = await this.rules.findMany({
      where: { OR: [{ projectKey }, { projectKey: null }] },
      orderBy: [{ priority: "asc" }, { ruleId: "asc" }],
    });
    return rows.map((row) => ({
      ruleId: row.ruleId,
      projectKey: toContractProjectKey(row.projectKey),
      condition: row.conditionJson,
      effect: row.effectJson,
      priority: row.priority,
    })) as RoutingRule[];
  }

  /**
   * Most specific scope wins: application, then project, then global.
   *
   * The precedence is applied HERE, over the candidate refs, and deliberately
   * not as a `scopeRef DESC` in the query. Sorting the column would rank the
   * scopes ALPHABETICALLY, and the refs are a project key and an application
   * id — `"PAY"` sorts above `"core-api"` because uppercase precedes
   * lowercase, so a project row would silently beat the application override
   * that was meant to win. The bug is invisible whenever the two happen to
   * sort the right way round, which is most of the time.
   *
   * Within the winning scope, the newest version is taken — that ordering IS
   * numeric, so the database does it.
   */
  private async read<T>(runId: string, key: string, schema: z.ZodType<T>): Promise<T> {
    const scope = await this.scopeOf(runId);
    // Least specific first; the search below walks it backwards.
    const refs = ["", scope.projectKey, ...(scope.appId === null ? [] : [scope.appId])];
    const rows = await this.versions.findMany({
      where: { key, scopeRef: { in: refs } },
      orderBy: { version: "desc" },
    });

    let row: ParamVersionRow | undefined;
    for (let i = refs.length - 1; i >= 0 && row === undefined; i--) {
      row = rows.find((candidate) => candidate.scopeRef === refs[i]);
    }
    if (row === undefined) throw new MissingParamError(key);

    const parsed = schema.safeParse(row.valueJson);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new InvalidParamError(key, issues);
    }
    return parsed.data;
  }
}

/**
 * `PAY-101` -> `PAY`. The ticket key's own prefix is the project key; there is
 * no lookup to do and no place for one to disagree.
 */
export function projectOfTicket(ticket: string): string {
  const dash = ticket.lastIndexOf("-");
  return dash === -1 ? ticket : ticket.slice(0, dash);
}
