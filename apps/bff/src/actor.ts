import { AI_VIA_PREFIX, assertActor, parseActor } from "@maestro/audit";
import type { SessionRecord } from "./deps.js";

/**
 * Audit actors (M33/M101). The trail refuses anything it cannot classify, so
 * the BFF normalises here rather than at each call site: a Jira username is a
 * bare login on Data Center, and an unattributable approval is worse than none.
 */

/** The one system actor the frozen `packages/audit` contract accepts (see RAPOR). */
export const SYSTEM_ACTOR = "maestro-worker";

/** `mert.demir` + `ugurbank.local` → `mert.demir@ugurbank.local`; already-qualified names pass through. */
export function toActor(username: string, domain: string): string {
  const trimmed = username.trim();
  const actor = trimmed.includes("@") ? trimmed : `${trimmed}@${domain}`;
  assertActor(actor);
  return actor;
}

/**
 * The same normalisation, for input that arrives from OUTSIDE: the `author` on
 * a Jira webhook is whatever the instance sent, and nothing has validated it.
 *
 * `toActor` throws, which on a webhook route becomes a 500 — and Jira RETRIES a
 * 5xx delivery, so a single unparseable login turns into an endless redelivery
 * storm while the status difference leaks whether the parser accepted the name.
 * Returning `null` lets the caller answer 202 and tell the person instead.
 */
export function toActorOrNull(username: string, domain: string): string | null {
  if (typeof username !== "string") return null;
  const trimmed = username.trim();
  if (trimmed.length === 0) return null;
  const actor = trimmed.includes("@") ? trimmed : `${localPartOf(trimmed)}@${domain}`;
  return parseActor(actor) === null ? null : actor;
}

/**
 * A login the audit contract will accept as the local part of an address.
 *
 * Jira Cloud identifies a person by account id — `712020:7ee7a2ab-…` — and the
 * frozen `HUMAN_ACTOR` pattern in `packages/audit` allows no `:`. Every
 * `/approve` written on a Cloud ticket was therefore refused as
 * `unknown_actor`: a real decision, by a real person who IS in the approver
 * group, discarded because their id had a colon in it.
 *
 * The colon becomes a dot rather than being stripped. Stripping would map two
 * different ids onto one actor if they differed only there, and an audit trail
 * that cannot tell two approvers apart is worse than one that refuses both.
 * Everything else the pattern rejects is dropped for the same reason it is
 * rejected — it is not part of an address.
 */
function localPartOf(login: string): string {
  return login.replace(/:/g, ".").replace(/[^A-Za-z0-9._+-]/g, "");
}

/**
 * The actor a session writes as. An AI tool using a personal token keeps the
 * human it borrowed from in the record — "the AI did it" is never an answer an
 * auditor has to accept (M101).
 */
export function sessionActor(session: SessionRecord): string {
  return session.delegated ? `${AI_VIA_PREFIX}${session.userId}` : session.userId;
}

/**
 * Only a person acting directly may close a gate (M32/M101): maestro-mcp lists
 * pending gates but must never decide one, and the audit chain would refuse the
 * record anyway. Checked here so the refusal is an HTTP 403 with a reason
 * rather than a 500 from the trail.
 */
export function isHumanChannel(session: SessionRecord): boolean {
  return !session.delegated;
}
