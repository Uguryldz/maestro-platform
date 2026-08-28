import type { TicketKey } from "@maestro/contracts";
import type { PageRequest } from "./read-models.js";

/**
 * The read side of onboarding (M93/M102) and of the repo policy screen (M52/M71).
 *
 * Separate from `read-models.ts` for the same reason `onboarding-api.ts` is
 * separate from `admin-api.ts` on the Studio side: both files are read models,
 * neither fits in the other's 300-line budget. The split is mechanical, not a
 * boundary — `ReadModels` gains these two the same way it holds the other twelve.
 *
 * What is NOT here is a writer. Binding a Jira project to a repository decides
 * where an agent is allowed to push code, so it never happens as a side effect
 * of a read: the write path files a PROPOSAL through `ParamStore.putPending`,
 * which is the same four-eyes channel a guarded parameter uses (M32/M71/M78).
 */

// ── onboarding options (M93) ──────────────────────────────────────────────────

/** A Jira project as the wizard sees it, with whatever binding it already has. */
export interface OnboardingProject {
  readonly projectKey: string;
  /**
   * The binding's state, or `null` when the project has no row at all.
   *
   * `null` and `"unbound"` are different facts and the wizard shows them
   * differently: nobody ever bound this project, versus somebody bound it and
   * then took it back. Collapsing them would hide an unbind.
   */
  readonly state: string | null;
}

/** A repository the wizard may bind a project to — an `Application` row (M100). */
export interface OnboardingRepo {
  readonly appId: string;
  /** `<adoProject>/_git/<adoRepo>`, the form Studio's select displays. */
  readonly repo: string;
  readonly platform: string;
}

/**
 * Everything the wizard's selects are built from.
 *
 * The lists are of what EXISTS, not of what is free: a project that is already
 * bound still appears, carrying its state, because the dry run and the submit
 * path have to be able to say "this one is taken" about a value the operator
 * actually selected. A select that silently omitted bound projects would make a
 * conflict unreportable — the user would just never see the option and would
 * have no idea why.
 */
export interface OnboardingOptionsRecord {
  readonly projects: readonly OnboardingProject[];
  readonly repos: readonly OnboardingRepo[];
  /** Distinct `Application.platform` values actually present in the registry. */
  readonly platforms: readonly string[];
}

/**
 * A ticket the dry run replays, drawn from `WorkflowRun` rows.
 *
 * `matchJson` is the run's own `MatchResult` (M99) — how this ticket ACTUALLY
 * got its application. The dry run reads it rather than re-deciding, because
 * the question the screen asks is "where would the last N tickets have landed",
 * and the honest answer to that is the record of where they did land.
 */
export interface OnboardingSampleTicket {
  readonly ticketKey: TicketKey;
  readonly appId: string | null;
  /** The stored `MatchResult`, or `null` when the run never recorded one. */
  readonly match: unknown;
}

export interface OnboardingReader {
  options(request: PageRequest): Promise<OnboardingOptionsRecord>;
  /**
   * The most recent runs in a project, newest first, capped by `limit`.
   *
   * Empty is a legitimate answer here and the route says so out loud rather
   * than rendering a clean dry run: a project with no history has nothing to
   * replay, which is a reason to be careful and not a reason to be reassured.
   */
  recentTickets(projectKey: string, limit: number): Promise<readonly OnboardingSampleTicket[]>;
  /** The binding row for a project, or `null` when it was never bound (M102). */
  binding(projectKey: string): Promise<OnboardingProject | null>;
}

// ── repo policy (M52/M71) ─────────────────────────────────────────────────────

/**
 * One application's `.maestro.yaml` as the platform last observed it.
 *
 * Every field is what was READ from a run, never a default. `yamlPresent`
 * false is the interesting case: it means the platform looked and the file was
 * not there, which stops the flow (M52) rather than falling back to invented
 * build commands.
 */
export interface RepoPolicyRecord {
  readonly appId: string;
  readonly platform: string;
  readonly repo: string;
  readonly yamlPresent: boolean;
  /** The repo's ADDITIONS to the deny-list; the platform floor is not stored here. */
  readonly repoAdditions: readonly string[];
  /** `.maestro.yaml`'s verification commands, as the run recorded them. */
  readonly verification: readonly { readonly name: string; readonly command: readonly string[] }[];
  /** When the observation was made; `null` when no run has ever read the file. */
  readonly observedAt: string | null;
}

export interface RepoPolicyReader {
  list(request: PageRequest): Promise<readonly RepoPolicyRecord[]>;
  /** One application's policy, or `null` when the app is not in the registry. */
  get(appId: string): Promise<RepoPolicyRecord | null>;
}
