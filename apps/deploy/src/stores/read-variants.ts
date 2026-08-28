import type { LlmRole } from "@maestro/contracts";
import type {
  VariantCatalog,
  VariantDetail,
  VariantKnowledgeLink,
  VariantSummary,
  VariantVersionRecord,
} from "@maestro/bff";

/**
 * The variant catalogue over Postgres (M38).
 *
 * `Variant` and `VariantVersion` are real tables with real rows, so this
 * answers for real. Three facts the SCREEN asks for are not columns, and each
 * is derived from something the table does hold rather than invented:
 *
 *  · `platform` — the `Variant.name` column IS the platform overlay (`web`,
 *    `mobile-ios`, `desktop`, `default`); M38 defines a variant as "the same
 *    roles, addressed to a mobile team instead of a backend team".
 *  · `activeVersion` — the highest version row. Versions are immutable and
 *    published in sequence (M38), so the newest one is the live one; there is
 *    no `active` pointer column to read instead.
 *  · `knowledgeFiles` / `knowledge` — `VariantVersion.configJson.knowledgeRefs`,
 *    the list the prompt is actually built from.
 *
 * What is NOT derived: `publishedBy` and `note`. The table records neither, so
 * they come back as a marker rather than a plausible name — see `UNRECORDED`.
 */

export interface VariantRow {
  id: string;
  role: string;
  name: string;
}

export interface VariantVersionRow {
  variantId: string;
  version: number;
  model: string;
  configJson: unknown;
  evalScore: number | null;
  createdAt: Date;
}

export interface VariantDelegate {
  findMany(args: { orderBy: [{ role: "asc" }, { id: "asc" }] }): Promise<VariantRow[]>;
  findUnique(args: { where: { id: string } }): Promise<VariantRow | null>;
}

export interface VariantVersionDelegate {
  findMany(args: {
    where: { variantId: string | { in: string[] } };
    orderBy: { version: "desc" };
  }): Promise<VariantVersionRow[]>;
}

/**
 * What the table cannot tell us about a published version.
 *
 * `VariantVersion` has no author and no release note. A blank string would
 * render as an empty cell an operator reads as "nobody recorded it, probably
 * fine"; this reads as what it is. It is a machine marker, not prose the BFF
 * invented — the screen prints it in a column whose meaning is already
 * "who published this".
 */
const UNRECORDED = "unrecorded";

/** `configJson.knowledgeRefs` — the files the prompt is built from (M18/M63). */
function knowledgeRefsOf(configJson: unknown): readonly string[] {
  if (typeof configJson !== "object" || configJson === null) return [];
  const refs = (configJson as { knowledgeRefs?: unknown }).knowledgeRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
}

/**
 * A knowledge reference as the detail screen shows it.
 *
 * The reference is a FILE NAME (`bddk-uyum.md`) and nothing joins it to
 * `KnowledgeDoc`: that table is keyed by `(id, version)` where `id` is a doc
 * id, not a file name, so a join would be a guess. The category is derived
 * from the extension — the one thing the name genuinely tells us — and the
 * version is the variant version that references it, which is the honest
 * answer to "which version of this file is in play": the pin is the variant's,
 * not the file's.
 */
function toKnowledgeLink(ref: string, variantVersion: number): VariantKnowledgeLink {
  const dot = ref.lastIndexOf(".");
  return {
    docId: ref,
    fileName: ref,
    category: dot > 0 ? ref.slice(dot + 1) : "file",
    version: variantVersion,
  };
}

/**
 * `configJson.publishedBy` — the audit actor the WRITER records for a version.
 *
 * A version written before the writer existed (or seeded with only
 * `knowledgeRefs`) has no author in its config, so this returns `null` and the
 * caller keeps rendering `UNRECORDED`. A version an admin published from Studio
 * carries the real actor — the marker is only the honest answer when nothing
 * was recorded, never a value that overrides one that was.
 */
