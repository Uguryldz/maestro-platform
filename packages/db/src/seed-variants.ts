import type { Prisma } from "@prisma/client";
import { SEED_ACTOR } from "./params-defaults.js";
import {
  DEFAULT_VARIANT_MODEL,
  DEFAULT_VARIANTS,
  type DefaultVariant,
} from "./variant-defaults.js";

export interface SeedVariantsOptions {
  /**
   * The bootstrap model for version 1 of every seeded variant. Read from the
   * `PILOT_MODEL` env at the call site; defaults to `DEFAULT_VARIANT_MODEL`.
   * This is the ONLY place env feeds a variant — after seeding the DB is
   * authoritative and the admin re-versions it from Studio.
   */
  model?: string;
  /** Recorded as the version-1 author (`configJson.publishedBy`). */
  publishedBy?: string;
  /** Injected clock — keeps seeding deterministic in tests. */
  now?: Date;
}

export interface SeedVariantsResult {
  /** The variant ids this call actually planted (empty when all already existed). */
  seeded: readonly string[];
  /** The variant ids left untouched because they already existed. */
  skipped: readonly string[];
}

/**
 * The two `PrismaClient` delegates this seed touches, structurally — so the
 * offline test drives it with plain fakes and never needs Postgres.
 */
export interface SeedVariantsDb {
  variant: {
    findUnique(args: { where: { id: string }; select: { id: true } }): Promise<{ id: string } | null>;
    create(args: {
      data: { id: string; role: DefaultVariant["role"]; name: string };
    }): Promise<unknown>;
  };
  variantVersion: {
    create(args: {
      data: {
        variantId: string;
        version: number;
        model: string;
        configJson: Prisma.InputJsonValue;
        evalScore: null;
        createdAt: Date;
      };
    }): Promise<unknown>;
  };
}

/**
 * Plant the default agent variants, once, and NEVER clobber an existing one
 * (M38).
 *
 * Idempotent per variant: a variant is written only when its id is absent, and
 * nothing is ever updated. Re-running the installer against a bank whose admin
 * has already re-versioned `analyst-default` leaves every version alone and
 * reports it as skipped — the same discipline as the template and admin seeds,
 * and the same reason: this runs on EVERY deploy.
 *
 * Version 1's fields are written into `configJson` under the exact keys the BFF
 * writer and reader agree on (`persona`, `knowledgeRefs`, `note`,
 * `publishedBy`), so a seeded variant reads back through `/variants` identically
 * to one an admin creates from Studio — the pilot can resolve its model from
 * either.
 *
 * The per-id existence check races with a second installer, and the composite
 * primary key `(variantId, version)` on `VariantVersion` (and the `id` PK on
 * `Variant`) is what makes the race safe: the loser's create raises a unique
 * violation, which is caught and treated as "already seeded" — the state it
 * wanted anyway.
 */
export async function seedDefaultVariants(
  db: SeedVariantsDb,
  options: SeedVariantsOptions = {},
): Promise<SeedVariantsResult> {
  const model = options.model ?? DEFAULT_VARIANT_MODEL;
  const publishedBy = options.publishedBy ?? SEED_ACTOR;
  const at = options.now ?? new Date();

  const seeded: string[] = [];
  const skipped: string[] = [];

  for (const variant of DEFAULT_VARIANTS) {
    const existing = await db.variant.findUnique({
      where: { id: variant.variantId },
      select: { id: true },
    });
    if (existing !== null) {
      // A variant with this id already exists — including one whose model an
      // admin has since changed. Leave every version alone (M83).
      skipped.push(variant.variantId);
      continue;
    }

    try {
      await db.variant.create({
        data: { id: variant.variantId, role: variant.role, name: variant.platform },
      });
      await db.variantVersion.create({
        data: {
          variantId: variant.variantId,
          version: 1,
          model,
          configJson: {
            persona: variant.persona,
            knowledgeRefs: [],
            note: "Kurulumla gelen varsayılan ajan. İstediğin an düzenleyip yeni sürüm yayınlayabilirsin.",
            publishedBy,
          },
          evalScore: null,
          createdAt: at,
        },
      });
      seeded.push(variant.variantId);
    } catch (error) {
      // Another installer won the race for this variant. Re-read rather than
      // trusting the error code: if the row is there now the desired state
      // holds and there is nothing to do; if it is still absent the failure was
      // real and must not be swallowed.
      const now = await db.variant.findUnique({
        where: { id: variant.variantId },
        select: { id: true },
      });
      if (now === null) throw error;
      skipped.push(variant.variantId);
    }
  }

  return { seeded, skipped };
}
