import type { Prisma, PrismaClient } from "@prisma/client";
import { SEED_ACTOR } from "./params-defaults.js";
import {
  DEFAULT_ANALYSIS_TEMPLATE_NAME,
  DEFAULT_ANALYSIS_TEMPLATE_SECTIONS,
} from "./template-defaults.js";

export interface SeedTemplateOptions {
  /** Recorded as `publishedBy` on version 1. */
  publishedBy?: string;
  /** Injected clock — keeps seeding deterministic in tests. */
  now?: Date;
}

export interface SeedTemplateResult {
  /** True when this call wrote version 1; false when a template already existed. */
  seeded: boolean;
  sections: number;
}

/**
 * Publish version 1 of the analysis template, once (M108).
 *
 * Idempotent in the strictest sense available: it writes ONLY when the table is
 * empty, and it never updates. That is stronger than the parameter seed's
 * upsert, and deliberately so — `AnalysisTemplateVersion` is append-only at the
 * database level (migration 0007), so an "update" would not merely be wrong, it
 * would be refused by a trigger. Re-running the installer against a bank that
 * has published version 4 must leave version 4 alone and report that it did.
 *
 * Version 1 rather than "a template for every project": this platform resolves
 * one template for the whole institution, and seeding per project would invent
 * a per-project override the engine does not honour.
 *
 * The race is handled by the database, not by this check. Two installers
 * running at once both see an empty table; the primary key on `version` means
 * one INSERT wins and the other raises a unique violation, which is caught and
 * reported as "already seeded" — the outcome the loser wanted anyway.
 */
export async function seedAnalysisTemplate(
  db: Pick<PrismaClient, "analysisTemplateVersion">,
  options: SeedTemplateOptions = {},
): Promise<SeedTemplateResult> {
  const existing = await db.analysisTemplateVersion.findFirst({
    orderBy: { version: "desc" },
  });
  if (existing !== null) {
    return { seeded: false, sections: 0 };
  }

  try {
    await db.analysisTemplateVersion.create({
      data: {
        version: 1,
        name: DEFAULT_ANALYSIS_TEMPLATE_NAME,
        sectionsJson: DEFAULT_ANALYSIS_TEMPLATE_SECTIONS.map((section) => ({
          key: section.key,
          title: section.title,
          description: section.description,
          aiInstruction: section.aiInstruction,
          required: section.required,
          format: section.format,
          example: section.example,
        })) as Prisma.InputJsonValue,
        publishedBy: options.publishedBy ?? SEED_ACTOR,
        publishedAt: options.now ?? new Date(),
      },
    });
  } catch (error) {
    // Another installer won the race. Re-read rather than trusting the error
    // code: if a row is there now, the desired state holds and this call has
    // nothing left to do. If the table is still empty the failure was real and
    // must not be swallowed — an installation that silently ends with no
    // template would put the designer screen back where it started.
    const now = await db.analysisTemplateVersion.findFirst({ orderBy: { version: "desc" } });
    if (now === null) throw error;
    return { seeded: false, sections: 0 };
  }

  return { seeded: true, sections: DEFAULT_ANALYSIS_TEMPLATE_SECTIONS.length };
}