function stringFieldOf(configJson: unknown, key: string): string | null {
  if (typeof configJson !== "object" || configJson === null) return null;
  const value = (configJson as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toVersionRecord(row: VariantVersionRow): VariantVersionRecord {
  return {
    version: row.version,
    publishedAt: row.createdAt.toISOString(),
    // The writer stores the server-derived author and note in `configJson`; a
    // pre-writer row has neither and falls back to the marker.
    publishedBy: stringFieldOf(row.configJson, "publishedBy") ?? UNRECORDED,
    note: stringFieldOf(row.configJson, "note") ?? UNRECORDED,
    // `null` stays `null`: never evaluated is not a score of zero.
    evalScore: row.evalScore,
  };
}

/** Newest first; the table's `@@id([variantId, version])` makes this total. */
function newestOf(rows: readonly VariantVersionRow[]): VariantVersionRow | null {
  return rows.length === 0 ? null : (rows[0] as VariantVersionRow);
}

export class PrismaVariantCatalog implements VariantCatalog {
  constructor(
    private readonly variants: VariantDelegate,
    private readonly versions: VariantVersionDelegate,
  ) {}

  async list(): Promise<readonly VariantSummary[]> {
    const rows = await this.variants.findMany({ orderBy: [{ role: "asc" }, { id: "asc" }] });
    if (rows.length === 0) return [];

    // One query for every variant's versions rather than one per variant: the
    // catalogue is nine rows today and a query per row is a habit that becomes
    // a problem quietly.
    const allVersions = await this.versions.findMany({
      where: { variantId: { in: rows.map((row) => row.id) } },
      orderBy: { version: "desc" },
    });

    const byVariant = new Map<string, VariantVersionRow[]>();
    for (const version of allVersions) {
      const bucket = byVariant.get(version.variantId);
      if (bucket === undefined) byVariant.set(version.variantId, [version]);
      else bucket.push(version);
    }

    return rows.map((row) => {
      const versions = byVariant.get(row.id) ?? [];
      const active = newestOf(versions);
      return {
        variantId: row.id,
        role: row.role as LlmRole,
        platform: row.name,
        // A variant with no published version yet has no model to name. "" is
        // not a model, so the marker says so rather than rendering blank.
        model: active?.model ?? UNRECORDED,
        activeVersion: active?.version ?? 0,
        knowledgeFiles: knowledgeRefsOf(active?.configJson).length,
        evalScore: active?.evalScore ?? null,
      } satisfies VariantSummary;
    });
  }

  async get(variantId: string): Promise<VariantDetail | null> {
    const row = await this.variants.findUnique({ where: { id: variantId } });
    if (row === null) return null;

    const versions = await this.versions.findMany({
      where: { variantId },
      orderBy: { version: "desc" },
    });
    const active = newestOf(versions);
    const activeVersion = active?.version ?? 0;

    return {
      variantId: row.id,
      role: row.role as LlmRole,
      platform: row.name,
      model: active?.model ?? UNRECORDED,
      activeVersion,
      // The persona a version was PUBLISHED with lives in `configJson.persona`
      // (the writer stores it there). A version created before the writer
      // existed has no persona in its config — for those the prompt text lives
      // in `packages/agent-roles` and this process does not load it, so the
      // field explains that rather than rendering an empty editor an operator
      // reads as an empty persona.
      persona: stringFieldOf(active?.configJson, "persona") ?? PERSONA_NOT_STORED,
      knowledge: knowledgeRefsOf(active?.configJson).map((ref) =>
        toKnowledgeLink(ref, activeVersion),
      ),
      versions: versions.map(toVersionRecord),
    };
  }
}

/**
 * What the persona tab shows, and why it is not the prompt.
 *
 * Prompt texts are code (`packages/agent-roles/src/texts.ts`) merged with
 * per-variant overrides at run time; no table stores the resolved text. The
 * screen's editor is read-only precisely because publishing a new version has
 * to run the eval gate first, so nothing is lost by saying this — and an empty
 * box would have implied a variant with no persona at all.
 */
const PERSONA_NOT_STORED =
  "Persona metni bu veritabanında saklanmıyor: prompt metinleri " +
  "packages/agent-roles içinde kod olarak yaşar ve çalışma anında varyant " +
  "override'larıyla birleştirilir (M38). Bu ekran kayıtlı bir metin " +
  "göstermiyor — boş bir kutu 'persona yok' diye okunurdu.";
