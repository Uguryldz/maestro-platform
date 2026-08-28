import { DataClass } from "@maestro/contracts";
import { compileAccountPatterns, DETECTORS } from "./detectors/index.js";
import { PiiPolicyError } from "./errors.js";
import {
  DETECTOR_TYPES,
  MaskProfile,
  PiiPolicy,
  type DataClassName,
  type Detector,
  type DetectorContext,
} from "./types.js";

/** The class a payload falls back to when its declared class is unusable. */
export const STRICTEST_CLASS: DataClassName = "gizli";

/** Classes from loosest to strictest. Each one must mask at least the last. */
const CLASS_ORDER: readonly DataClassName[] = ["acik", "dahili", "gizli"];

declare const POLICY_BRAND: unique symbol;

/**
 * A policy that has been through `loadPiiPolicy`.
 *
 * The brand is unforgeable outside this module, so a hand-written
 * `{ profiles: { gizli: { types: ["email"] } } }` cannot be handed to the
 * boundary any more (verifier B-7). `Masked<T>` was branded while the policy —
 * the object that decides what masking even means — was not.
 */
export type LoadedPiiPolicy = PiiPolicy & { readonly [POLICY_BRAND]: "pii-policy-loaded" };

/**
 * Freeze the whole document. Loading used to check `gizli` and then hand back
 * a mutable object, so anything downstream could weaken the profile after the
 * check had passed — a validation that is trivial to undo is not one.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const inner of Object.values(value)) deepFreeze(inner);
  return Object.freeze(value);
}

function subsetIssue(
  looser: DataClassName,
  stricter: DataClassName,
  what: string,
  missing: readonly string[],
): string | null {
  if (missing.length === 0) return null;
  return (
    `the "${looser}" profile masks ${what} that "${stricter}" does not (${missing.join(", ")}); ` +
    `a stricter class must never mask less than a looser one`
  );
}

/** `acik ⊆ dahili ⊆ gizli`, for every axis a profile has. */
function assertMonotone(policy: PiiPolicy): void {
  for (let i = 0; i + 1 < CLASS_ORDER.length; i += 1) {
    const looserName = CLASS_ORDER[i] as DataClassName;
    const stricterName = CLASS_ORDER[i + 1] as DataClassName;
    const looser = policy.profiles[looserName];
    const stricter = policy.profiles[stricterName];
    const patternKey = (p: { name: string; pattern: string }): string => `${p.name}=${p.pattern}`;
    const issues = [
      subsetIssue(
        looserName,
        stricterName,
        "detector types",
        looser.types.filter((t) => !stricter.types.includes(t)),
      ),
      subsetIssue(
        looserName,
        stricterName,
        "field rules",
        looser.fieldRules.filter(
          (f) => !stricter.fieldRules.some((g) => g.toLowerCase() === f.toLowerCase()),
        ),
      ),
      subsetIssue(
        looserName,
        stricterName,
        "account patterns",
        looser.accountPatterns
          .filter((p) => !stricter.accountPatterns.some((q) => patternKey(q) === patternKey(p)))
          .map((p) => p.name),
      ),
    ].filter((issue): issue is string => issue !== null);
    if (issues.length > 0) throw new PiiPolicyError(issues.join("; "));
  }
}

/**
 * Install-time default (M18/M63 leave the real values to the compliance
 * team). Every class masks every checksum-verifiable identifier; the only
 * axis that moves is the institution's own account patterns, which are an
 * internal concept and are not applied to public-class material.
 */
export function defaultPiiPolicy(): LoadedPiiPolicy {
  const identifiers = ["iban", "card", "tckn", "phone", "email"] as const;
  return loadPiiPolicy({
    profiles: {
      acik: { types: [...identifiers], accountPatterns: [], fieldRules: [] },
      dahili: { types: [...DETECTOR_TYPES], accountPatterns: [], fieldRules: [] },
      gizli: { types: [...DETECTOR_TYPES], accountPatterns: [], fieldRules: [] },
    },
  });
}

