import type { LlmRole } from "@maestro/contracts";
import type {
  VariantCreateRequest,
  VariantDetail,
  VariantEditRequest,
  VariantKnowledgeLink,
  VariantVersionRecord,
  VariantVersionRequest,
  VariantWriteFields,
  VariantWriter,
} from "@maestro/bff";

/**
 * The variant WRITE side over Postgres (M38 / M83).
 *
 * The read side (`PrismaVariantCatalog`) answers screens; this appends the rows
 * an admin publishes from Studio. They are separate classes on purpose — a
 * deployment may wire the reader without the writer and get a 503-by-name on
 * every write while its read screens keep working (see `read-studio.ts`).
 *
 * Two rules decide this file, the same two the in-memory store keeps so a bug
 * shows in a unit test and not in a bank's agent configuration:
 *
 *  1. **Append-only (M83).** `create` writes version 1; `publishVersion` writes
 *     `latest + 1`. Nothing ever UPDATEs a published version — a run pinned to
 *     version 4 must keep reading exactly what version 4 said. The INSERT is
 *     what makes this hold under concurrency: the table's `@@id([variantId,
 *     version])` means two authors racing for version 8 cannot both win, and the
 *     loser's unique-violation is surfaced as a conflict rather than silently
 *     overwriting the winner.
 *  2. **Server-derived provenance.** `publishedBy`, `publishedAt` and the
 *     version number are taken from the caller's session, the service clock and
 *     the sequence — never from the request body. The service (`variant-service`
 *     in the BFF) already strips them; this store is where they are persisted.
 *
 * `VariantVersion` has columns for `model`, `configJson`, `evalScore` and
 * `createdAt` only — no `persona`, `note` or author column exists. The
 * versioned fields the screen edits (persona, knowledgeRefs, note) and the
 * author live INSIDE `configJson`, under the same key the read side parses
 * (`VARIANT_CONFIG` below). Storing them there rather than in new columns keeps
 * the schema frozen (the contract's rule) while still recording what an admin
 * published — the read path stops rendering `unrecorded`/`persona not stored`
 * the moment a version carries them.
 *
 * The delegates are structural rather than Prisma's generated types, the same
 * way every other store here is, so the BFF never depends on a generated client
 * and the tests never need Postgres.
 */

/** A `Variant` row, as the writer needs it. */
export interface VariantRow {
  id: string;
  role: string;
  name: string;
}

/** A `VariantVersion` row, as the writer reads it back to build a detail. */
export interface VariantVersionRow {
  variantId: string;
  version: number;
  model: string;
  configJson: unknown;
  evalScore: number | null;
  createdAt: Date;
}

/**
 * The persona/knowledge/note/author overlay a published version carries.
 *
 * A concrete record rather than `unknown`: the generated client's
 * `InputJsonValue` rejects `unknown`, and `undefined` would be written as SQL
 * `NULL` — the persona would vanish. `CONFIG_WRITE_SHAPE` below pins the fields
 * so a typo cannot be stored and then rejected at render time on a bank's
 * ticket; the value is spelled as an index-signature record because the
 * generated client's `InputJsonValue` only accepts objects assignable to
 * `{ [key: string]: … }`, which an `interface` is not.
 */
export type VariantConfigJson = Record<string, string | string[]>;

/** Compile-time proof that what we store really is the overlay we mean to. */
const CONFIG_WRITE_SHAPE: (overlay: {
  persona: string;
  knowledgeRefs: readonly string[];
  note: string;
  publishedBy: string;
}) => VariantConfigJson = (overlay) => ({
  persona: overlay.persona,
  knowledgeRefs: [...overlay.knowledgeRefs],
  note: overlay.note,
  publishedBy: overlay.publishedBy,
});

export interface VariantWriteDelegate {
  findUnique(args: { where: { id: string } }): Promise<VariantRow | null>;
  create(args: { data: { id: string; role: LlmRole; name: string } }): Promise<unknown>;
  update(args: { where: { id: string }; data: { name: string } }): Promise<unknown>;
}

export interface VariantVersionWriteDelegate {
  findMany(args: {
    where: { variantId: string };
    orderBy: { version: "desc" };
  }): Promise<VariantVersionRow[]>;
  create(args: {
    data: {
      variantId: string;
      version: number;
      model: string;
      configJson: VariantConfigJson;
      evalScore: null;
      createdAt: Date;
    };
  }): Promise<unknown>;
}

/** `bddk-uyum.md` → category `md`; a name with no extension → `file`. */
function toKnowledgeLink(ref: string, version: number): VariantKnowledgeLink {
  const dot = ref.lastIndexOf(".");
  return {
    docId: ref,
    fileName: ref,
    category: dot > 0 ? ref.slice(dot + 1) : "file",
    version,
  };
}

/**
 * The overlay a version stored, if it stored one.
 *
 * A version written by the OLD path (or seeded before the writer existed) has a
 * `configJson` that is only `{ knowledgeRefs }` — no persona, no author. The
 * markers here are the same the read catalogue uses, so a detail built from a
 * pre-writer row reads identically whether it comes through the reader or this
 * writer's echo.
 */
