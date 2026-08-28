import type {
  TemplateHistoryEntry,
  TemplateProjectBinding,
  TemplateSection,
  TemplateStore,
  TemplateVersionRecord,
} from "@maestro/bff";
import { z } from "zod";

/**
 * The Postgres-backed ANALYSIS template store (M108 / M83).
 *
 * Replaces the `InMemoryTemplateStore` the BFF used to compose. That store
 * enforces the right rules but holds them in a JavaScript array, so every
 * restart dropped the institution's template: `GET /template` answered 404
 * `no_template` again and the designer screen rendered "henüz yayında değil"
 * forever. A run pinned to version 4 also had nothing left to pin to.
 *
 * Append-only: a publish INSERTs a new version and nothing ever UPDATEs one.
 * A published template is the question an approved analysis was JUDGED
 * against, so rewriting version 4 would silently restate a decision a human
 * already signed (M83). Migration 0007 backs that with a trigger, so the rule
 * survives a maintenance script as well as this class.
 *
 * The delegates are structural rather than Prisma's generated types, the same
 * way every other store in this directory is written: the BFF must not depend
 * on a generated client, and the tests must not need Postgres.
 */

export interface AnalysisTemplateRow {
  version: number;
  name: string;
  sectionsJson: unknown;
  publishedBy: string;
  publishedAt: Date;
}

/**
 * The write shape, separate from the read one.
 *
 * `sectionsJson` is `unknown` coming OUT — a JSON column really does hold
 * anything — but the generated client will not accept `unknown` going IN, and
 * it is right not to: `undefined` would be written as SQL `NULL` and the
 * template would come back with no sections at all. So the insert declares the
 * concrete array it actually writes.
 */
export interface AnalysisTemplateCreateData extends Omit<AnalysisTemplateRow, "sectionsJson"> {
  /**
   * Spelled as an index-signature record rather than as `TemplateSection[]`.
   * The generated client's `InputJsonValue` only accepts objects assignable to
   * `{ [key: string]: … }`, and an `interface` — which `TemplateSection` is —
   * has no implicit index signature. The values written are the sections; the
   * fields are pinned by `SECTION_WRITE_SHAPE` below so this stays a widening,
   * not a hole.
   */
  sectionsJson: Record<string, string | boolean>[];
}

/**
 * Compile-time proof that the record above really is a section.
 *
 * Without it `sectionsJson` would accept any string/boolean map, and a caller
 * could store `{ aiInstrucion: … }` — a typo the read path's Zod schema would
 * then reject when an analyst opens the template, rather than here.
 */
const SECTION_WRITE_SHAPE: (section: TemplateSection) => Record<string, string | boolean> = (
  section,
) => ({
  key: section.key,
  title: section.title,
  description: section.description,
  aiInstruction: section.aiInstruction,
  required: section.required,
  format: section.format,
  example: section.example,
});

export interface AnalysisTemplateDelegate {
  findFirst(args: { orderBy: { version: "desc" } }): Promise<AnalysisTemplateRow | null>;
  findUnique(args: { where: { version: number } }): Promise<AnalysisTemplateRow | null>;
  findMany(args: { orderBy: { version: "desc" } }): Promise<AnalysisTemplateRow[]>;
  create(args: { data: AnalysisTemplateCreateData }): Promise<unknown>;
}

/** Bound projects, for "which template does this project resolve to today". */
export interface TemplateBindingRow {
  projectKey: string;
}

/**
 * `in` takes a MUTABLE array of the ENUM's own literals.
 *
 * Not `readonly`, and not `string[]`: the generated client types this filter as
 * `BindingStateE[]`, so both a frozen array and a widened one are rejected. The
 * literals below are the same values `LIVE_BINDING_STATES` holds, which is what
 * keeps this hand-written delegate assignable from the real one — and what
 * makes a state renamed in the schema a compile error here rather than a filter
 * that silently matches nothing.
 */
export type LiveBindingState = "active" | "paused" | "dry_run";

export interface TemplateBindingDelegate {
  findMany(args: {
    where: { state: { in: LiveBindingState[] } };
    orderBy: { projectKey: "asc" };
  }): Promise<TemplateBindingRow[]>;
}

/** Live runs, for the pinned-run count the screen shows per project. */
export interface PinnedRunRow {
  ticketKey: string;
  templateVersion: string;
}

/** Same reasoning as `LiveBindingState` above — `RunStatus`'s own literals. */
export type OpenRunStatus = "running" | "gate" | "queued" | "handover";

export interface PinnedRunDelegate {
  findMany(args: {
    where: { status: { in: OpenRunStatus[] } };
    select: { ticketKey: true; templateVersion: true };
  }): Promise<PinnedRunRow[]>;
}

/**
 * The stored sections, parsed on the way out.
 *
 * A JSON column holds whatever was written into it, and a section list that
 * has lost its `required` flag would render every section as optional — the
 * exact inversion of the rule that makes a gate fail closed. `format` is
 * checked against the same closed set the designer offers, because a value
 * outside it reaches the prompt builder as an unhandled case.
 */
const StoredSections = z.array(
  z.object({
    key: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    aiInstruction: z.string().min(1),
    required: z.boolean(),
    format: z.enum(["free_text", "bullet_list", "table", "impact_matrix"]),
    example: z.string(),
  }),
);

/**
 * Binding states whose projects are answering tickets today.
 *
 * `draft` and `unbound` are excluded: they have no traffic, and listing them
 * would tell an operator a project resolves to a template when nothing routes
 * to it. Mirrors the states `PrismaJiraProjectBindings` treats as live.
 */
const LIVE_BINDING_STATES: readonly LiveBindingState[] = ["active", "paused", "dry_run"];

