import { JiraArgumentError, JiraResponseError } from "../errors.js";

/**
 * WRITING a Jira transition to hand an unfit ticket back to its reporter (İADE).
 *
 * The read-only `workflow.ts` layer maps a project's status graph for Studio's
 * import screen and never moves an issue. This module is its write counterpart,
 * built for the pilot's "İADE" (return) branch: when the intake role judges a
 * ticket too thin to analyse, Maestro does not merely ask and wait — it moves
 * the ticket to a backlog/To-Do status and reassigns it to the reporter, so the
 * ticket physically lands back in the reporter's court.
 *
 * A deliberate honesty note. The transition NAME is never hard-coded. Jira sites
 * rename their columns ("Yapılacaklar", "To Do", "Backlog", …) and a hard-coded
 * name would break the moment a site renames its board. Instead the target is
 * chosen by the status CATEGORY Jira itself reports on each available
 * transition's destination — the `To Do` category (Cloud key `new`) is the
 * backlog side of every Jira workflow regardless of the localised column name.
 * `GET /issue/{key}/transitions?expand=transitions.fields` returns each
 * transition WITH its destination status and that status's category, which is
 * exactly what the selection below reads.
 *
 * NOTHING here bypasses the frozen `WorkPort.transition` no-op: this is a
 * driver-specific capability reached through the concrete `JiraCloudWorkPort`
 * (the same shape as `addAttachment` / `readProjectWorkflow`), and the frozen
 * port surface is untouched.
 */

/** The status-category KEY Jira Cloud reports for a backlog/To-Do status. */
export const TODO_CATEGORY_KEY = "new";
/** The human-facing status-category NAME Jira Cloud reports for a To-Do status. */
export const TODO_CATEGORY_NAME = "To Do";

/** The status-category KEY / NAME Jira Cloud reports for a DONE status — where a
 * merged ticket is moved so it does not linger open after the work is finished. */
export const DONE_CATEGORY_KEY = "done";
export const DONE_CATEGORY_NAME = "Done";

/**
 * The status-category KEY / NAME Jira Cloud reports for an IN-PROGRESS status —
 * the category "İNCELEMEDE" (review) sits in. Used by the analysis-approval
 * handover (send-to-review): the review column is renamed per site, but its
 * CATEGORY is always `indeterminate` / "In Progress", so category is the honest
 * fallback when the preferred status name is not matched.
 */
export const IN_PROGRESS_CATEGORY_KEY = "indeterminate";
/** The human-facing status-category NAME Jira Cloud reports for an In-Progress status. */
export const IN_PROGRESS_CATEGORY_NAME = "In Progress";

/**
 * The DEFAULT review status name the analysis handover moves a ticket to, before
 * category fallback (the live OPS workflow's review column). NEVER the sole
 * selection key: a site may rename it, so `selectReviewTransition` matches this
 * name FIRST and then falls back to the In-Progress category.
 */
export const DEFAULT_REVIEW_STATUS_NAME = "İNCELEMEDE";

