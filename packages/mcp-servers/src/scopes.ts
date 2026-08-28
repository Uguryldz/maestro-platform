import { z } from "zod";

/**
 * Tool scopes (M101, mock screen `V.mcp` — "kapsam = çağıran kullanıcının
 * RBAC'ı ∩ araç kapsamı").
 *
 *  · `read`            — workflow state, journal, params, repo cards, knowledge;
 *  · `operate`         — start a workflow, assign an application;
 *  · `admin-proposal`  — propose a parameter change; the proposal enters the
 *                        four-eyes queue and is NEVER applied by the tool.
 *
 * Deliberately a FLAT set, not a ladder. A hierarchy (`admin ⊃ operate ⊃ read`)
 * reads well in a diagram and grants silently in production: an operator token
 * issued for "start the workflow" would inherit the right to file parameter
 * proposals nobody meant to give it. Every scope a caller has is a scope
 * somebody granted explicitly.
 */
export const ToolScope = z.enum(["read", "operate", "admin-proposal"]);
export type ToolScope = z.infer<typeof ToolScope>;

export const TOOL_SCOPES = ToolScope.options;

/**
 * Who is calling. `user` is the corporate account behind the personal token —
 * the AI never has an identity of its own (M101), it borrows one, and the
 * audit trail records the loan as `ai-via:<user>`.
 *
 * `scopes` is what THAT USER's RBAC already allows, computed by the BFF when
 * it validates the token. Nothing downstream may widen it: this package only
 * ever intersects.
 */
export interface CallerIdentity {
  readonly user: string;
  readonly scopes: readonly ToolScope[];
}

/** True when the caller's token carries `scope`. No implication, no fallback. */
export function hasScope(caller: CallerIdentity, scope: ToolScope): boolean {
  return caller.scopes.includes(scope);
}

/**
 * A caller whose scope set cannot change afterwards (verifier B2).
 *
 * `readonly ToolScope[]` is a compile-time promise and nothing more: the
 * runtime held the array the BFF handed it BY REFERENCE, so whoever still had
 * that array could `scopes.push("operate")` and a `read` session became an
 * operating session mid-conversation — with the binding, the tool list and the
 * audit actor all already fixed. The code most likely to keep a handle on that
 * array is precisely the code that built it from a token claim.
 *
 * Copy, then freeze. The copy defeats the aliasing; the freeze turns a later
 * `push` into a visible failure in strict mode instead of a silent no-op that
 * leaves the author believing it worked.
 */
export function sealCaller(caller: CallerIdentity): CallerIdentity {
  return Object.freeze({
    user: caller.user,
    scopes: Object.freeze([...caller.scopes]) as readonly ToolScope[],
  });
}

/**
 * The scopes a caller may actually exercise on a server: their RBAC ∩ the
 * scopes that server's tools declare. Used for listings and diagnostics; the
 * gate itself is `hasScope`, checked per call.
 */
export function grantedScopes(
  caller: CallerIdentity,
  serverScopes: readonly ToolScope[],
): ToolScope[] {
  const offered = new Set(serverScopes);
  return TOOL_SCOPES.filter((scope) => offered.has(scope) && caller.scopes.includes(scope));
}
