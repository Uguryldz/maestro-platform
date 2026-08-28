import type { DataClass } from "@maestro/contracts";
import type { SessionRecord } from "./deps.js";

/**
 * Who may read a document of a given classification (M18/M63).
 *
 * The rule is fail-closed in both directions. A document whose class is
 * missing or unrecognised is treated as `gizli` — the strictest class — rather
 * than as the common one, because the failure mode of the other choice is a
 * confidential file rendered in a browser. And clearance is granted by group
 * membership, never by having a session: "logged in" is not a clearance level.
 */

/** The directory group that clears an account to read `gizli` material (M8). */
export const CONFIDENTIAL_GROUP = "maestro-gizli";

/** Roles that carry the clearance without a per-document group (M86). */
export const CONFIDENTIAL_ROLES = ["admin", "internal-audit"] as const;

/**
 * The class an unlabelled document is treated as. Not `dahili`: an index that
 * cannot say what a document is has not told us it is safe, and this constant
 * exists so that reading is impossible to get wrong by omission.
 */
export const UNLABELLED_CLASS: DataClass = "gizli";

const KNOWN_CLASSES: readonly string[] = ["acik", "dahili", "gizli"];

/** The effective class of a document, defaulting to the strictest. */
export function effectiveClass(dataClass: unknown): DataClass {
  return typeof dataClass === "string" && KNOWN_CLASSES.includes(dataClass)
    ? (dataClass as DataClass)
    : UNLABELLED_CLASS;
}

/** True when this session may read a document of this class. */
export function mayRead(session: SessionRecord, dataClass: unknown): boolean {
  const effective = effectiveClass(dataClass);
  if (effective !== "gizli") return true;
  if (CONFIDENTIAL_ROLES.some((role) => session.roles.includes(role))) return true;
  return session.groups.includes(CONFIDENTIAL_GROUP);
}

export interface VisibleKnowledge<T> {
  readonly visible: readonly T[];
  /**
   * How many hits this session was not cleared for. Returned rather than
   * hidden so the screen can say "3 results withheld": a silently shortened
   * list teaches a user that the knowledge base does not contain something it
   * does contain, which is worse than an honest refusal.
   */
  readonly withheld: number;
}

/** Drop the documents this session may not read, counting what was dropped. */
export function visibleKnowledge<T extends { dataClass: unknown }>(
  docs: readonly T[],
  session: SessionRecord,
): VisibleKnowledge<T> {
  const visible = docs.filter((doc) => mayRead(session, doc.dataClass));
  return { visible, withheld: docs.length - visible.length };
}
