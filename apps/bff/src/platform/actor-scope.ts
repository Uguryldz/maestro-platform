import { parseActor } from "@maestro/audit";
import type { ResolvedDeps, SessionRecord } from "../deps.js";
import { unauthenticated } from "../errors.js";

/**
 * `MaestroPlatform` takes an `actingUser` on every method and the platform
 * applies THAT user's RBAC (M101). This module turns the actor string into the
 * same authorisation subject the REST guard produces, so the MCP surface and
 * Studio go through one implementation of "may this person see this" rather
 * than two that drift.
 *
 * The actor may be delegated — `ai-via:ugur@corp` is an AI holding Uğur's
 * token. It resolves to Uğur's roles and groups and to nothing more: an AI gets
 * exactly what the person holding it would get, never something extra because
 * the request arrived over MCP.
 */

/**
 * The authorisation subject behind an actor string. Roles and groups are read
 * from the DIRECTORY on every call, never cached on the actor: an MCP session
 * that outlived an off-boarding must not keep the departed employee's reach.
 */
export async function scopeOf(deps: ResolvedDeps, actingUser: string): Promise<SessionRecord> {
  // `parseActor` rather than `humanBehind`: the latter THROWS on a string it
  // cannot classify, which would surface as a 500 and tell a caller probing
  // actor formats the difference between "malformed" and "no such user".
  const identity = parseActor(actingUser);
  // A system actor has no human behind it and therefore no RBAC to apply.
  // Refusing is the only safe reading: a tool call attributed to nobody would
  // otherwise run with whatever the fallback happened to be.
  if (identity === null || identity.kind === "system") throw unauthenticated("unknown_actor");

  const user = await deps.users.find(usernameOf(identity.user, deps.config.actorDomain));
  if (user === null || !user.active) throw unauthenticated("unknown_actor");

  return {
    token: "",
    userId: user.userId,
    username: user.username,
    roles: [...user.roles],
    groups: [...user.groups],
    delegated: identity.kind === "ai_delegated",
    issuedAt: deps.clock.now().toISOString(),
    expiresAt: deps.clock.now().toISOString(),
  };
}

/** `mert.demir@corp` → `mert.demir`; a bare login passes through unchanged. */
export function usernameOf(actor: string, domain: string): string {
  const suffix = `@${domain}`;
  return actor.endsWith(suffix) ? actor.slice(0, -suffix.length) : actor;
}

/**
 * There is deliberately no `assertHumanChannel` here.
 *
 * A delegated token is refused from the two places a human must stand behind
 * the act — closing a gate and flipping the kill switch — and neither of those
 * is reachable from this interface at all: `MaestroPlatform` has no method that
 * decides a gate, and `proposeKillSwitch` files a proposal rather than making
 * the change. Everything that IS on the interface is something M101 grants a
 * delegate outright, so a delegation check here would be a check with no case
 * that could hit it, and dead safety code reads as protection that is not
 * there. The refusals live in `routes/killswitch.ts` and `routes/runs.ts`,
 * where a human channel is genuinely the question.
 */
