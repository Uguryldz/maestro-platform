import { z } from "zod";
import { LlmRole } from "@maestro/contracts";
import type { ResolvedDeps } from "./deps.js";
import type {
  VariantDetail,
  VariantWriteFields,
  VariantWriter,
} from "./read-studio.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { unwired } from "./routes/unwired.js";

/**
 * The variant designer's write side (M38/M83).
 *
 * Two rules decide this file:
 *
 * 1. **Versions are immutable.** Creating a variant publishes version 1;
 *    `publishVersion` appends `latest + 1`. The model and persona are versioned
 *    fields — editing them means publishing a new version, never rewriting an
 *    old one, because a run pinned to version 4 (M83) must keep reading what
 *    version 4 said.
 * 2. **The route never invents privileged fields.** The author, the timestamp
 *    and the version number are DERIVED here from the session and the clock; a
 *    request body that carried them would be ignored. A client cannot backdate a
 *    version, forge an author or skip the sequence.
 */

/** The variant id grammar — the same `VarChar(64)` the table stores. */
export const VariantId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "variant ids are lower-case, dash-separated");

/** The platform overlay (`web`, `mobile-ios`, `desktop`, `default`…). */
const Platform = z.string().trim().min(1).max(64);

const Model = z.string().trim().min(1).max(128);

/**
 * Refuse control characters other than tab (U+0009) and newline (U+000A): a
 * persona is prompt text, and an embedded NUL or escape sequence is a mistake
 * or an attempt to smuggle something past a later renderer. Built from a
 * predicate rather than a literal regex so no raw control byte lives in source.
 */
function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isTabOrNewline = code === 0x09 || code === 0x0a;
    if (!isTabOrNewline && (code < 0x20 || code === 0x7f)) return true;
  }
  return false;
}

/**
 * The persona/prompt overlay. Bounded so a runaway paste cannot become a stored
 * prompt megabytes long.
 */
const Persona = z
  .string()
  .max(20_000)
  .refine((value) => !hasControlChar(value), {
    message: "persona contains control characters",
  });

const KnowledgeRefs = z
  .array(z.string().trim().min(1).max(200))
  .max(100)
  .default([]);

const Note = z.string().trim().max(500).default("");

/** The versioned fields — what a create or a new version carries. */
const WriteFields = z.object({
  model: Model,
  persona: Persona,
  knowledgeRefs: KnowledgeRefs,
  note: Note,
});

export const VariantCreateBody = z.object({
  variantId: VariantId,
  role: LlmRole,
  platform: Platform,
  model: Model,
  persona: Persona,
  knowledgeRefs: KnowledgeRefs,
  note: Note,
});

export const VariantEditBody = z.object({ platform: Platform });

export const VariantVersionBody = WriteFields;

function fieldsOf(input: z.infer<typeof WriteFields>): VariantWriteFields {
  return {
    model: input.model,
    persona: input.persona,
    // Dedupe, preserving order: two identical refs are one file, and a stored
    // duplicate would show the same knowledge twice on the detail screen.
    knowledgeRefs: [...new Set(input.knowledgeRefs)],
    note: input.note,
  };
}

/** The injected writer, or a 503 by name when this deployment wired none. */
function writerOf(deps: ResolvedDeps): VariantWriter {
  const writer = deps.studio.variantWriter;
  if (writer === undefined) unwired("variants");
  return writer;
}

export async function createVariant(
  deps: ResolvedDeps,
  input: { body: unknown; actor: string },
): Promise<VariantDetail> {
  const writer = writerOf(deps);
  const parsed = VariantCreateBody.safeParse(input.body);
  if (!parsed.success) throw badRequest("invalid_variant_body", { issues: issuesOf(parsed) });

  const at = deps.clock.now().toISOString();
  let detail: VariantDetail;
  try {
    detail = await writer.create({
      variantId: parsed.data.variantId,
      role: parsed.data.role,
      platform: parsed.data.platform,
      fields: fieldsOf(parsed.data),
      actor: input.actor,
      at,
    });
  } catch {
    // The only refusal the writer raises is "already exists".
    throw conflict("variant_exists", { variantId: parsed.data.variantId });
  }

  await deps.audit.append({
    actor: input.actor,
    // INTERFACE REQUEST: `AuditAction` (frozen) has no `VARIANT_PUBLISHED`.
    // `PARAM_CHANGED` is the closest true statement — a versioned, audited
    // configuration change from Studio — and the `variant:` subject prefix
    // keeps it findable, exactly as the template and doc-template writes do.
    action: "PARAM_CHANGED",
    subject: `variant:${parsed.data.variantId}`,
    at,
    meta: {
      kind: "variant_create",
      role: parsed.data.role,
      platform: parsed.data.platform,
      version: 1,
      model: parsed.data.model,
    },
  });
  return detail;
}

export async function editVariant(
  deps: ResolvedDeps,
  input: { variantId: string; body: unknown; actor: string },
): Promise<VariantDetail> {
  const writer = writerOf(deps);
  const parsed = VariantEditBody.safeParse(input.body);
  if (!parsed.success) throw badRequest("invalid_variant_body", { issues: issuesOf(parsed) });

  const at = deps.clock.now().toISOString();
  const detail = await writer.edit({
    variantId: input.variantId,
    platform: parsed.data.platform,
    actor: input.actor,
    at,
  });
  if (detail === null) throw notFound("unknown_variant");

  await deps.audit.append({
    actor: input.actor,
    action: "PARAM_CHANGED",
    subject: `variant:${input.variantId}`,
    at,
    meta: { kind: "variant_edit", platform: parsed.data.platform },
  });
  return detail;
}

export async function publishVariantVersion(
  deps: ResolvedDeps,
  input: { variantId: string; body: unknown; actor: string },
): Promise<VariantDetail> {
  const writer = writerOf(deps);
  const parsed = VariantVersionBody.safeParse(input.body);
  if (!parsed.success) throw badRequest("invalid_variant_body", { issues: issuesOf(parsed) });

  const at = deps.clock.now().toISOString();
  const detail = await writer.publishVersion({
    variantId: input.variantId,
    fields: fieldsOf(parsed.data),
    actor: input.actor,
    at,
  });
  if (detail === null) throw notFound("unknown_variant");

  await deps.audit.append({
    actor: input.actor,
    action: "PARAM_CHANGED",
    subject: `variant:${input.variantId}`,
    at,
    meta: {
      kind: "variant_version",
      version: detail.activeVersion,
      model: parsed.data.model,
    },
  });
  return detail;
}

/** The first failing field, named — enough for the screen without echoing input. */
function issuesOf(parsed: { error: z.ZodError }): string {
  return parsed.error.issues[0]?.path.join(".") || "body";
}