/**
 * Run statuses that are still in flight, i.e. still pinned to a version.
 *
 * `done`, `fail` and `cancelled` are excluded: a finished run is not "still
 * finishing on an older template", which is the question this count answers
 * for an operator deciding whether a version can be retired. `handover` IS
 * included — a run waiting on a human is unfinished and still pinned.
 */
const OPEN_RUN_STATUSES: readonly OpenRunStatus[] = ["running", "gate", "queued", "handover"];

export class PrismaTemplateStore implements TemplateStore {
  constructor(
    private readonly templates: AnalysisTemplateDelegate,
    private readonly bindings: TemplateBindingDelegate,
    private readonly runs: PinnedRunDelegate,
  ) {}

  /**
   * The newest published version, or `null` before the first publish.
   *
   * `null` is right here and is not the "empty means fine" failure: no
   * template yet is a real, expected state that the route turns into a named
   * 404 (`no_template`) and the screen renders as a visible prompt to publish
   * one. A database that cannot be reached throws out of the driver instead,
   * which is the case that must not look the same.
   */
  async latest(): Promise<TemplateVersionRecord | null> {
    const row = await this.templates.findFirst({ orderBy: { version: "desc" } });
    return row === null ? null : toRecord(row);
  }

  async get(version: number): Promise<TemplateVersionRecord | null> {
    const row = await this.templates.findUnique({ where: { version } });
    return row === null ? null : toRecord(row);
  }

  async history(): Promise<readonly TemplateHistoryEntry[]> {
    const rows = await this.templates.findMany({ orderBy: { version: "desc" } });
    return rows.map((row) => ({
      version: row.version,
      at: row.publishedAt.toISOString(),
      author: row.publishedBy,
      // The section count is derived from the STORED sections, not from a
      // column that could drift away from them.
      summary: String(parseSections(row).length),
    }));
  }

  /**
   * Which template each bound project resolves to, and how many of its runs
   * are still finishing on an older version (M83).
   *
   * Both halves are real reads. An earlier draft of this screen showed a fixed
   * "0 pinned runs", which is the one answer an operator must never be handed
   * without it being true: it is exactly what they check before retiring a
   * version.
   *
   * Every live project resolves to the SAME newest version — this platform has
   * no per-project template override, and inventing one here would show an
   * operator a choice the engine does not honour.
   */
  async projects(): Promise<readonly TemplateProjectBinding[]> {
    const [newest, bound, openRuns] = await Promise.all([
      this.templates.findFirst({ orderBy: { version: "desc" } }),
      this.bindings.findMany({
        // Copied, not passed: the constants are `readonly` and the generated
        // client's enum filter takes a mutable array.
        where: { state: { in: [...LIVE_BINDING_STATES] } },
        orderBy: { projectKey: "asc" },
      }),
      this.runs.findMany({
        where: { status: { in: [...OPEN_RUN_STATUSES] } },
        select: { ticketKey: true, templateVersion: true },
      }),
    ]);

    // No template published yet: every project resolves to nothing, and a
    // version number of 0 would read as "version zero exists".
    const current = newest?.version ?? 0;

    const pinnedOlder = new Map<string, number>();
    for (const run of openRuns) {
      // A run pinned to the current version is not "still finishing on an old
      // one", and an unpinned run ("" — started before pinning, or never
      // reached the analysis step) is not evidence of an older version either.
      const pinned = Number.parseInt(run.templateVersion, 10);
      if (!Number.isInteger(pinned) || pinned >= current) continue;
      const project = projectKeyOf(run.ticketKey);
      if (project === null) continue;
      pinnedOlder.set(project, (pinnedOlder.get(project) ?? 0) + 1);
    }

    return bound.map((binding) => ({
      projectKey: binding.projectKey,
      version: current,
      pinnedRuns: pinnedOlder.get(binding.projectKey) ?? 0,
    }));
  }

  /**
   * Insert, never upsert.
   *
   * The version check happens in the service (`latest + 1`), and this INSERT is
   * what makes it hold under concurrency: an upsert here would turn the losing
   * author's collision into a silent overwrite of the winner's template.
   */
  async publish(record: TemplateVersionRecord): Promise<void> {
    await this.templates.create({
      data: {
        version: record.version,
        name: record.name,
        sectionsJson: record.sections.map(SECTION_WRITE_SHAPE),
        publishedBy: record.publishedBy,
        publishedAt: new Date(record.publishedAt),
      },
    });
  }
}

/**
 * `UGURPAY-123` → `UGURPAY`.
 *
 * Returns `null` rather than a guess for anything that is not a Jira key, so a
 * malformed ticket key is dropped from the count instead of inventing a
 * project row the operator would then go looking for.
 */
function projectKeyOf(ticketKey: string): string | null {
  const dash = ticketKey.lastIndexOf("-");
  if (dash <= 0) return null;
  return ticketKey.slice(0, dash);
}

/**
 * A row as the BFF's record.
 *
 * The sections are parsed rather than cast. A cast would let a row written by
 * an older version of this code — or by hand — reach the analyst as a section
 * list with missing fields, and `required` being `undefined` renders every
 * section as optional: an analysis would then pass a completeness check it
 * should have failed.
 */
function toRecord(row: AnalysisTemplateRow): TemplateVersionRecord {
  return {
    name: row.name,
    version: row.version,
    sections: parseSections(row),
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt.toISOString(),
  };
}

function parseSections(row: AnalysisTemplateRow): readonly TemplateSection[] {
  const parsed = StoredSections.safeParse(row.sectionsJson);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(
    `analysis template version ${String(row.version)} has unusable sections: ${issues}. The row is ` +
      `stored but cannot be rendered, which is a different problem from having no template.`,
  );
}