/** One transition available from an issue's current status, with its destination. */
export interface AvailableTransition {
  id: string;
  name: string;
  /** Destination status id. */
  toStatusId: string;
  /** Destination status name (localised, e.g. "Yapılacaklar"). */
  toStatusName: string;
  /** Destination status-category KEY (`new` | `indeterminate` | `done`). */
  toCategoryKey: string;
  /** Destination status-category NAME (`To Do` | `In Progress` | `Done`). */
  toCategoryName: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * Normalize `GET /issue/{key}/transitions` into the available transitions WITH
 * each destination status's category, so a caller can pick a target by category
 * rather than by a brittle localised name. A payload that carries no
 * `transitions` array fails loudly — a silent empty list would read as "this
 * issue can go nowhere", hiding a real API/permission problem.
 */
export function parseAvailableTransitions(raw: unknown): AvailableTransition[] {
  const body = record(raw);
  const transitions = body?.["transitions"];
  if (!Array.isArray(transitions)) {
    throw new JiraResponseError("issue transitions", ["response carries no transitions array"]);
  }
  const out: AvailableTransition[] = [];
  for (const entry of transitions) {
    const transition = record(entry);
    if (!transition) continue;
    const id = nonEmptyString(transition["id"]);
    const name = nonEmptyString(transition["name"]);
    const to = record(transition["to"]);
    const toStatusId = to ? nonEmptyString(to["id"]) : null;
    if (id === null || name === null || to === null || toStatusId === null) continue;
    const toStatusName = nonEmptyString(to["name"]) ?? "";
    const category = record(to["statusCategory"]);
    const toCategoryKey = (category ? nonEmptyString(category["key"]) : null) ?? "";
    const toCategoryName = (category ? nonEmptyString(category["name"]) : null) ?? "";
    out.push({ id, name, toStatusId, toStatusName, toCategoryKey, toCategoryName });
  }
  return out;
}

/**
 * Choose the transition that hands the ticket back to the backlog — the one
 * whose DESTINATION status sits in the `To Do` category. Selection is by
 * category, never by a hard-coded transition or status name:
 *
 *   1. A destination in the `To Do` category (key `new`, or name `To Do` for a
 *      site that omits the key) — the backlog side of the workflow.
 *   2. Among several To-Do destinations, the first Jira offers is used (Jira
 *      lists them in workflow order; the caller may narrow later).
 *
 * Returns `null` when the issue's current status offers NO To-Do transition
 * (e.g. it is already in a To-Do status, or the workflow forbids going back).
 * The caller treats that as "nothing to move" rather than an error, so an
 * already-backlogged ticket is not a failure.
 */
export function selectReturnTransition(
  transitions: readonly AvailableTransition[],
): AvailableTransition | null {
  for (const transition of transitions) {
    if (isTodoCategory(transition)) return transition;
  }
  return null;
}

function isTodoCategory(transition: AvailableTransition): boolean {
  return (
    transition.toCategoryKey.toLowerCase() === TODO_CATEGORY_KEY ||
    transition.toCategoryName.trim().toLowerCase() === TODO_CATEGORY_NAME.toLowerCase()
  );
}

/**
 * Choose the transition that CLOSES the ticket — the one whose destination sits
 * in the `Done` category. Selection is by category, never by a hard-coded status
 * name (a site renames "Done" to "Tamamlandı", "Kapandı" etc., but the CATEGORY
 * key stays `done`). Returns `null` when the current status offers no Done
 * transition (already closed, or the workflow forbids it); the caller treats
 * that as "nothing to move", never a failure — the merge already succeeded.
 */
export function selectDoneTransition(
  transitions: readonly AvailableTransition[],
): AvailableTransition | null {
  for (const transition of transitions) {
    if (isDoneCategory(transition)) return transition;
  }
  return null;
}

function isDoneCategory(transition: AvailableTransition): boolean {
  return (
    transition.toCategoryKey.toLowerCase() === DONE_CATEGORY_KEY ||
    transition.toCategoryName.trim().toLowerCase() === DONE_CATEGORY_NAME.toLowerCase()
  );
}

/**
 * Choose the transition that moves the ticket INTO REVIEW — the destination the
 * analysis-approval handover parks a ticket at while the Analyst Manager reviews
 * it. Selection is honest about localisation, in two ordered passes:
 *
 *   1. A destination whose status NAME equals `preferredName` (default
 *      "İNCELEMEDE"), case-insensitively — the exact review column when the site
 *      has one. This is preferred so that a workflow with several In-Progress
 *      statuses (e.g. "Devam Ediyor" AND "İNCELEMEDE", both `indeterminate`)
 *      lands on the review one, not merely the first in-progress edge.
 *   2. Failing that, the first destination in the `In Progress` category (key
 *      `indeterminate`, or name `In Progress`) — the honest fallback for a site
 *      that renamed its review column, since the CATEGORY is stable.
 *
 * Returns `null` when the current status offers NO in-progress transition (the
 * ticket may already be in review, or the workflow forbids it). The caller
 * treats that as "already there / cannot move", never a hard failure — the
 * handover still reassigns to the manager.
 */
export function selectReviewTransition(
  transitions: readonly AvailableTransition[],
  preferredName: string = DEFAULT_REVIEW_STATUS_NAME,
): AvailableTransition | null {
  const wanted = preferredName.trim().toLowerCase();
  if (wanted.length > 0) {
    for (const transition of transitions) {
      if (transition.toStatusName.trim().toLowerCase() === wanted) return transition;
    }
  }
  for (const transition of transitions) {
    if (isInProgressCategory(transition)) return transition;
  }
  return null;
}

function isInProgressCategory(transition: AvailableTransition): boolean {
  return (
    transition.toCategoryKey.toLowerCase() === IN_PROGRESS_CATEGORY_KEY ||
    transition.toCategoryName.trim().toLowerCase() === IN_PROGRESS_CATEGORY_NAME.toLowerCase()
  );
}

/** Guard a transition id before it is POSTed. */
export function requireTransitionId(value: string): string {
  const id = value.trim();
  if (id.length === 0) throw new JiraArgumentError("transitionId", "empty");
  return id;
}

/**
 * Fold Turkish's four-way i (i · ı · İ · I) onto ONE letter before comparing
 * status names.
 *
 * The live OPS workflow shouts its review column — the recorded transitions
 * carry `to.name === "İNCELEMEDE"` while a caller (and Studio's config) writes
 * it "İncelemede". Plain `toLowerCase()` leaves "İ" as "i̇" (i + combining dot),
 * so the two never match; `toLocaleLowerCase("tr")` is no better on its own,
 * because it maps "I" onto "ı" and so splits dotless from dotted instead. Either
 * way a status the site really offers would read as "no such transition" and the
 * ticket would silently stay put.
 *
 * So the i-family is folded EXPLICITLY, then lowercased, then NFC-normalised so
 * a decomposed "İ" (I + U+0307) compares equal to the precomposed one — a real
 * difference between what a human types and what Jira stores. The result never
 * depends on the host's locale, which is what makes it safe on a server whose
 * ICU default is not Turkish. Same idiom as `fold()` in @maestro/agent-roles;
 * duplicated rather than depended on, since this package deliberately carries no
 * dependency on the role package.
 */
const I_FOLD: Record<string, string> = { İ: "i", I: "i", ı: "i", i: "i" };

export function foldStatusName(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[İIıi]/gu, (c) => I_FOLD[c] ?? c)
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Find the transition that lands the issue in `statusName`, in two ordered
 * passes — the DESTINATION status name first, the transition's own name second.
 *
 * The order is not cosmetic. On the live OPS workflow the two genuinely differ:
 * transition id 31 is named "In Review" but moves the issue to the status
 * "İNCELEMEDE", and id 21 is named "Devam Ediyor" moving to "Devam Ediyor". A
 * caller says where it wants the ticket to END UP, so the destination is the
 * honest key; matching the transition name is only the courtesy fallback for a
 * site whose button is named after the target it does not literally name.
 *
 * Returns `null` when neither pass matches — "this workflow offers no such
 * move", which the caller reports rather than throws (the policy is warn and
 * continue, not fail the run).
 */
export function selectTransitionByStatusName(
  transitions: readonly AvailableTransition[],
  statusName: string,
): AvailableTransition | null {
  const wanted = foldStatusName(statusName);
  if (wanted.length === 0) return null;
  for (const transition of transitions) {
    if (foldStatusName(transition.toStatusName) === wanted) return transition;
  }
  for (const transition of transitions) {
    if (foldStatusName(transition.name) === wanted) return transition;
  }
  return null;
}
