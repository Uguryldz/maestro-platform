import type {
  OnboardingOptionsRecord,
  OnboardingProject,
  OnboardingReader,
  OnboardingSampleTicket,
  PageRequest,
  RepoPolicyReader,
  RepoPolicyRecord,
} from "@maestro/bff";
import type { TicketKey } from "@maestro/contracts";
import { PlatformProfile } from "@maestro/contracts";

/**
 * The onboarding wizard's lists and the repo-policy screen, over Postgres
 * (M93/M102/M52).
 *
 * Both read tables the platform already writes: `JiraProjectBinding` for what
 * is bound, `Application` for what may be bound to, and `WorkflowRun` for what
 * a project's tickets actually did. Nothing here is generated — the dry run in
 * particular replays REAL runs and reads each one's recorded `MatchResult`,
 * because "where would the last N tickets land" is a question only the history
 * can answer honestly.
 */

// ── delegates ─────────────────────────────────────────────────────────────────

export interface BindingListRow {
  projectKey: string;
  state: string;
}

export interface BindingListDelegate {
  findMany(args: {
    orderBy: { projectKey: "asc" };
    take: number;
  }): Promise<BindingListRow[]>;
  findUnique(args: { where: { projectKey: string } }): Promise<BindingListRow | null>;
}

export interface ApplicationListRow {
  appId: string;
  adoProject: string;
  adoRepo: string;
  platform: string;
  maestroYamlPresent: boolean;
}

export interface ApplicationListDelegate {
  findMany(args: { orderBy: { appId: "asc" }; take: number }): Promise<ApplicationListRow[]>;
  findUnique(args: { where: { appId: string } }): Promise<ApplicationListRow | null>;
}

/** The `WorkflowRun` columns the dry run and the policy reader need. */
export interface RunSampleRow {
  ticketKey: string;
  appId: string | null;
  matchJson: unknown;
  protectedPathsJson: unknown;
  verificationJson: unknown;
  updatedAt: Date;
}

/**
 * Deliberately NOT named `findMany`.
 *
 * `PrismaRunCatalog` already declares a `findMany` over the same table with a
 * different `where` shape (`ticketKey: string` there, `{ startsWith }` here),
 * and `ReadModelDb` intersects the two delegate types. Two `findMany` overloads
 * that disagree about one field's type intersect to a signature nothing can
 * implement — the real Prisma client accepts both, but a test fake cannot, and
 * a delegate no fake can satisfy is a delegate no test can exercise.
 *
 * `findManySamples` is bound to the same `workflowRun.findMany` at the
 * composition root (`sampleDelegate` below), so this is a naming seam and not a
 * second query path.
 */
export interface RunSampleDelegate {
  findManySamples(args: {
    where: { ticketKey?: { startsWith: string }; appId?: string };
    orderBy: { startedAt: "desc" };
    take: number;
  }): Promise<RunSampleRow[]>;
}

/** Adapt a Prisma `workflowRun` delegate to {@link RunSampleDelegate}. */
export function runSampleDelegate(runs: {
  findMany(args: unknown): Promise<unknown>;
}): RunSampleDelegate {
  return {
    findManySamples: (args) => runs.findMany(args) as Promise<RunSampleRow[]>,
  };
}

// ── projects the wizard may bind ──────────────────────────────────────────────

/**
 * Which Jira projects the wizard offers.
 *
 * Every project with a binding row appears, whatever its state, because the
 * screen's selects need to be able to show an operator the project they came
 * to connect — and the conflict is then reported by name at dry-run and submit
 * time. A list that hid bound projects would make "why is my project missing"
 * an unanswerable question.
 *
 * A project with NO row cannot be listed: Jira is the source of those and this
 * platform has no read side for it (the single global webhook is how projects
 * arrive, M102). That is a real gap and the route reports what it has rather
 * than inventing project keys.
 */
export class PrismaOnboardingReader implements OnboardingReader {
  constructor(
    private readonly bindings: BindingListDelegate,
    private readonly applications: ApplicationListDelegate,
    private readonly runs: RunSampleDelegate,
  ) {}

