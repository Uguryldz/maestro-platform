/**
 * What a run is pinned to at the moment it opens: an agent variant and an
 * analysis template version (M38/M83).
 *
 * Both are read ONCE, when the row is written, and never again. Publishing a
 * new agent version or a new template mid-run must not change the rules under a
 * ticket that is already being analysed — and the document a reviewer approves
 * has to be the one the run was configured to produce.
 *
 * They live here rather than inline in `bin/bff.ts` because the value has a
 * fallback story that needs stating, and a fallback buried in a wiring
 * expression is a fallback nobody reviews.
 */

/** The variant every run falls back to when no rule names one. */
export const DEFAULT_ANALYST_VARIANT = "analyst-default";

/** The template version a deployment with no published template pins to. */
export const UNVERSIONED_TEMPLATE = "unversioned";

/** The two delegates these lookups use, and no more. */
export interface RunPinDb {
  variant: {
    findFirst(args: {
      where: { role: "analyst" };
      orderBy: { id: "asc" };
    }): Promise<{ id: string } | null>;
  };
  analysisTemplateVersion: {
    findFirst(args: { orderBy: { version: "desc" } }): Promise<{ version: number } | null>;
  };
}

/**
 * The analyst variant this run will use.
 *
 * `intake` has no variant of its own — the pilot runs its intake against the
 * analyst's variant too (`apps/pilot/src/run.ts`), and splitting them here
 * would mean two agents could drift apart for one ticket.
 *
 * Falling back to a literal is safe in a way that falling back to `""` is not:
 * an empty variant fails the gateway's contract on the first model call, three
 * activity retries deep, where it reads as a model problem rather than a run
 * opened without saying which agent it runs.
 */
export async function activeAnalystVariantId(db: RunPinDb): Promise<string> {
  const row = await db.variant.findFirst({ where: { role: "analyst" }, orderBy: { id: "asc" } });
  return row?.id ?? DEFAULT_ANALYST_VARIANT;
}

/**
 * The newest published analysis template, as the string the workflow compares.
 *
 * `assertDocument` (packages/workflows/src/impl/analysis.ts) rejects an analysis
 * whose `templateVersion` differs from the run's, so this value and the one the
 * analyst stamps must be produced the same way. A deployment that has published
 * no template pins to `unversioned` rather than to `""`, so the mismatch error
 * names something an operator can look for.
 */
export async function activeTemplateVersion(db: RunPinDb): Promise<string> {
  const row = await db.analysisTemplateVersion.findFirst({ orderBy: { version: "desc" } });
  return row === null ? UNVERSIONED_TEMPLATE : String(row.version);
}
