import { PILOT_MODEL } from "./config.js";

/**
 * DB-first model resolution for the pilot (M38 / Uğur's hard rule).
 *
 * The rule: an AI agent's model is chosen from the UI and lives on its VARIANT
 * (in the DB), never in env at flow time. `PILOT_MODEL` is a BOOTSTRAP default
 * — it seeds version 1 of the default variants — and is read here ONLY as a
 * last-resort fallback when no variant store is wired (an offline/dev pilot),
 * with a logged warning so the fallback is never silent.
 *
 * The pilot has no `@maestro/db` dependency (and must not grow one — the
 * contract freezes runtime deps), so it does not talk to Postgres itself.
 * Instead it depends on this small READER PORT and is handed an implementation
 * at boot. In a deployment that has the DB, the reader is the variant catalogue
 * over Postgres; in tests it is a stub returning a known model; when nothing is
 * wired it is `undefined` and resolution falls back to env.
 */

/**
 * The one fact the pilot needs from a variant: which model its active
 * (published) version runs under. A wider reader could return the persona and
 * knowledge too, but the model is what the LLM gateway binds a role to, so this
 * is deliberately narrow — the pilot resolves persona through `agent-roles`.
 */
export interface VariantModelReader {
  /**
   * The active version's model for `variantId`, or `null` when there is no such
   * variant (or it has no published version). `null` is a real answer the
   * caller falls back on; a thrown error (the DB is unreachable) is a different
   * case and must propagate, not be turned into env silently.
   */
  activeModel(variantId: string): Promise<string | null>;
  /**
   * The active version's PERSONA overlay for `variantId` — the instruction text
   * an admin wrote in Studio for this agent. OPTIONAL: a reader that only
   * resolves the model omits it, and the pilot then runs each role on the
   * corporate default persona (agent-roles) exactly as before. When present and
   * non-empty, the pilot injects it so what an admin types in Studio's "Persona"
   * field actually shapes the analysis and the code. `null`/empty = no overlay.
   */
  activePersona?(variantId: string): Promise<string | null>;
}

/** How a resolution turned out — surfaced so boot can log the honest reason. */
export interface ResolvedVariantModel {
  readonly variantId: string;
  readonly model: string;
  /**
   * `variant` — the model came from the variant store (the intended path).
   * `env-fallback` — no store was wired, or the store had no such variant, so
   * the bootstrap `PILOT_MODEL` was used and a warning was logged.
   */
  readonly source: "variant" | "env-fallback";
}

/** Injected so the fallback warning is testable and does not hard-wire console. */
export type WarnFn = (message: string) => void;

const defaultWarn: WarnFn = (message) => {
  console.warn(message);
};

/**
 * Resolve the model a role's variant runs under, DB-first.
 *
 * Reads the variant's active model from the store; on `null` (no such variant)
 * or on a MISSING store it falls back to the bootstrap `PILOT_MODEL` and warns.
 * A store that THROWS (unreachable DB) is left to propagate — the caller boots
 * with a real error rather than quietly running on the env default, which is the
 * one outcome that would hide a misconfigured deployment.
 */
export async function resolveVariantModel(
  variantId: string,
  reader: VariantModelReader | undefined,
  options: { fallbackModel?: string; warn?: WarnFn } = {},
): Promise<ResolvedVariantModel> {
  const fallbackModel = options.fallbackModel ?? PILOT_MODEL;
  const warn = options.warn ?? defaultWarn;

  if (reader === undefined) {
    warn(
      `[pilot] varyant deposu bağlı değil — '${variantId}' için model env ` +
        `PILOT_MODEL='${fallbackModel}' ile çözüldü (bootstrap fallback, DB değil).`,
    );
    return { variantId, model: fallbackModel, source: "env-fallback" };
  }

  const model = await reader.activeModel(variantId);
  if (model === null || model.trim() === "") {
    warn(
      `[pilot] '${variantId}' varyantının yayınlanmış bir modeli yok — env ` +
        `PILOT_MODEL='${fallbackModel}' ile geçici olarak çözüldü.`,
    );
    return { variantId, model: fallbackModel, source: "env-fallback" };
  }

  return { variantId, model: model.trim(), source: "variant" };
}
