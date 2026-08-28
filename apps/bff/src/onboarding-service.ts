import { MatchResult } from "@maestro/contracts";
import type { ResolvedDeps } from "./deps.js";
import { conflict, notFound } from "./errors.js";
import type { OnboardingSampleTicket } from "./onboarding-models.js";

/**
 * The onboarding decisions, away from the HTTP layer (M93/M102).
 *
 * Two things live here, and both are the reason the wizard exists rather than a
 * form that writes a row: the dry run, which answers "where would the last N
 * tickets have landed", and the checks that stand between a draft and a
 * proposal. The route is thin on purpose — a check that only happens because a
 * handler remembered to call it is a check that the next handler forgets.
 */

/** How many tickets a dry run replays when the caller does not say (M102). */
export const DEFAULT_DRY_RUN_SAMPLE = 20;
export const MAX_DRY_RUN_SAMPLE = 200;

/**
 * The three buckets of M99, as Studio renders them.
 *
 * Separate lists rather than one list with a tier field, because the screen
 * acts on them differently and the shape is Studio's (`DryRunResult` in
 * `screens/common/onboarding-api.ts`): tier 1 is settled, tier 2 needs a human
 * to confirm the AI's guess, and tier 3 has no home at all.
 */
export interface DryRunBuckets {
  readonly byRule: readonly string[];
  readonly bySuggestion: readonly string[];
  readonly unresolved: readonly string[];
  /**
   * Distinct tickets replayed — the sum of the three buckets, not the number of
   * rows read.
   *
   * It is reported because three empty buckets have two very different causes:
   * a project with no history, and a project whose every ticket resolved. The
   * screen must be able to tell an operator "this proved nothing" rather than
   * showing them a clean sheet they would read as a pass.
   */
  readonly sampled: number;
}

/**
 * Sort a replayed ticket into its M99 tier.
 *
 * The stored `MatchResult` is parsed through the CONTRACT's own validator, not
 * read field by field: a `matchJson` column that does not parse is a row this
 * function must not interpret, and the fail-closed answer for one is
 * `unresolved` — "a human has to look at this" — rather than a guess at which
 * tier its author meant. A corrupt match that counted as `byRule` would tell
 * the operator a ticket is settled when nothing settled it.
 *
 * `analysis_fanout` counts as resolved-by-rule: a child ticket inherits its
 * parent's application from the impact matrix (M100), which is a deterministic
 * assignment with no human confirmation outstanding. `human` counts as
 * resolved-by-suggestion: somebody assigned it by hand, so under NEW rules the
 * same ticket would need a person again.
 */
export type DryRunTier = "byRule" | "bySuggestion" | "unresolved";

export function tierOf(sample: OnboardingSampleTicket): DryRunTier {
  const parsed = MatchResult.safeParse(sample.match);
  if (!parsed.success) return "unresolved";

  switch (parsed.data.via) {
    case "rule":
    case "analysis_fanout":
      return "byRule";
    case "ai_suggestion":
    case "human":
      return "bySuggestion";
    // A greenfield onboarding match names no application: the ticket created
    // the app rather than being routed to one, so it is not evidence that
    // these rules would route anything.
    case "onboarding":
      return "unresolved";
  }
}

/**
 * Replay a sample of a project's real runs through the tier rules.
 *
 * Nothing here is invented: every ticket key is a `WorkflowRun` row and every
 * tier comes from that row's own recorded `MatchResult`. A project with no runs
 * yields three empty buckets, which the route reports as a dry run that proved
 * nothing rather than as a clean one.
 */
export function bucketize(samples: readonly OnboardingSampleTicket[]): DryRunBuckets {
  const byRule: string[] = [];
  const bySuggestion: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const sample of samples) {
    // A ticket with several runs (a retry, a re-open) is one ticket in the
    // answer. Counting it twice would inflate whichever bucket it landed in and
    // make a 20-ticket sample report 26 outcomes.
    if (seen.has(sample.ticketKey)) continue;
    seen.add(sample.ticketKey);

    const bucket = tierOf(sample);
    if (bucket === "byRule") byRule.push(sample.ticketKey);
    else if (bucket === "bySuggestion") bySuggestion.push(sample.ticketKey);
    else unresolved.push(sample.ticketKey);
  }

  return { byRule, bySuggestion, unresolved, sampled: seen.size };
}

export interface OnboardingTarget {
  readonly jiraProject: string;
  readonly adoRepo: string;
}

/**
 * The checks a dry run and a submission BOTH have to pass, in one place.
 *
 * Every one of them is a way the wizard can be pointed at something that does
 * not exist or is already taken, and each has to be reported by name — the
 * screen's job is to tell an operator what is wrong, and "something went wrong"
 * is not an answer they can act on. Returns the repo it resolved, because the
 * caller needs it and looking it up twice invites the two lookups to disagree.
 */
export async function assertBindable(
  deps: ResolvedDeps,
  target: OnboardingTarget,
): Promise<{ appId: string; platform: string }> {
  const options = await deps.read.onboarding.options({ limit: MAX_DRY_RUN_SAMPLE, cursor: null });

  const repo = options.repos.find(
    (candidate) => candidate.appId === target.adoRepo || candidate.repo === target.adoRepo,
  );
  // An application that is not in the registry is a typo, not a new app: the
  // wizard binds to repositories somebody already onboarded, and accepting an
  // unknown one would file a proposal to route tickets at a repo that has no row.
  if (repo === undefined) throw notFound("unknown_app", { appId: target.adoRepo });

  assertProjectFree(options.projects, target.jiraProject);
  return { appId: repo.appId, platform: repo.platform };
}

/**
 * The project half of `assertBindable`, on its own.
 *
 * The submit path calls this BEFORE it registers a repo, so a draft naming a
 * project that does not exist or is already bound is refused without leaving a
 * freshly-written app row behind it. Registering the repo and then discovering
 * the project is unusable would strand an inventory entry the operator never got
 * a proposal for — the exact half-finished state the wizard must not create.
 */
export async function assertProjectBindable(
  deps: ResolvedDeps,
  projectKey: string,
): Promise<void> {
  const options = await deps.read.onboarding.options({ limit: MAX_DRY_RUN_SAMPLE, cursor: null });
  assertProjectFree(options.projects, projectKey);
}

function assertProjectFree(
  projects: readonly { projectKey: string; state: string | null }[],
  projectKey: string,
): void {
  const project = projects.find((candidate) => candidate.projectKey === projectKey);

  // A project absent from the binding table is not an error: it is a project
  // nobody has onboarded yet, which is exactly what the wizard is for. The
  // screen only offers projects it read LIVE off Jira, so a key reaching here is
  // a real project — the binding table is a record of what is ALREADY bound, not
  // the set of projects that exist (M102).
  if (project === undefined) return;

  // A project that is already live belongs to somebody. Re-binding it would
  // redirect a running project's tickets into a different repository, which is
  // exactly the M14/M99 mistake the dry run exists to catch — so it is refused
  // here rather than reported as a warning the operator can click past.
  if (project.state !== null && ACTIVE_BINDING_STATES.includes(project.state)) {
    throw conflict("project_already_bound", { projectKey, state: project.state });
  }
}

/**
 * Binding states that mean "somebody else already owns this project".
 *
 * `draft` and `unbound` are absent deliberately: a draft is a wizard run that
 * was never approved and an unbound project was given back, so both are
 * available to bind. `dry_run` IS taken — a rehearsal in progress is somebody's
 * work, and quietly re-pointing it would discard their evidence.
 */
export const ACTIVE_BINDING_STATES: readonly string[] = ["active", "paused", "dry_run"];