/**
 * Parse and validate a policy document — the only way to get a policy the
 * boundary will accept.
 *
 * Three rules, all of them fail-closed:
 * 1. `gizli` covers every detector type, because it is also the fallback for
 *    an unknown class: weakening it would turn "we do not know what this is"
 *    into "mask less", which is exactly backwards.
 * 2. `acik ⊆ dahili ⊆ gizli`. Without it a document could declare
 *    `acik: { types: ["email"] }` and a payload labelled "acik" — by a
 *    webhook, i.e. by an untrusted source — carried a raw TCKN out (B-6).
 * 3. The result is frozen, so nothing downstream can weaken what was checked.
 */
export function loadPiiPolicy(input: unknown): LoadedPiiPolicy {
  const parsed = PiiPolicy.safeParse(input);
  if (!parsed.success) {
    throw new PiiPolicyError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const policy = parsed.data;
  const strict = policy.profiles[STRICTEST_CLASS];
  const missing = DETECTOR_TYPES.filter((t) => !strict.types.includes(t));
  if (missing.length > 0) {
    throw new PiiPolicyError(
      `the "${STRICTEST_CLASS}" profile is the fallback for unknown data classes ` +
        `and must enable every detector; missing: ${missing.join(", ")}`,
    );
  }
  assertMonotone(policy);
  // Compile every profile's patterns now so a broken regex fails at load.
  for (const profile of Object.values(policy.profiles)) {
    compileAccountPatterns(profile.accountPatterns);
  }
  return deepFreeze(policy) as LoadedPiiPolicy;
}

export interface ResolvedProfile {
  readonly dataClass: DataClassName;
  readonly profile: MaskProfile;
  /** True when the declared class was missing or unrecognised (fail-closed). */
  readonly fellBack: boolean;
}

/**
 * Pick the profile for a payload. The argument is `unknown` on purpose: the
 * caller often gets the class from a webhook or a Jira field, and an absent
 * or unrecognised value must land on the strictest profile rather than throw
 * and tempt someone into a try/catch that skips masking.
 */
export function resolveProfile(policy: PiiPolicy, dataClass: unknown): ResolvedProfile {
  const parsed = DataClass.safeParse(dataClass);
  const name: DataClassName = parsed.success ? parsed.data : STRICTEST_CLASS;
  return { dataClass: name, profile: policy.profiles[name], fellBack: !parsed.success };
}

/** A profile with its regexes compiled and its detectors selected. */
export interface CompiledProfile {
  readonly detectors: readonly Detector[];
  readonly detectorContext: DetectorContext;
  /** Lower-cased field names whose whole value is replaced. */
  readonly fieldRules: ReadonlySet<string>;
}

export interface CompiledForClass {
  readonly dataClass: DataClassName;
  readonly profile: CompiledProfile;
  readonly fellBack: boolean;
}

/**
 * Resolve *and* compile in one step, so a caller who needs a profile for an
 * egress guard gets the same object the masker would use. `guardEgress` used
 * to re-resolve the class itself, which meant the guard trusted a value that
 * arrived from a webhook (B-6).
 */
export function compiledProfileFor(policy: PiiPolicy, dataClass: unknown): CompiledForClass {
  const resolved = resolveProfile(policy, dataClass);
  return {
    dataClass: resolved.dataClass,
    profile: compileProfile(resolved.profile),
    fellBack: resolved.fellBack,
  };
}

export function compileProfile(profile: MaskProfile): CompiledProfile {
  const parsed = MaskProfile.parse(profile);
  const accountPatterns = compileAccountPatterns(parsed.accountPatterns);
  const detectors = DETECTOR_TYPES.filter((t) => parsed.types.includes(t)).map((t) => DETECTORS[t]);
  return {
    detectors,
    detectorContext: { accountPatterns },
    fieldRules: new Set(parsed.fieldRules.map((f) => f.toLowerCase())),
  };
}