const UNRECORDED = "unrecorded";

function overlayOf(configJson: unknown): {
  persona: string;
  knowledgeRefs: string[];
  note: string;
  publishedBy: string;
} {
  const empty = { persona: "", knowledgeRefs: [] as string[], note: "", publishedBy: UNRECORDED };
  if (typeof configJson !== "object" || configJson === null) return empty;
  const record = configJson as Record<string, unknown>;
  const refs = Array.isArray(record["knowledgeRefs"])
    ? record["knowledgeRefs"].filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
    : [];
  return {
    persona: typeof record["persona"] === "string" ? record["persona"] : "",
    knowledgeRefs: refs,
    note: typeof record["note"] === "string" ? record["note"] : "",
    publishedBy: typeof record["publishedBy"] === "string" ? record["publishedBy"] : UNRECORDED,
  };
}

export class PrismaVariantWriter implements VariantWriter {
  constructor(
    private readonly variants: VariantWriteDelegate,
    private readonly versions: VariantVersionWriteDelegate,
  ) {}

  async create(request: VariantCreateRequest): Promise<VariantDetail> {
    const existing = await this.variants.findUnique({ where: { id: request.variantId } });
    if (existing !== null) {
      // Creating over a variant would orphan its version history. The service
      // turns this throw into a 409 `variant_exists`.
      throw new Error(`variant ${request.variantId} already exists`);
    }
    await this.variants.create({
      data: { id: request.variantId, role: request.role, name: request.platform },
    });
    await this.writeVersion(request.variantId, 1, request.fields, request.actor, request.at);
    const detail = await this.detailOf(request.variantId);
    // create just wrote it; a null here means the row vanished between two
    // statements, which is a real failure and not a "not found".
    if (detail === null) throw new Error(`variant ${request.variantId} disappeared after create`);
    return detail;
  }

  async edit(request: VariantEditRequest): Promise<VariantDetail | null> {
    const existing = await this.variants.findUnique({ where: { id: request.variantId } });
    if (existing === null) return null;
    // Only the platform overlay (`name`) is editable in place; the model and
    // persona are versioned and move through publishVersion (M83).
    await this.variants.update({ where: { id: request.variantId }, data: { name: request.platform } });
    return this.detailOf(request.variantId);
  }

  async publishVersion(request: VariantVersionRequest): Promise<VariantDetail | null> {
    const existing = await this.variants.findUnique({ where: { id: request.variantId } });
    if (existing === null) return null;
    const rows = await this.versions.findMany({
      where: { variantId: request.variantId },
      orderBy: { version: "desc" },
    });
    const latest = rows[0]?.version ?? 0;
    // INSERT `latest + 1`, never upsert: the composite primary key makes the
    // "two authors cannot both become version N" rule the database's, and an
    // upsert here would turn the loser's collision into a silent overwrite.
    await this.writeVersion(request.variantId, latest + 1, request.fields, request.actor, request.at);
    return this.detailOf(request.variantId);
  }

  private async writeVersion(
    variantId: string,
    version: number,
    fields: VariantWriteFields,
    actor: string,
    at: string,
  ): Promise<void> {
    await this.versions.create({
      data: {
        variantId,
        version,
        model: fields.model,
        configJson: CONFIG_WRITE_SHAPE({
          persona: fields.persona,
          knowledgeRefs: fields.knowledgeRefs,
          note: fields.note,
          // Server-derived: the actor is the caller's audited identity, never a
          // body field. This is the one place it is persisted.
          publishedBy: actor,
        }),
        // A freshly published version has not been evaluated; null, not zero.
        evalScore: null,
        createdAt: new Date(at),
      },
    });
  }

  /** Read the variant back and build the detail the route echoes. */
  private async detailOf(variantId: string): Promise<VariantDetail | null> {
    const row = await this.variants.findUnique({ where: { id: variantId } });
    if (row === null) return null;
    const rows = await this.versions.findMany({
      where: { variantId },
      orderBy: { version: "desc" },
    });
    const active = rows[0];
    const activeVersion = active?.version ?? 0;
    const activeOverlay = active === undefined ? overlayOf(null) : overlayOf(active.configJson);

    return {
      variantId: row.id,
      role: row.role as LlmRole,
      platform: row.name,
      model: active?.model ?? UNRECORDED,
      activeVersion,
      persona: activeOverlay.persona,
      knowledge: activeOverlay.knowledgeRefs.map((ref) => toKnowledgeLink(ref, activeVersion)),
      versions: rows.map((version): VariantVersionRecord => {
        const overlay = overlayOf(version.configJson);
        return {
          version: version.version,
          publishedAt: version.createdAt.toISOString(),
          publishedBy: overlay.publishedBy,
          note: overlay.note,
          evalScore: version.evalScore,
        };
      }),
    };
  }
}
