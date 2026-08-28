import type { DataClass } from "@maestro/contracts";
import {
  assertNoPii,
  compileProfile,
  defaultPiiPolicy,
  resolveProfile,
  unmaskInbound,
  type CompiledProfile,
  type MaskCounts,
  type PiiPolicy,
  type ReverseMap,
} from "@maestro/pii";
import { LlmConfigError } from "./errors.js";

/**
 * The LLM boundary's half of M20/M82. The gateway does not own a masker — the
 * `pii` package does — but it does own the guarantee, so the two things it adds
 * around the injected masker are the ones a caller can forget: PROVING the
 * payload came back clean, and KEEPING the ReverseMap alive long enough for the
 * answer to be reopened for a human.
 */

/**
 * Exactly the shape `@maestro/pii`'s `maskOutbound` returns, so the composition
 * root wires the two together without an adapter:
 *
 * ```ts
 * mask: (payload, ctx) => maskOutbound(payload, { policy, ...ctx })
 * ```
 */
export interface MaskResult<T> {
  readonly payload: T;
  readonly map: ReverseMap;
  readonly counts: MaskCounts;
}

export interface MaskContext {
  readonly dataClass: DataClass;
  /** Named in the leak error and in the audit row (M33). */
  readonly boundary: string;
}

export type MaskFn = <T>(payload: T, context: MaskContext) => MaskResult<T>;

export interface MaskedPayload<T> {
  readonly payload: T;
  readonly counts: MaskCounts;
  /** M20: real values go back only into what a human is about to be shown. */
  readonly unmask: <R>(value: R) => R;
}

/** Compiling a profile builds regexes; do it once per policy and class. */
const compiled = new WeakMap<PiiPolicy, Map<DataClass, CompiledProfile>>();

/** The policy used when the composition root did not hand one over. */
export const DEFAULT_PII_POLICY: PiiPolicy = defaultPiiPolicy();

function verificationProfile(policy: PiiPolicy, dataClass: DataClass): CompiledProfile {
  let byClass = compiled.get(policy);
  if (!byClass) {
    byClass = new Map();
    compiled.set(policy, byClass);
  }
  const cached = byClass.get(dataClass);
  if (cached) return cached;
  const profile = compileProfile(resolveProfile(policy, dataClass).profile);
  byClass.set(dataClass, profile);
  return profile;
}

/**
 * Mask, then PROVE the mask worked before anything leaves the bank. v1 shipped
 * a working masker that the runner never called and nothing noticed; a masker
 * that silently returns its input is the same failure with a different cause,
 * so the result is re-scanned and a leak is an exception, not a disclosure.
 */
export function maskForEgress<T>(
  mask: MaskFn | undefined,
  payload: T,
  context: MaskContext,
  policy: PiiPolicy = DEFAULT_PII_POLICY,
): MaskedPayload<T> {
  if (!mask) {
    throw new LlmConfigError(`policy resolved to masked_cloud but deps.mask was not wired (${context.boundary})`);
  }
  const masked = mask(payload, context);
  assertNoPii(masked.payload, verificationProfile(policy, context.dataClass), context.boundary);
  return {
    payload: masked.payload,
    counts: masked.counts,
    unmask: (value) => unmaskInbound(value, masked.map),
  };
}
