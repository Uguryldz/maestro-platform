import { describe, expect, it } from "vitest";
import {
  DEFAULT_VARIANTS,
  DEFAULT_VARIANT_MODEL,
  seedDefaultVariants,
  type SeedVariantsDb,
} from "../src/index.js";

/**
 * The offline half of the default-variant seed (M38). No database: fake
 * `variant`/`variantVersion` delegates that remember what was written, so we can
 * prove the seed plants one variant per thinking role, is idempotent per id, and
 * never clobbers a variant an admin has already re-versioned.
 */

interface VariantRow {
  id: string;
  role: string;
  name: string;
}
interface VersionRow {
  variantId: string;
  version: number;
  model: string;
  configJson: unknown;
}

function fakeDb(seed: readonly VariantRow[] = []): {
  db: SeedVariantsDb;
  variants: VariantRow[];
  versions: VersionRow[];
} {
  const variants: VariantRow[] = seed.map((r) => ({ ...r }));
  const versions: VersionRow[] = [];
  const db: SeedVariantsDb = {
    variant: {
      findUnique: (args) => {
        const hit = variants.find((r) => r.id === args.where.id);
        return Promise.resolve(hit ? { id: hit.id } : null);
      },
      create: (args) => {
        variants.push({ id: args.data.id, role: args.data.role, name: args.data.name });
        return Promise.resolve(args.data);
      },
    },
    variantVersion: {
      create: (args) => {
        versions.push({
          variantId: args.data.variantId,
          version: args.data.version,
          model: args.data.model,
          configJson: args.data.configJson,
        });
        return Promise.resolve(args.data);
      },
    },
  };
  return { db, variants, versions };
}

describe("seedDefaultVariants (M38)", () => {
  it("plants one variant per thinking role on an empty database, version 1", async () => {
    const { db, variants, versions } = fakeDb();

    const result = await seedDefaultVariants(db, {
      model: "anthropic/claude-sonnet-4.5",
      now: new Date("2026-08-10T00:00:00.000Z"),
    });

    expect(result.seeded).toEqual(DEFAULT_VARIANTS.map((v) => v.variantId));
    expect(result.skipped).toEqual([]);
    expect(variants.map((v) => v.role).sort()).toEqual(["analyst", "engineer"]);
    // Every seeded variant has exactly a version 1.
    expect(versions.every((v) => v.version === 1)).toBe(true);
    expect(versions).toHaveLength(2);
  });

  it("uses the passed bootstrap model on version 1 (PILOT_MODEL feeds here only)", async () => {
    const { db, versions } = fakeDb();
    await seedDefaultVariants(db, { model: "openai/gpt-4o-mini" });
    expect(versions.every((v) => v.model === "openai/gpt-4o-mini")).toBe(true);
  });

  it("defaults the model to DEFAULT_VARIANT_MODEL when none is passed", async () => {
    const { db, versions } = fakeDb();
    await seedDefaultVariants(db);
    expect(versions.every((v) => v.model === DEFAULT_VARIANT_MODEL)).toBe(true);
  });

  it("is idempotent and non-clobbering: an existing variant is left alone", async () => {
    // The admin has re-versioned analyst-default to a different model already.
    const { db, versions } = fakeDb([{ id: "analyst-default", role: "analyst", name: "default" }]);

    const result = await seedDefaultVariants(db, { model: "anthropic/claude-sonnet-4.5" });

    // analyst-default was skipped (no version written for it); only the missing
    // engineer-default was planted.
    expect(result.skipped).toContain("analyst-default");
    expect(result.seeded).toEqual(["engineer-default"]);
    expect(versions.map((v) => v.variantId)).toEqual(["engineer-default"]);
  });

  it("re-running against a fully-seeded install writes nothing", async () => {
    const { db } = fakeDb();
    await seedDefaultVariants(db);
    const second = await seedDefaultVariants(db);
    expect(second.seeded).toEqual([]);
    expect(second.skipped).toEqual(DEFAULT_VARIANTS.map((v) => v.variantId));
  });

  it("records the server-derived author in configJson", async () => {
    const { db, versions } = fakeDb();
    await seedDefaultVariants(db, { publishedBy: "installer@maestro.local" });
    const config = versions[0]?.configJson as Record<string, unknown>;
    expect(config["publishedBy"]).toBe("installer@maestro.local");
    expect(typeof config["persona"]).toBe("string");
  });
});
