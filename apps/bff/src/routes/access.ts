import type { TicketKey } from "@maestro/contracts";
import type { SessionRecord } from "../deps.js";
import { forbidden } from "../errors.js";
import { projectKeyOf } from "../jira-intake.js";

/**
 * Who may see what (M86). Extracted from `routes/runs.ts` so the read
 * endpoints added for Studio share ONE definition of project visibility with
 * the signal endpoints: two copies of this rule would eventually disagree, and
 * the copy that disagrees in the caller's favour is the one nobody notices.
 */

/**
 * Roles that see every project. An admin operates the platform and a tech lead
 * carries the gates across teams (M86); everyone else sees the projects they
 * belong to.
 */
export const CROSS_PROJECT_ROLES = ["admin", "tech-lead"] as const;

/**
 * The directory group that grants access to a project's runs. Membership lives
 * in AD (M8) and the naming convention is the seam: `UGURPAY` → `maestro-ugurpay`.
 * A per-project mapping belongs in the bindings once M102's onboarding wizard
 * owns it; until then the convention is explicit and testable rather than
 * implied.
 */
export function projectGroupFor(projectKey: string): string {
  return `maestro-${projectKey.toLowerCase()}`;
}

/** True when the session may see this project at all (M86). */
export function canSeeProject(session: SessionRecord, projectKey: string): boolean {
  if (CROSS_PROJECT_ROLES.some((role) => session.roles.includes(role))) return true;
  return session.groups.includes(projectGroupFor(projectKey));
}

/**
 * Fail-closed project membership. The gate decision keeps its own, stricter
 * check (`verifyMembership` against the gate's owning group) — this one only
 * establishes that the caller has any business with the ticket at all.
 *
 * Checked BEFORE the run is looked up wherever it is used: answering 404 for a
 * project the caller cannot see would turn the route into a ticket oracle.
 */
export function assertProjectAccess(session: SessionRecord, ticket: TicketKey): void {
  if (!canSeeProject(session, projectKeyOf(ticket))) {
    throw forbidden("project_access", { ticket });
  }
}
