/**
 * The pilot's `VariantModelReader` port, over Postgres (M38 / Uğur's hard rule).
 *
 * The pilot chooses each role's LLM model from the model on that role's VARIANT
 * (what an admin set in Studio, in the DB), never from an env constant at flow
 * time. The pilot itself has NO `@maestro/db` dependency (and must not grow one
 * — the contract freezes its runtime deps), so it depends only on the narrow
 * reader PORT (`apps/pilot/src/variant.ts`, `VariantModelReader.activeModel`)
 * and is handed an implementation at boot.
 *
 * This is that implementation, and it lives HERE — in the composition root
 * (`apps/deploy`), which already binds every real Postgres store — precisely so
 * the DB dependency stays out of the pilot. The pilot's boot takes the port
 * structurally, so `PrismaVariantModelReader` never imports the pilot; it just
 * satisfies its shape.
 *
 * It answers the one fact the pilot needs: the model on a variant's ACTIVE
 * version. Versions are immutable and published in sequence (M38), so the
 * highest-numbered version is the live one — the same "newest is active" rule
 * `PrismaVariantCatalog` reads, kept narrow here because the pilot resolves
 * persona and knowledge elsewhere and only binds a role to a model.
 *
 * The delegate is structural rather than Prisma's generated type, the same way
 * every other store here is, so the reader is offline-testable with a fake and
 * never needs a live Postgres to unit-test.
 */

/**
 * A `VariantVersion` row, as the reader needs it: the model plus the config
 * blob (which carries the persona overlay an admin wrote in Studio).
 */
export interface VariantVersionModelRow {
  version: number;
  model: string;
  configJson: unknown;
}

/**
 * The slice of the `VariantVersion` delegate the reader uses: the versions of
 * one variant, newest first. The generated Prisma delegate satisfies this
 * structurally, and so does a test fake.
 */
export interface VariantVersionModelDelegate {
  findMany(args: {
    where: { variantId: string };
    orderBy: { version: "desc" };
    select: { version: true; model: true; configJson: true };
  }): Promise<VariantVersionModelRow[]>;
}

/** Pull the persona string out of a version's config blob, defensively. */
function personaOf(configJson: unknown): string | null {
  if (typeof configJson !== "object" || configJson === null) return null;
  const persona = (configJson as { persona?: unknown }).persona;
  if (typeof persona !== "string") return null;
  const trimmed = persona.trim();
  return trimmed === "" ? null : trimmed;
}

export class PrismaVariantModelReader {
  constructor(private readonly versions: VariantVersionModelDelegate) {}

  private activeRow(variantId: string): Promise<VariantVersionModelRow | undefined> {
    return this.versions
      .findMany({
        where: { variantId },
        orderBy: { version: "desc" },
        select: { version: true, model: true, configJson: true },
      })
      .then((rows) => rows[0]);
  }

  /**
   * The active (newest published) version's model for `variantId`, or `null`
   * when there is no such variant / it has no published version. `null` is a
   * real answer the pilot falls back on (env bootstrap, with a warning); a
   * thrown error (Postgres unreachable) is a DIFFERENT case and is left to
   * propagate — the pilot must not silently boot on the env default when the DB
   * is misconfigured.
   */
  async activeModel(variantId: string): Promise<string | null> {
    const active = await this.activeRow(variantId);
    if (active === undefined) return null;
    const model = active.model.trim();
    return model === "" ? null : model;
  }

  /**
   * The active version's PERSONA overlay for `variantId` — the instruction an
   * admin typed in Studio, stored in `configJson.persona`. `null` when there is
   * no such variant, no published version, or no persona set. Satisfies the
   * pilot's optional `VariantModelReader.activePersona`.
   */
  async activePersona(variantId: string): Promise<string | null> {
    const active = await this.activeRow(variantId);
    if (active === undefined) return null;
    return personaOf(active.configJson);
  }
}
