import type {
  KillSwitchLevel,
  KillSwitchProposal,
  MaestroPlatform,
  ParamChangeProposal,
} from "@maestro/mcp-servers";
import type { ResolvedDeps, SessionRecord } from "../deps.js";
import { conflict, forbidden } from "../errors.js";
import { putParam } from "../params-service.js";
import { scopeOf } from "./actor-scope.js";

/**
 * The two proposal tools (M71/M58/M101). Both file a change for a second human
 * to confirm and neither applies one — which is why they are together: they are
 * the same rule about the same thing, that an AI holding a borrowed token may
 * ASK for a governing change and may never be the only thing behind it.
 */

/** The group that supplies the second pair of eyes on a guarded change (M71/M32). */
export const FOUR_EYES_GROUP = "maestro-admins";

/** Where a kill-switch proposal waits for its second approver (M58). */
export const KILL_SWITCH_PROPOSAL_KEY = "killswitch.level";

export type ProposeHalf = Pick<MaestroPlatform, "proposeParamChange" | "proposeKillSwitch">;

export function proposeHalf(deps: ResolvedDeps): ProposeHalf {
  return {
    async proposeParamChange(actingUser, proposal): Promise<ParamChangeProposal> {
      const session = await scopeOf(deps, actingUser);
      await assertWritable(deps);

      const result = await putParam(deps, {
        key: proposal.key,
        scopeRef: proposal.scopeRef,
        value: proposal.value,
        actor: actingUser,
      });

      // The interface has no shape that means "applied", and this is why: a
      // tool that could change an unguarded parameter outright would be a tool
      // that edits the gate set. An unguarded key is refused on this channel
      // rather than quietly applied — MCP proposes, Studio decides (M101).
      if (result.status === "applied") {
        throw conflict("param_not_guarded", { key: proposal.key });
      }

      await deps.audit.append({
        actor: actingUser,
        action: "MCP_TOOL_CALL",
        subject: `param:${proposal.key}`,
        at: deps.clock.now(),
        meta: { tool: "propose_param_change", reason: proposal.reason, by: session.username },
      });

      return {
        proposalId: `param:${proposal.key}:${proposal.scopeRef ?? ""}`,
        key: result.pending.key as ParamChangeProposal["key"],
        scopeRef: result.pending.scopeRef,
        status: "pending_four_eyes",
        approverGroup: FOUR_EYES_GROUP,
      };
    },

    /**
     * Files a kill-switch proposal; it never flips the switch (M58/M101).
     * Stopping the platform — or resuming it after an incident — is a decision
     * a second human confirms in Studio, exactly as with a guarded parameter.
     */
    async proposeKillSwitch(actingUser, proposal): Promise<KillSwitchProposal> {
      const session = await scopeOf(deps, actingUser);
      // Deliberately NOT gated on the kill switch itself: proposing to stop the
      // platform must still work once the platform is stopping, or the switch
      // could never be proposed a second time to escalate the level.
      assertRole(session, ["admin"]);

      const at = deps.clock.now().toISOString();
      await deps.params.putPending({
        key: KILL_SWITCH_PROPOSAL_KEY,
        scopeRef: null,
        value: { level: proposal.level, reason: proposal.reason },
        proposedBy: actingUser,
        at,
      });

      await deps.audit.append({
        actor: actingUser,
        action: "MCP_TOOL_CALL",
        subject: "killswitch",
        at,
        meta: { tool: "propose_killswitch", level: proposal.level, reason: proposal.reason },
      });

      return {
        proposalId: `killswitch:${at}`,
        level: proposal.level as KillSwitchLevel,
        status: "pending_four_eyes",
        approverGroup: FOUR_EYES_GROUP,
      };
    },
  };
}

/**
 * Nothing writes while the switch is on (M58). Exported so the operate half
 * applies the SAME check rather than a second copy of it.
 */
export async function assertWritable(deps: ResolvedDeps): Promise<void> {
  const state = await deps.killSwitch.get();
  if (state.level !== "off") throw conflict("kill_switch", { level: state.level });
}

export function assertRole(session: SessionRecord, roles: readonly string[]): void {
  if (!roles.some((role) => session.roles.includes(role))) {
    throw forbidden("role_required", { anyOf: roles });
  }
}
