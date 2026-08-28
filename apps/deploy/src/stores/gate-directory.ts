import type { StepId } from "@maestro/contracts";
import { GATE_OWNER, isApprovalGate } from "@maestro/workflows";
import type { DeployEnv } from "../env.js";

/**
 * Which directory group owns which approval gate.
 *
 * `@maestro/workflows`' `GATE_OWNER` names roles — `product-owners`,
 * `tech-leads`, `qa` — and those are the right names for a workflow to reason
 * about. They are not the names a directory answers to: a Jira site calls its
 * approvers something else, and `verifyMembership` on a group that does not
 * exist fails the decision with a 404. That is fail-closed and correct, but it
 * means the two vocabularies have to meet somewhere, and the composition root
 * is that place.
 *
 * `GATE_GROUPS` maps them, comma-separated:
 *
 *     GATE_GROUPS="product-owners=jira-users-uyildiz,tech-leads=jira-admins"
 *
 * `GATE_GROUP_DEFAULT` catches the roles no entry names, so a deployment with
 * one approver group can say so in one variable rather than five.
 *
 * A step that is not an approval gate answers `null` — never a group — because
 * a decision on a step nobody gates must be refused rather than accepted by
 * whoever happens to be in the fallback.
 */
/**
 * Role -> directory group, as one function.
 *
 * Split out of the class because BOTH sides of a gate decision need it and
 * they run in different processes: the BFF resolves the group it verifies
 * membership against, and the worker resolves the group it writes onto the
 * gate record and checks the decision's claim against. When only the BFF had
 * this mapping, a real approval was verified against `jira-users-uyildiz` in
 * one process and refused against `product-owners` in the other.
 */
export type RoleResolver = (role: string) => string;

/**
 * Takes the raw environment rather than a `DeployEnv` so the WORKER can build
 * it too: the worker composes its stores before `bootPlatform` has produced a
 * `DeployEnv` (`bin/worker.ts` — `publish`'s deps force that ordering), and
 * both processes must resolve a role the same way or a gate opens against one
 * group and is checked against another.
 */
export function roleResolver(source: Record<string, string | undefined>): RoleResolver {
  const byRole = parseMapping(source["GATE_GROUPS"]);
  const raw = source["GATE_GROUP_DEFAULT"]?.trim();
  const fallback = raw === undefined || raw === "" ? undefined : raw;
  // The role's own name is the last resort, so a deployment whose directory
  // happens to use these names needs no configuration at all.
  return (role: string): string => byRole.get(role) ?? fallback ?? role;
}

export class EnvGateDirectory {
  readonly #resolve: RoleResolver;

  constructor(env: DeployEnv) {
    this.#resolve = roleResolver(env.source);
  }

  ownerGroup(step: StepId, _projectKey: string): Promise<string | null> {
    if (!isApprovalGate(step)) return Promise.resolve(null);
    const role = GATE_OWNER[step as keyof typeof GATE_OWNER];
    if (role === undefined) return Promise.resolve(null);
    return Promise.resolve(this.#resolve(role));
  }
}

/** `role=group,role=group` → map. Malformed entries are dropped, not guessed. */
function parseMapping(raw: string | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (raw === undefined) return out;
  for (const entry of raw.split(",")) {
    const [role, group] = entry.split("=");
    if (role === undefined || group === undefined) continue;
    const key = role.trim();
    const value = group.trim();
    if (key !== "" && value !== "") out.set(key, value);
  }
  return out;
}
