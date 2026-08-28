import type { Prisma, PrismaClient } from "@prisma/client";
import {
  DEFAULT_PARAM_DEFINITIONS,
  GLOBAL_SCOPE_REF,
  SEED_ACTOR,
} from "./params-defaults.js";
import { bootstrapParamVersionData } from "./params-write.js";

export interface SeedParamsOptions {
  /** Recorded as `changedBy` on the initial version rows. */
  changedBy?: string;
  /** Injected clock — keeps seeding deterministic in tests. */
  now?: Date;
}

export interface SeedParamsResult {
  definitions: number;
  initialVersions: number;
}

/**
 * Idempotent seed of the M71 parameter set. Definitions are upserted (they are
 * code-owned and may gain new enum options), while version 1 is only ever
 * *created*: if an operator has already edited a parameter, re-running the seed
 * must not walk their value back.
 *
 * `guarded` is copied onto the version row so the database's four-eyes CHECK
 * has something to check; see `bootstrapParamVersionData` for why the installer
 * may approve its own defaults and nobody else may.
 */
export async function seedParams(
  db: Pick<PrismaClient, "param" | "paramVersion">,
  options: SeedParamsOptions = {},
): Promise<SeedParamsResult> {
  const changedBy = options.changedBy ?? SEED_ACTOR;
  const at = options.now ?? new Date();

  for (const def of DEFAULT_PARAM_DEFINITIONS) {
    const defJson = {
      enumValues: def.enumValues ?? null,
      descriptionKey: def.descriptionKey,
      defaultValue: def.defaultValue,
    } as Prisma.InputJsonValue;

    await db.param.upsert({
      where: { key: def.key },
      create: {
        key: def.key,
        scope: def.scope,
        type: def.type,
        guarded: def.guarded,
        defJson,
      },
      update: {
        scope: def.scope,
        type: def.type,
        guarded: def.guarded,
        defJson,
      },
    });

    await db.paramVersion.upsert({
      where: {
        key_scopeRef_version: { key: def.key, scopeRef: GLOBAL_SCOPE_REF, version: 1 },
      },
      create: {
        key: def.key,
        scopeRef: GLOBAL_SCOPE_REF,
        version: 1,
        valueJson: def.defaultValue as Prisma.InputJsonValue,
        ...bootstrapParamVersionData(def.guarded, changedBy),
        at,
      },
      update: {}, // never overwrite an operator's value
    });
  }

  return {
    definitions: DEFAULT_PARAM_DEFINITIONS.length,
    initialVersions: DEFAULT_PARAM_DEFINITIONS.length,
  };
}
