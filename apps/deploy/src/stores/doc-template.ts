import type {
  DocTemplateOutput,
  DocTemplatePlaceholder,
  DocTemplateRecord,
  DocTemplateStore,
} from "@maestro/bff";
import { z } from "zod";

/**
 * The Postgres-backed corporate template store (M103r/M109 / M83).
 *
 * Append-only: an upload INSERTs a new version and nothing ever UPDATEs one.
 * That is not tidiness — a run pinned to version 2 must still render against
 * version 2 after version 3 lands, and an approved analysis has to stay
 * readable in the form it was approved in. `version` being the primary key
 * makes the "two uploaders cannot both become version 3" rule the database's,
 * so the loser gets a unique-violation rather than silently overwriting a file
 * nobody can get back.
 *
 * The delegates are structural rather than Prisma's generated types, the same
 * way every other store in this directory is written: the BFF must not depend
 * on a generated client, and the tests must not need Postgres.
 */

export interface DocTemplateRow {
  version: number;
  fileName: string;
  uploadedAt: Date;
  uploadedBy: string;
  sizeBytes: number;
  stylesJson: unknown;
  placeholdersJson: unknown;
  content: Uint8Array;
}

/**
 * The write shape, separate from the read one.
 *
 * The two JSON columns are `unknown` coming OUT — a JSON column really does
 * hold anything — but the generated client will not accept `unknown` going IN,
 * and it is right not to: `undefined` would be written as SQL `NULL` and the
 * placeholder scan would vanish. So the insert declares the concrete arrays it
 * actually writes.
 */
export interface DocTemplateCreateData
  extends Omit<DocTemplateRow, "stylesJson" | "placeholdersJson" | "content"> {
  /**
   * `Uint8Array<ArrayBuffer>`, not the default `Uint8Array<ArrayBufferLike>`.
   *
   * TypeScript 5.7 made the backing buffer a type parameter, and the generated
   * client asks for a plain `ArrayBuffer` — `ArrayBufferLike` also admits
   * `SharedArrayBuffer`, which the driver cannot send. `publish` copies into a
   * fresh array to satisfy it, which is a real copy of the file and worth the
   * bytes: it also detaches the stored value from whatever buffer the upload
   * was parsed out of.
   */
  content: Uint8Array<ArrayBuffer>;
  stylesJson: string[];
  /**
   * Spelled as an index-signature record rather than as
   * `DocTemplatePlaceholder[]`. The generated client's `InputJsonValue` only
   * accepts objects that are assignable to `{ [key: string]: … }`, and an
   * `interface` — which `DocTemplatePlaceholder` is — has no implicit index
   * signature. The values written are the placeholders; the fields are pinned
   * by `PLACEHOLDER_WRITE_SHAPE` below so this stays a widening, not a hole.
   */
  placeholdersJson: Record<string, string | boolean>[];
}

/**
 * Compile-time proof that the record above really is a placeholder.
 *
 * Without it `placeholdersJson` would accept any string/boolean map, and a
 * caller could store `{ tokne: … }` — a typo that the read path's Zod schema
 * would then reject at render time, on a bank's document, rather than here.
 */
const PLACEHOLDER_WRITE_SHAPE: (placeholder: DocTemplatePlaceholder) => Record<string, string | boolean> = (
  placeholder,
) => ({
  token: placeholder.token,
  descriptionKey: placeholder.descriptionKey,
  location: placeholder.location,
  found: placeholder.found,
});

export interface DocTemplateDelegate {
  findFirst(args: { orderBy: { version: "desc" } }): Promise<DocTemplateRow | null>;
  findUnique(args: { where: { version: number } }): Promise<DocTemplateRow | null>;
  create(args: { data: DocTemplateCreateData }): Promise<unknown>;
}

export interface DocTemplateOutputRow {
  id: string;
  fileName: string;
  at: Date;
  templateVersion: number;
}

export interface DocTemplateOutputDelegate {
  findMany(args: {
    orderBy: { at: "desc" };
    take: number;
  }): Promise<DocTemplateOutputRow[]>;
}

