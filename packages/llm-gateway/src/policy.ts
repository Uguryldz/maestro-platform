import type { DataClass, LlmDriverId, LlmRole } from "@maestro/contracts";
import { isSubscriptionDriver } from "@maestro/contracts";
import { ANY_VARIANT, type LlmGatewayConfig, type ModelBinding } from "./config.js";
import { UnknownModelError } from "./errors.js";
import { MSG_BLOCKED_CONFIDENTIAL, MSG_BLOCKED_ROUTE, MSG_DEGRADED_AI_ASSIST } from "./messages.js";

export type PolicyDecision =
  | {
      kind: "allow";
      driver: LlmDriverId;
      model: string;
      /** M18 `masked_cloud`: the caller MUST mask before the payload leaves. */
      masked: boolean;
    }
  /** M18 `degrade_ai_assist`: no backend may see this class — fall back to human-led work (M97). */
  | { kind: "degrade"; dataClass: DataClass; messageKey: string }
  /** M18 `block`: no call may be made at all — the flow stops, it does not degrade. */
  | { kind: "block"; dataClass: DataClass; messageKey: string };

/**
 * Routing policy (M18/M19). Two independent questions, both fail-closed:
 * which backends may see this data class, and which model serves this
 * role/variant. `gizli` never reaches a cloud backend and never a subscription
 * seat; when no on-prem backend exists the configured action decides — degrade
 * (default), block, or masked cloud. Degrade and block are DECISIONS, returned
 * as such, because the caller has to act differently on each one. An
 * unresolvable model stays an error: it is a config bug, never a silent
 * fallback.
 */
export class LlmPolicy {
  constructor(
    private readonly cfg: LlmGatewayConfig,
    /** True when the driver is configured, enabled and on-prem. */
    private readonly isOnPrem: (driver: LlmDriverId) => boolean,
    private readonly isEnabled: (driver: LlmDriverId) => boolean,
  ) {}

  resolve(role: LlmRole, variantId: string, dataClass: DataClass): PolicyDecision {
    const candidates = this.bindingsFor(role, variantId);
    if (candidates.length === 0) throw new UnknownModelError(role, variantId);

    const allowed = this.allowedDrivers(dataClass);
    const usable = candidates.filter((b) => allowed.has(b.driver) && this.isEnabled(b.driver));

    if (dataClass !== "gizli") {
      const chosen = usable[0];
      if (!chosen) return block(dataClass);
      return { kind: "allow", driver: chosen.driver, model: chosen.model, masked: false };
    }

    // Confidential: on-prem only, no exceptions (M18).
    const onPrem = usable.find((b) => !isSubscriptionDriver(b.driver) && this.isOnPrem(b.driver));
    if (onPrem) return { kind: "allow", driver: onPrem.driver, model: onPrem.model, masked: false };

    switch (this.cfg.onPremMissing) {
      case "block":
        return block(dataClass);
      case "masked_cloud": {
        // Masked or not, a subscription seat is a consumer contract with no
        // enterprise agreement behind it — the confidential class never rides
        // one. `parseGatewayConfig` refuses such a route; this is the second
        // gate, for a config built by hand.
        const cloud = usable.find((b) => !isSubscriptionDriver(b.driver));
        if (!cloud) return block(dataClass);
        return { kind: "allow", driver: cloud.driver, model: cloud.model, masked: true };
      }
      default:
        return { kind: "degrade", dataClass, messageKey: MSG_DEGRADED_AI_ASSIST };
    }
  }

  /** Exact variant rows first, then the `*` fallback; declaration order wins ties. */
  private bindingsFor(role: LlmRole, variantId: string): ModelBinding[] {
    const rows = this.cfg.bindings.filter((b) => b.role === role);
    return [
      ...rows.filter((b) => b.variantId === variantId),
      ...rows.filter((b) => b.variantId === ANY_VARIANT && b.variantId !== variantId),
    ];
  }

  private allowedDrivers(dataClass: DataClass): Set<LlmDriverId> {
    const route = this.cfg.routes.find((r) => r.dataClass === dataClass);
    // parseGatewayConfig guarantees a row per class; treat a gap as "nothing allowed".
    return new Set(route?.allowedDrivers ?? []);
  }
}

/** No permitted backend at all: the flow STOPS, it does not fall back to ai-assist. */
function block(dataClass: DataClass): PolicyDecision {
  const messageKey = dataClass === "gizli" ? MSG_BLOCKED_CONFIDENTIAL : MSG_BLOCKED_ROUTE;
  return { kind: "block", dataClass, messageKey };
}
