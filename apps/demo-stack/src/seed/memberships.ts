import { DEFAULT_GATE_OWNER_GROUPS } from "@maestro/bff";
import { actorOf, DEMO_ACCOUNTS } from "./users.js";

/**
 * Who is in which gate-owning group, as `WorkPort.verifyMembership` answers it.
 *
 * This is NOT the same thing as the session's `groups`, and conflating them is
 * the bug this file exists to avoid. Session groups are directory membership and
 * decide which PROJECTS a person can see (`maestro-ugurpay`). Gate ownership is
 * checked separately, against the group the gate directory names for the step
 * (`tech-leads`, `product-owners`, `qa`) and through the work system's own
 * membership call — because in production Jira, not the session, is the
 * authority on who may approve.
 *
 * Membership is derived from each account's ROLE rather than listed by hand, so
 * the roster and the approval authority cannot disagree: whoever holds
 * `tech-lead` is in `tech-leads`, and nobody else is.
 */

/** Which contract role owns which gate group, mirroring `GATE_OWNER_ROLE`. */
const ROLE_OF_GROUP: Readonly<Record<string, string>> = {
  "product-owners": "product-owner",
  "tech-leads": "tech-lead",
  qa: "qa",
};

/**
 * The membership table the demo's `WorkPort` answers from, keyed by group.
 *
 * Keyed by the AUDIT ACTOR (`user@corp`), because that is what `decideGate`
 * passes: the gate decision uses `session.username` as the membership id in
 * `routes/runs.ts`, so both spellings are registered — the check must not turn
 * on which of the two a call site happened to use, and getting that wrong would
 * refuse every approval with a message about group membership.
 */
export function gateMemberships(): Record<string, readonly string[]> {
  const table: Record<string, string[]> = {};
  for (const [group, role] of Object.entries(ROLE_OF_GROUP)) {
    const members: string[] = [];
    for (const account of DEMO_ACCOUNTS) {
      if (!account.roles.includes(role)) continue;
      members.push(account.username, actorOf(account.username));
    }
    table[group] = members;
  }

  // Every group the gate directory can name must exist as a key, even when it
  // has no members — an absent group and an empty one both refuse, but only the
  // explicit one shows a reader that the group was considered.
  for (const group of Object.values(DEFAULT_GATE_OWNER_GROUPS)) {
    if (group !== undefined && table[group] === undefined) table[group] = [];
  }
  return table;
}
