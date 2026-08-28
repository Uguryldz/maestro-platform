import type { LlmRole } from "@maestro/contracts";
import type {
  EvalRecordDecisionRequest,
  EvalRunRecord,
  EvalWriter,
  GoldenTicket,
  VariantCatalog,
  VariantCreateRequest,
  VariantDetail,
  VariantEditRequest,
  VariantKnowledgeLink,
  VariantSummary,
  VariantVersionRecord,
  VariantVersionRequest,
  VariantWriteFields,
  VariantWriter,
} from "../read-studio.js";

/**
 * The variant catalogue AND its write side, in one process-local store
 * (M38/M83).
 *
 * It enforces the same rules a Postgres-backed pair must, so a bug shows up in a
 * unit test rather than in a bank's agent configuration:
 *
 *  · a version is APPENDED, never mutated — `publishVersion` writes `latest + 1`
 *    and a stored version's model/persona are never rewritten. A run pinned to
 *    version 4 (M83) keeps reading version 4 after 5 lands.
 *  · `create` refuses a `variantId` that already exists — creating over one
 *    would orphan its version history.
 *  · `edit` changes only the platform overlay; the model and persona are
 *    versioned and only `publishVersion` moves them.
 *
 * Process-local, so every write dies with the process — the same declared cost
 * as the other in-memory stores.
 */
interface StoredVersion {
  version: number;
  model: string;
  persona: string;
  knowledgeRefs: readonly string[];
  note: string;
  publishedBy: string;
  publishedAt: string;
  evalScore: number | null;
}

interface StoredVariant {
  variantId: string;
  role: LlmRole;
  platform: string;
  versions: StoredVersion[];
}

/** Seed shape a test or the demo composes the store from. */
export interface VariantSeed {
  readonly variantId: string;
  readonly role: LlmRole;
  readonly platform: string;
  readonly versions: readonly {
    readonly version: number;
    readonly model: string;
    readonly persona: string;
    readonly knowledgeRefs?: readonly string[];
    readonly note?: string;
    readonly publishedBy?: string;
    readonly publishedAt?: string;
    readonly evalScore?: number | null;
  }[];
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

export class InMemoryVariantCatalog implements VariantCatalog, VariantWriter {
  private readonly variants = new Map<string, StoredVariant>();

  constructor(seed: readonly VariantSeed[] = []) {
    for (const record of seed) {
      const versions = [...record.versions]
        .map((version) => ({
          version: version.version,
          model: version.model,
          persona: version.persona,
          knowledgeRefs: [...(version.knowledgeRefs ?? [])],
          note: version.note ?? "",
          publishedBy: version.publishedBy ?? "unrecorded",
          publishedAt: version.publishedAt ?? "1970-01-01T00:00:00.000Z",
          evalScore: version.evalScore ?? null,
        }))
        .sort((left, right) => left.version - right.version);
      this.variants.set(record.variantId, {
        variantId: record.variantId,
        role: record.role,
        platform: record.platform,
        versions,
      });
    }
  }

  private active(variant: StoredVariant): StoredVersion | undefined {
    return variant.versions[variant.versions.length - 1];
  }

  private summaryOf(variant: StoredVariant): VariantSummary {
    const active = this.active(variant);
    return {
      variantId: variant.variantId,
      role: variant.role,
      platform: variant.platform,
      model: active?.model ?? "unrecorded",
      activeVersion: active?.version ?? 0,
      knowledgeFiles: active?.knowledgeRefs.length ?? 0,
      evalScore: active?.evalScore ?? null,
    };
  }

  private detailOf(variant: StoredVariant): VariantDetail {
    const active = this.active(variant);
    const activeVersion = active?.version ?? 0;
    return {
      variantId: variant.variantId,
      role: variant.role,
      platform: variant.platform,
      model: active?.model ?? "unrecorded",
      activeVersion,
      persona: active?.persona ?? "",
      knowledge: (active?.knowledgeRefs ?? []).map((ref) =>
        toKnowledgeLink(ref, activeVersion),
      ),
      versions: [...variant.versions]
        .sort((left, right) => right.version - left.version)
        .map(
          (version): VariantVersionRecord => ({
            version: version.version,
            publishedAt: version.publishedAt,
            publishedBy: version.publishedBy,
            note: version.note,
            evalScore: version.evalScore,
          }),
        ),
    };
  }

  list(): Promise<readonly VariantSummary[]> {
    const rows = [...this.variants.values()]
      .sort((left, right) =>
        left.role === right.role
          ? left.variantId.localeCompare(right.variantId)
          : left.role.localeCompare(right.role),
      )
      .map((variant) => this.summaryOf(variant));
    return Promise.resolve(rows);
  }

