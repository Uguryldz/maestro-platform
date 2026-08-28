import { AuditActorError } from "./errors.js";

/**
 * Actor forms accepted by the audit trail (M33 conventions, M101 delegation):
 *
 *  · `user@corp`      — a human, identified by corporate account;
 *  · `maestro-worker` — the Temporal worker activity (the only writer, M33);
 *  · `maestro-runner` — a sandbox runner agent;
 *  · `ai-via:<user>`  — an AI tool acting with that user's personal token
 *                       (maestro-mcp, M101). The delegating human stays visible
 *                       in the record; "the AI did it" is never an answer an
 *                       auditor has to accept.
 *
 * A record whose actor cannot be classified is refused at append time: an
 * unattributable event is worse than no event, because it looks trustworthy.
 */
export const SYSTEM_ACTORS = ["maestro-worker", "maestro-runner"] as const;
export type SystemActor = (typeof SYSTEM_ACTORS)[number];

export const AI_VIA_PREFIX = "ai-via:";

/** Corporate account: `local@domain`, no spaces, no separators we hash on. */
const HUMAN_ACTOR = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export type ActorIdentity =
  | { kind: "human"; user: string }
  | { kind: "system"; system: SystemActor }
  /** AI acting on behalf of `user` — carries the human it borrowed the token from. */
  | { kind: "ai_delegated"; user: string };

/** Classify an actor string; `null` when it matches none of the permitted forms. */
export function parseActor(actor: string): ActorIdentity | null {
  if (typeof actor !== "string" || actor !== actor.trim() || actor.length === 0) return null;

  for (const system of SYSTEM_ACTORS) {
    if (actor === system) return { kind: "system", system };
  }

  if (actor.startsWith(AI_VIA_PREFIX)) {
    const user = actor.slice(AI_VIA_PREFIX.length);
    return HUMAN_ACTOR.test(user) ? { kind: "ai_delegated", user } : null;
  }

  return HUMAN_ACTOR.test(actor) ? { kind: "human", user: actor } : null;
}

/** Fail-closed variant used by the append path. */
export function assertActor(actor: string): ActorIdentity {
  const identity = parseActor(actor);
  if (!identity) {
    throw new AuditActorError(
      actor,
      `expected user@corp, ${SYSTEM_ACTORS.join(", ")} or ${AI_VIA_PREFIX}<user>`,
    );
  }
  return identity;
}

/**
 * The human behind an actor: the user themselves, the delegating user for an
 * AI actor, `null` for system actors. Used by the SoD checks (M32) that must
 * see through delegation.
 */
export function humanBehind(actor: string): string | null {
  const identity = assertActor(actor);
  return identity.kind === "system" ? null : identity.user;
}

/** True only for a real person acting directly — an AI delegate is not a human here (M32/M101). */
export function isHumanActor(actor: string): boolean {
  return parseActor(actor)?.kind === "human";
}