  async options(request: PageRequest): Promise<OnboardingOptionsRecord> {
    const [bindingRows, appRows] = await Promise.all([
      this.bindings.findMany({ orderBy: { projectKey: "asc" }, take: request.limit }),
      this.applications.findMany({ orderBy: { appId: "asc" }, take: request.limit }),
    ]);

    const repos = appRows.map((row) => ({
      appId: row.appId,
      repo: `${row.adoProject}/_git/${row.adoRepo}`,
      platform: row.platform,
    }));

    return {
      projects: bindingRows.map((row) => ({ projectKey: row.projectKey, state: row.state })),
      repos,
      // Every platform profile the contract defines (M60) — not just the ones
      // already present in the registry. Deriving the list from existing apps
      // made the FIRST onboarding impossible: an empty registry offered no
      // profile, so no app could be created, so the registry stayed empty. The
      // wizard is exactly the moment a new toolchain enters the platform, so it
      // must offer all of them.
      platforms: [...PlatformProfile.options],
    };
  }

  async binding(projectKey: string): Promise<OnboardingProject | null> {
    const row = await this.bindings.findUnique({ where: { projectKey } });
    return row === null ? null : { projectKey: row.projectKey, state: row.state };
  }

  /**
   * The project's most recent runs, newest first.
   *
   * Matched by ticket prefix (`UGURPAY-123` belongs to `UGURPAY`) because a run
   * row carries a ticket key and not a project key. The separator is included
   * in the prefix so `UGURPAY` does not also match a `UGURPAYX-1` ticket.
   */
  async recentTickets(projectKey: string, limit: number): Promise<readonly OnboardingSampleTicket[]> {
    const rows = await this.runs.findManySamples({
      where: { ticketKey: { startsWith: `${projectKey}-` } },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
    return rows.map((row) => ({
      ticketKey: row.ticketKey as TicketKey,
      appId: row.appId,
      match: row.matchJson,
    }));
  }
}

// ── repo policy (M52/M71) ─────────────────────────────────────────────────────

/**
 * `.maestro.yaml` as the platform last OBSERVED it.
 *
 * There is no `.maestro.yaml` table. The file lives in the repository and the
 * platform's only copy is what a run read when it cloned: `WorkflowRun`'s
 * `protectedPathsJson` and `verificationJson` columns, written by the engineering
 * turn. So the policy is assembled from the newest run of each application, and
 * an application with no runs reports `observedAt: null` and `yamlPresent`
 * false — the platform has never looked, which is a different statement from
 * "the file is empty" and the screen renders it differently.
 */
export class PrismaRepoPolicyReader implements RepoPolicyReader {
  constructor(
    private readonly applications: ApplicationListDelegate,
    private readonly runs: RunSampleDelegate,
  ) {}

  async list(request: PageRequest): Promise<readonly RepoPolicyRecord[]> {
    const apps = await this.applications.findMany({
      orderBy: { appId: "asc" },
      take: request.limit,
    });
    return Promise.all(apps.map((app) => this.assemble(app)));
  }

  async get(appId: string): Promise<RepoPolicyRecord | null> {
    const app = await this.applications.findUnique({ where: { appId } });
    return app === null ? null : this.assemble(app);
  }

  private async assemble(app: ApplicationListRow): Promise<RepoPolicyRecord> {
    const rows = await this.runs.findManySamples({
      where: { appId: app.appId },
      orderBy: { startedAt: "desc" },
      take: 1,
    });
    const newest = rows[0];

    return {
      appId: app.appId,
      platform: app.platform,
      repo: `${app.adoProject}/_git/${app.adoRepo}`,
      yamlPresent: app.maestroYamlPresent,
      repoAdditions: newest === undefined ? [] : parsePaths(newest.protectedPathsJson),
      verification: newest === undefined ? [] : parseCommands(newest.verificationJson),
      observedAt: newest === undefined ? null : newest.updatedAt.toISOString(),
    };
  }
}

/**
 * `protectedPathsJson` is a JSON column, so what comes out is genuinely
 * unknown. A row that is not an array of strings yields NOTHING rather than a
 * partial list: a deny-list that silently dropped its unreadable half would
 * show an operator fewer protections than the runner actually enforces, and
 * they would add the "missing" ones back as duplicates.
 */
function parsePaths(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.every((entry) => typeof entry === "string") ? (value as string[]) : [];
}

/** Same rule for the verification commands: all of it, or none of it. */
function parseCommands(
  value: unknown,
): readonly { readonly name: string; readonly command: readonly string[] }[] {
  if (!Array.isArray(value)) return [];
  const specs: { name: string; command: string[] }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const name = record["name"];
    const command = record["command"];
    if (typeof name !== "string") return [];
    if (!Array.isArray(command) || !command.every((part) => typeof part === "string")) return [];
    specs.push({ name, command: command as string[] });
  }
  return specs;
}
