import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authGuard, requireAnyRole } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import type { GuidanceStore } from "../guidance-store.js";
import { badRequest, notFound } from "../errors.js";
import { visibleText } from "../doc-template-scan.js";
import { DOCX_DOCUMENT_ENTRY, DocxReadError, readZipEntry } from "../docx-zip.js";
import { assertWritable } from "../platform/propose.js";
import { unwired } from "./unwired.js";

/**
 * Analysis guidance — the "öğren" knowledge library (Bilgi kütüphanesi). An
 * operator uploads short notes; the enabled ones are injected into the analyst's
 * context when a NEW analysis is prepared, so the AI "learns" what to watch for.
 *
 * Reading is open to anyone with a login (viewer+); writing is admin/tech-lead,
 * the same posture as the other configuration surfaces. The enabled-notes read
 * (`/studio/guidance/active`) is what the pilot mirrors to feed the analyst.
 */
const READ_ROLES = ["viewer", "admin", "tech-lead", "product-owner", "qa", "developer"] as const;
const WRITE_ROLES = ["admin", "tech-lead"] as const;

const CreateBody = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20_000),
  enabled: z.boolean().default(true),
});
const PatchBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
  enabled: z.boolean().optional(),
});
const IdParam = z.object({ id: z.string().trim().min(1).max(64) });

/**
 * A file upload, as JSON rather than multipart: Studio reads the file with
 * `FileReader` and posts `{ fileName, contentBase64 }`, which keeps the route
 * inside the same JSON body pipeline (auth, bodyLimit, error shape) as every
 * other Studio write — no extra content-type parser for one endpoint.
 */
const UploadBody = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentBase64: z.string().min(1),
  /**
   * Target agent variant — the note then feeds ONLY that agent's context.
   * Optional; empty/whitespace collapses to null = global (all agents),
   * which is exactly what the pre-variantId Studio kept sending.
   */
  variantId: z.string().trim().max(64).optional(),
});

/** File types an operator may upload as a guidance note. */
const UPLOAD_EXTENSIONS = new Set(["md", "txt", "docx"]);

/**
 * Caps. The RAW cap bounds what is decoded at all (a `.docx` is a zip, so its
 * bytes exceed its text); the TEXT cap is the real budget — the note's content
 * is injected verbatim into the analyst's context, and ~200 KB of text is
 * already far beyond a useful "dikkat edilecekler" note.
 */
const MAX_UPLOAD_RAW_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_TEXT_BYTES = 200 * 1024;

function guidanceStore(deps: ResolvedDeps): GuidanceStore {
  if (deps.guidance === undefined) unwired("guidance");
  return deps.guidance;
}

export async function guidanceRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const readHandler = [authGuard(deps), requireAnyRole(...READ_ROLES)];
  const writeHandler = [authGuard(deps), requireAnyRole(...WRITE_ROLES)];

  /** Every note, newest first — the library screen. */
  app.get("/studio/guidance", { preHandler: readHandler }, async (_request, reply) => {
    const notes = await guidanceStore(deps).list();
    return reply.code(200).send({ notes });
  });

  /** The ENABLED notes — what the analyst learns from (pilot mirrors this). */
  app.get("/studio/guidance/active", { preHandler: readHandler }, async (_request, reply) => {
    const notes = await guidanceStore(deps).listEnabled();
    return reply.code(200).send({ notes });
  });

  /** Add a note. */
  app.post("/studio/guidance", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const body = CreateBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_guidance");
    const note = await guidanceStore(deps).create(body.data);
    return reply.code(201).send({ note });
  });

  /**
   * Upload a FILE as a note — "ajan eğitimi" from a document the operator
   * already has. `.md`/`.txt` are taken as UTF-8 text; `.docx` goes through the
   * same zip reader + text extraction the corporate-template scan uses. The
   * extracted text becomes an ordinary enabled note (title = file name), so
   * everything downstream — the /active mirror, the pilot push, the analyst
   * context — treats it exactly like a typed note.
   */
  app.post("/studio/guidance/upload", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const body = UploadBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_guidance_upload");
    const { fileName, contentBase64 } = body.data;
    const variantId =
      body.data.variantId === undefined || body.data.variantId === "" ? null : body.data.variantId;

    const extension = fileName.toLowerCase().split(".").pop() ?? "";
    if (!UPLOAD_EXTENSIONS.has(extension)) throw badRequest("guidance_upload_type");

    const bytes = decodeBase64(contentBase64);
    if (bytes.byteLength > MAX_UPLOAD_RAW_BYTES) throw badRequest("guidance_upload_too_large");

    const text = (extension === "docx" ? docxText(bytes) : Buffer.from(bytes).toString("utf8")).trim();
    if (text === "") throw badRequest("invalid_guidance_upload", { reason: "empty" });
    if (Buffer.byteLength(text, "utf8") > MAX_UPLOAD_TEXT_BYTES) {
      throw badRequest("guidance_upload_too_large");
    }

    const note = await guidanceStore(deps).create({
      title: fileName,
      content: text,
      enabled: true,
      variantId,
    });
    return reply.code(201).send({ note });
  });

  /** Edit a note's title/content or toggle whether the AI learns from it. */
  app.put("/studio/guidance/:id", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_guidance");
    const body = PatchBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_guidance");
    const note = await guidanceStore(deps).update(params.data.id, body.data);
    if (note === null) throw notFound("no_such_guidance");
    return reply.code(200).send({ note });
  });

  /** Remove a note. */
  app.delete("/studio/guidance/:id", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_guidance");
    const removed = await guidanceStore(deps).remove(params.data.id);
    if (!removed) throw notFound("no_such_guidance");
    return reply.code(204).send();
  });
}

/**
 * Strictly-checked base64. `Buffer.from(s, "base64")` silently skips characters
 * it does not understand, so a mangled payload would decode to SOMETHING and be
 * stored as a corrupted note; checking the alphabet first turns that into a 400.
 */
function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/\s+/g, "");
  if (compact === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw badRequest("invalid_guidance_upload", { reason: "not_base64" });
  }
  return new Uint8Array(Buffer.from(compact, "base64"));
}

/**
 * The visible text of a `.docx`, via the same central-directory zip reader and
 * markup stripper the corporate-template scan trusts (docx-zip.ts is written
 * for attacker-influenced bytes; nothing new is parsed here). A file that wears
 * the extension but is not a Word package is refused as a type error — storing
 * raw XML or zip noise as "guidance" would poison the analyst's context.
 */
function docxText(bytes: Uint8Array): string {
  let documentBytes: Uint8Array | null;
  try {
    documentBytes = readZipEntry(bytes, DOCX_DOCUMENT_ENTRY);
  } catch (error) {
    if (error instanceof DocxReadError) {
      throw badRequest("guidance_upload_type", { reason: error.message });
    }
    throw error;
  }
  if (documentBytes === null) throw badRequest("guidance_upload_type", { reason: "not_a_docx" });
  return visibleText(Buffer.from(documentBytes).toString("utf8"));
}