  get(variantId: string): Promise<VariantDetail | null> {
    const variant = this.variants.get(variantId);
    return Promise.resolve(variant === undefined ? null : this.detailOf(variant));
  }

  async create(request: VariantCreateRequest): Promise<VariantDetail> {
    if (this.variants.has(request.variantId)) {
      // Creating over a variant would orphan its history — refuse rather than
      // silently replace it.
      throw new Error(`variant ${request.variantId} already exists`);
    }
    const variant: StoredVariant = {
      variantId: request.variantId,
      role: request.role,
      platform: request.platform,
      versions: [firstVersion(request.fields, request.actor, request.at)],
    };
    this.variants.set(variant.variantId, variant);
    await Promise.resolve();
    return this.detailOf(variant);
  }

  async edit(request: VariantEditRequest): Promise<VariantDetail | null> {
    const variant = this.variants.get(request.variantId);
    if (variant === undefined) return null;
    // Only the platform overlay is editable here; the model and persona are
    // versioned and move through publishVersion (M83).
    variant.platform = request.platform;
    await Promise.resolve();
    return this.detailOf(variant);
  }

  async publishVersion(request: VariantVersionRequest): Promise<VariantDetail | null> {
    const variant = this.variants.get(request.variantId);
    if (variant === undefined) return null;
    const latest = this.active(variant)?.version ?? 0;
    variant.versions.push({
      version: latest + 1,
      model: request.fields.model,
      persona: request.fields.persona,
      knowledgeRefs: [...request.fields.knowledgeRefs],
      note: request.fields.note,
      publishedBy: request.actor,
      publishedAt: request.at,
      // A freshly published version has not been evaluated yet; null, not zero.
      evalScore: null,
    });
    await Promise.resolve();
    return this.detailOf(variant);
  }
}

function firstVersion(
  fields: VariantWriteFields,
  actor: string,
  at: string,
): StoredVersion {
  return {
    version: 1,
    model: fields.model,
    persona: fields.persona,
    knowledgeRefs: [...fields.knowledgeRefs],
    note: fields.note,
    publishedBy: actor,
    publishedAt: at,
    evalScore: null,
  };
}

/**
 * The golden-ticket eval producer (M38/M43/M78), process-local.
 *
 * This store IS the producer whose absence makes `/eval` refuse. It records a
 * pool of reference tickets and the eval runs replayed against them, and it
 * carries the M78 gate decision on each run. The rule it enforces: a run whose
 * candidate REGRESSED against the baseline may only be marked `shipped` with a
 * non-empty justification — but that rule lives in the SERVICE, because the
 * store must be able to store a `blocked` decision too, and a store that
 * enforced "justification required" would refuse to record the refusal.
 */
export interface EvalSeed {
  readonly pool: readonly GoldenTicket[];
  readonly runs: readonly EvalRunRecord[];
}

export class InMemoryEvalStore implements EvalWriter {
  private readonly golden: GoldenTicket[];
  private readonly runs: EvalRunRecord[] = [];

  constructor(seed: EvalSeed = { pool: [], runs: [] }) {
    this.golden = seed.pool.map((ticket) => ({ ...ticket }));
    this.runs.push(...seed.runs.map(cloneRun));
    this.runs.sort((left, right) => left.at.localeCompare(right.at));
  }

  pool(): Promise<readonly GoldenTicket[]> {
    return Promise.resolve(this.golden.map((ticket) => ({ ...ticket })));
  }

  lastRun(): Promise<EvalRunRecord | null> {
    const newest = this.runs[this.runs.length - 1];
    return Promise.resolve(newest === undefined ? null : cloneRun(newest));
  }

  run(runId: string): Promise<EvalRunRecord | null> {
    const found = this.runs.find((record) => record.runId === runId);
    return Promise.resolve(found === undefined ? null : cloneRun(found));
  }

  /** Test/seed hook: record an eval run as having happened. */
  recordRun(run: EvalRunRecord): void {
    this.runs.push(cloneRun(run));
    this.runs.sort((left, right) => left.at.localeCompare(right.at));
  }

  async recordDecision(
    request: EvalRecordDecisionRequest,
  ): Promise<EvalRunRecord | null> {
    const found = this.runs.find((record) => record.runId === request.runId);
    if (found === undefined) return null;
    const updated: EvalRunRecord = {
      ...cloneRun(found),
      decision: {
        status: request.status,
        justification: request.justification,
        decidedBy: request.actor,
        decidedAt: request.at,
      },
    };
    const index = this.runs.findIndex((record) => record.runId === request.runId);
    this.runs[index] = updated;
    await Promise.resolve();
    return cloneRun(updated);
  }
}

function cloneRun(run: EvalRunRecord): EvalRunRecord {
  return {
    ...run,
    results: run.results.map((result) => ({ ...result })),
    decision: { ...run.decision },
  };
}
