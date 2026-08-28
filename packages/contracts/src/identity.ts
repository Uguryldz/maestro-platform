import { z } from "zod";
import { IsoDateTime, NonEmpty } from "./common.js";

/**
 * Who is asking, and what they are allowed to be asked for.
 *
 * This lives in `contracts` rather than in the BFF because three separate
 * processes have to agree on it: the BFF issues the session, Studio decides
 * which navigation entries to render from it, and `maestro-mcp` carries the
 * delegating human inside it. A role name is a STRING that crosses those
 * boundaries, and a string that crosses a boundary without a schema drifts —
 * which is exactly what happened before this file existed: `tech-lead`,
 * `tech-leads`, `tl` and `yonetici` were all in the tree at once, naming the
 * same authority. A menu filtered on the wrong spelling does not throw; it
 * renders an empty sidebar and looks like a permissions problem.
 */

/**
 * The role set, closed on purpose.
 *
 * Roles answer "what may this person do in Maestro", which is a different
 * question from "what group does the directory put them in" (`groups`, free
 * text, owned by the bank's AD). The mapping from one to the other belongs to
 * the identity driver; everything downstream of the session sees only these.
 *
 * - `admin` — platform configuration, guarded parameters, kill switch proposals
 * - `tech-lead` — owns the engineering approval gates (steps 5 and 12, M51)
 * - `product-owner` — owns the analysis gate (step 4) and may raise risk (M51)
 * - `qa` — owns the test gates (steps 9 and 11)
 * - `developer` — reads runs, may start work and answer clarifications
 * - `viewer` — read-only; the default for an account with nothing else granted
 *
 * `viewer` is deliberately the FLOOR and not an empty list: an account whose
 * role mapping fails should see a read-only platform, not an unbounded one.
 */
export const Role = z.enum(["admin", "tech-lead", "product-owner", "qa", "developer", "viewer"]);
export type Role = z.infer<typeof Role>;

export const ROLES: readonly Role[] = Role.options;

/**
 * Which roles own which approval gate (M32/M51).
 *
 * The workflow already enforces this against `actorGroup` in
 * `packages/workflows/src/gates.ts`; this constant is the same fact expressed
 * for the UI, so Studio can grey out a decision the workflow would refuse
 * rather than letting a person submit it and read a rejection. It is NOT the
 * enforcement point — a client-side check never is.
 */
export const GATE_OWNER_ROLE: Readonly<Record<"4" | "5" | "9" | "11" | "12", Role>> = {
  "4": "product-owner",
  "5": "tech-lead",
  "9": "qa",
  "11": "qa",
  "12": "tech-lead",
};

/**
 * An authenticated person, before a session is minted for them.
 *
 * `roles` is `string[]` and NOT `Role[]`, deliberately (orchestrator decision,
 * 2026-08-09). The bank's directory is the source of these names and it is free
 * to carry one this platform has never heard of — `release-manager`,
 * `internal-audit`, a team-specific label. Two ways to handle that, and the
 * difference matters at an audit:
 *
 *   - Parse them into the closed `Role` union: an unknown name is DROPPED. The
 *     person then appears to hold fewer roles than the directory granted, and
 *     nothing anywhere records that a name was discarded. Silent.
 *   - Carry them verbatim, and let `Role` govern only the AUTHORITY decisions
 *     (`hasRole`, `canDecideGate`). An unknown name grants nothing — it simply
 *     never matches — but it is still visible, still logged, still auditable.
 *
 * The second is what this contract does. `Role` remains closed for deciding;
 * this field remains open for describing. A UI rendering a role name it has no
 * label for must show the raw value rather than blank it (or worse, throw).
 */
export const AuthenticatedUser = z.object({
  /** Audit actor in `user@corp` form (M33) — the same string the trail records. */
  userId: NonEmpty,
  username: NonEmpty,
  /** Directory groups, verbatim from the identity driver. Free text by nature. */
  groups: z.array(NonEmpty).readonly(),
  /** Verbatim from the directory; see the note above on why this is not `Role[]`. */
  roles: z.array(NonEmpty).readonly(),
});
export type AuthenticatedUser = z.infer<typeof AuthenticatedUser>;

/**
 * A live session. The token is the whole credential, so it is NOT part of the
 * shape Studio receives — `SessionView` below is what crosses the wire.
 */
export const SessionRecord = AuthenticatedUser.extend({
  token: NonEmpty,
  /**
   * True when an AI tool holds this token on the user's behalf (M101). The
   * delegating human stays in the audit actor (`ai-via:<user>`), and gate
   * decisions are refused outright — approval is a human-only channel (M32).
   */
  delegated: z.boolean(),
  issuedAt: IsoDateTime,
  /** Absolute, eight hours out. A session does not slide (M8). */
  expiresAt: IsoDateTime,
});
export type SessionRecord = z.infer<typeof SessionRecord>;

/**
 * What `/auth/session` returns: everything the client needs to render, and
 * nothing it needs to keep secret. The token is omitted rather than masked —
 * a masked credential in a response body is still a credential in a log.
 */
export const SessionView = SessionRecord.omit({ token: true });
export type SessionView = z.infer<typeof SessionView>;

/**
 * Does this session carry the role? Written once so no caller re-spells it.
 *
 * `role` is a `Role`, so the QUESTION is always one of the six; `session.roles`
 * is free text, so the ANSWER tolerates whatever the directory sent. A name
 * outside the union simply never matches — it cannot grant, and it cannot throw.
 */
export function hasRole(session: Pick<SessionView, "roles">, role: Role): boolean {
  return session.roles.includes(role);
}

/**
 * May this session decide the gate at `step`?
 *
 * `admin` is deliberately NOT a wildcard here. Platform administration and
 * approval authority are different powers, and M32 is about the second: an
 * admin who could close any gate would be a single account that can approve
 * its own work, which is the thing four-eyes exists to prevent.
 */
export function canDecideGate(session: Pick<SessionView, "roles" | "delegated">, step: string): boolean {
  if (session.delegated) return false;
  const owner = GATE_OWNER_ROLE[step as keyof typeof GATE_OWNER_ROLE];
  return owner !== undefined && session.roles.includes(owner);
}
