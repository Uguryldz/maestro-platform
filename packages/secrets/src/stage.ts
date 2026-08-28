import { z } from "zod";
import { SecretConfigError } from "./errors.js";

/**
 * Deployment stage. Same three values as `@maestro/config`'s `EnvSchema`, so a
 * process cannot be "production" for one package and "development" for another.
 */
export const NodeEnv = z.enum(["development", "test", "production"]);
export type NodeEnv = z.infer<typeof NodeEnv>;

const PRODUCTION: NodeEnv = "production";

/**
 * Normalises ONE stage value.
 *
 * Anything outside the enum is refused instead of being treated as "not
 * production": a bare `=== "production"` comparison waves `prod`, `PROD` and
 * `Production` straight through the gate they were supposed to hit, and that is
 * exactly the fail-open M6 exists to prevent.
 */
export function normalizeStage(value: unknown, source: string): NodeEnv | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new SecretConfigError(`${source} must be a string, got ${typeof value}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = NodeEnv.safeParse(trimmed.toLowerCase());
  if (!parsed.success) {
    throw new SecretConfigError(`${source} "${trimmed}" is not one of ${NodeEnv.options.join(", ")}`);
  }
  return parsed.data;
}

/**
 * Effective stage of this process.
 *
 * The ambient `process.env.NODE_ENV` may only HARDEN the caller's value: a
 * composition root that passes `deps.nodeEnv: "development"` inside a process
 * that is really running in production must not thereby unlock a dev-only
 * secret source (M6). Dependency injection is for wiring, not for downgrading a
 * safety gate.
 */
export function resolveStage(requested: unknown, source = "deps.nodeEnv"): NodeEnv {
  const ambient = normalizeStage(process.env["NODE_ENV"], "process.env.NODE_ENV");
  const asked = normalizeStage(requested, source);
  if (ambient === PRODUCTION || asked === PRODUCTION) return PRODUCTION;
  return asked ?? ambient ?? "development";
}

/** True when this process is production, whatever a caller claims. */
export function isProductionStage(requested?: unknown): boolean {
  return resolveStage(requested) === PRODUCTION;
}
