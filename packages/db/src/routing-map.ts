import { ProjectKey } from "@maestro/contracts";

/**
 * `RoutingRule.projectKey`: contract value <-> stored column (M99 tier 1).
 *
 * The contract spells an org-wide rule `"*"` (`ProjectKey.or(z.literal("*"))`).
 * The column is `VARCHAR(32) NULL` with `NULL` meaning "every project", because
 * a sentinel row in `JiraProjectBinding` named `*` would be a fake binding that
 * every join, every count and every Studio list would have to know to skip.
 *
 * The translation lives here, once. No caller may invent its own sentinel.
 */

/** The contract's org-wide marker. */
export const ORG_WIDE_PROJECT_KEY = "*" as const;

export class InvalidRuleProjectKeyError extends Error {
  constructor(value: string) {
    super(`routing rule projectKey must be a ProjectKey or "*", got ${JSON.stringify(value)}`);
    this.name = "InvalidRuleProjectKeyError";
  }
}

/** Stored column -> contract value. `NULL` becomes `"*"`. */
export function toContractProjectKey(column: string | null | undefined): string {
  return column === null || column === undefined ? ORG_WIDE_PROJECT_KEY : column;
}

/**
 * Contract value -> stored column. `"*"` becomes `NULL`.
 *
 * Fail-closed (M14): anything that is neither `"*"` nor a well-formed
 * `ProjectKey` is refused here rather than stored as a rule that silently
 * matches nothing.
 */
export function toColumnProjectKey(value: string): string | null {
  if (value === ORG_WIDE_PROJECT_KEY) return null;
  if (!ProjectKey.safeParse(value).success) throw new InvalidRuleProjectKeyError(value);
  return value;
}

/** True when the stored row is an org-wide rule. */
export function isOrgWideRule(column: string | null | undefined): boolean {
  return column === null || column === undefined;
}