/**
 * The stored scan, parsed on the way out.
 *
 * A JSON column holds whatever was written into it, and a placeholder list
 * that has lost its `found` flag would render as a template carrying every
 * placeholder — the exact opposite of the truth, and the screen exists to show
 * which ones are missing.
 */
const StoredPlaceholders = z.array(
  z.object({
    token: z.string().min(1),
    descriptionKey: z.string().min(1),
    location: z.string(),
    found: z.boolean(),
  }),
);

const StoredStyles = z.array(z.string());

export class PrismaDocTemplateStore implements DocTemplateStore {
  constructor(
    private readonly templates: DocTemplateDelegate,
    private readonly produced: DocTemplateOutputDelegate,
  ) {}

  /**
   * The newest upload, or `null` before the first one.
   *
   * `null` is right here and is not the "empty means fine" failure: no
   * corporate template is a real, expected state that the screen renders as a
   * visible warning and that generation handles with a documented fallback. A
   * database that cannot be reached throws out of the driver instead, which is
   * the case that must not look the same.
   */
  async latest(): Promise<DocTemplateRecord | null> {
    const row = await this.templates.findFirst({ orderBy: { version: "desc" } });
    return row === null ? null : toRecord(row);
  }

  async get(version: number): Promise<DocTemplateRecord | null> {
    const row = await this.templates.findUnique({ where: { version } });
    return row === null ? null : toRecord(row);
  }

  async outputs(limit: number): Promise<readonly DocTemplateOutput[]> {
    const rows = await this.produced.findMany({
      orderBy: { at: "desc" },
      // Bounded by the caller AND clamped here: a negative or absurd `take`
      // reaching the driver is either a bug or a caller reading the whole
      // table through a screen that shows twenty rows.
      take: Math.min(Math.max(1, limit), 200),
    });
    return rows.map((row) => ({
      fileName: row.fileName,
      at: row.at.toISOString(),
      templateVersion: row.templateVersion,
    }));
  }

  /**
   * Insert, never upsert.
   *
   * The version check happens in the service (`latest + 1`), and this INSERT is
   * what makes it hold under concurrency: an upsert here would turn the losing
   * uploader's collision into a silent overwrite of the winner's file.
   */
  async publish(record: DocTemplateRecord): Promise<void> {
    await this.templates.create({
      data: {
        version: record.version,
        fileName: record.fileName,
        uploadedAt: new Date(record.uploadedAt),
        uploadedBy: record.uploadedBy,
        sizeBytes: record.sizeBytes,
        // A fresh, non-shared buffer — see `DocTemplateCreateData.content`.
        content: Uint8Array.from(record.content) as Uint8Array<ArrayBuffer>,
        stylesJson: [...record.styles],
        placeholdersJson: record.placeholders.map(PLACEHOLDER_WRITE_SHAPE),
      },
    });
  }
}

/**
 * A row as the BFF's record.
 *
 * The two JSON columns are parsed rather than cast. A cast would let a row
 * written by an older version of this code — or by hand — reach the screen as
 * a placeholder list with missing fields, and `found` being `undefined` renders
 * as "not in template" for every token: an operator would go looking for a
 * broken upload that is really a broken read.
 */
function toRecord(row: DocTemplateRow): DocTemplateRecord {
  return {
    fileName: row.fileName,
    version: row.version,
    uploadedAt: row.uploadedAt.toISOString(),
    uploadedBy: row.uploadedBy,
    sizeBytes: row.sizeBytes,
    styles: parseOrThrow(StoredStyles, row.stylesJson, row.version, "stylesJson"),
    placeholders: parseOrThrow(
      StoredPlaceholders,
      row.placeholdersJson,
      row.version,
      "placeholdersJson",
    ) as readonly DocTemplatePlaceholder[],
    content: Uint8Array.from(row.content),
  };
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, version: number, column: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(
    `doc template version ${String(version)} has an unusable ${column}: ${issues}. The row is ` +
      `stored but cannot be rendered, which is a different problem from having no template.`,
  );
}
