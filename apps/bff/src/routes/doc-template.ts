import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, notFound } from "../errors.js";
import { MAX_TEMPLATE_BYTES, readDocTemplate, uploadDocTemplate } from "../doc-template-service.js";
import { assertWritable } from "../platform/propose.js";

/**
 * The corporate Word template (M103r/M109).
 *
 * Who may read it and who may replace it are the same two roles that own the
 * analysis template: the file decides what every published document in the
 * institution looks like, and its approval table is what a gate signs.
 *
 * Reading is open to both; UPLOADING is `admin` alone. A tech lead choosing
 * the questions an analysis must answer (M108) is editing a method; whoever
 * uploads the `.docx` is changing the letterhead every document leaves the
 * bank under, and that is a document-owner decision.
 */
export const DOC_TEMPLATE_READ_ROLES = ["admin", "tech-lead"] as const;
export const DOC_TEMPLATE_WRITE_ROLES = ["admin"] as const;

const VersionParams = z.object({ version: z.coerce.number().int().positive() });

/**
 * The uploaded file name, as it will be shown and stored.
 *
 * Bounded and stripped of any path: the name is displayed in Studio and
 * recorded in the audit trail, so `../../etc/passwd` or a 4 KB name is a
 * problem regardless of whether anything ever opens it as a path. Nothing here
 * writes to a filesystem — this is the check that keeps it true if something
 * later does.
 */
const FileName = z
  .string()
  .min(1)
  .max(200)
  .transform((name) => name.replace(/[\\/]/g, "_").trim())
  .refine((name) => name.length > 0, { message: "file name is empty after sanitising" })
  .refine((name) => name.toLowerCase().endsWith(".docx"), {
    message: "the corporate template must be a .docx",
  });

/**
 * The Studio screen's endpoints.
 *
 * The upload is a raw `.docx` body rather than a multipart form: the platform
 * needs the bytes VERBATIM (M103r — the bank's styles survive because nothing
 * re-serialises them), and multipart adds a parser between the browser and
 * those bytes for no gain when the request carries exactly one file. The file
 * name travels in a header, which is also what the browser's own
 * `fetch(file)` sends most naturally.
 *
 * It runs in its own encapsulation context for the same reason the webhooks
 * do: the binary content-type parser registered here must not reach the JSON
 * API, where it would turn every other route's body into a Buffer.
 */
export async function docTemplateRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const readHandler = [authGuard(deps), requireAnyRole(...DOC_TEMPLATE_READ_ROLES)];
  const writeHandler = [authGuard(deps), requireAnyRole(...DOC_TEMPLATE_WRITE_ROLES)];

  app.addContentTypeParser(
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream",
    ],
    // Bounded at the parser, before the body is in memory: `bodyLimit` here is
    // what refuses a 2 GB upload without first reading 2 GB of it. The service
    // checks the same limit again for the callers that never pass through this
    // parser.
    { parseAs: "buffer", bodyLimit: MAX_TEMPLATE_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get("/doc-template", { preHandler: readHandler }, async (_request, reply) => {
    return reply.code(200).send(await readDocTemplate(deps));
  });

  /**
   * Upload a new corporate template.
   *
   * A new VERSION, never an edit (M83): a run that started against version 2
   * is judged against version 2 whatever lands afterwards, so the previous
   * file stays readable rather than being overwritten by this one.
   */
  app.post("/doc-template", { preHandler: writeHandler }, async (request, reply) => {
    // The kill switch stops writes (M58). Checked before the body is looked at
    // so a stopped platform refuses identically whatever was uploaded.
    await assertWritable(deps);

    const fileName = FileName.safeParse(request.headers["x-maestro-filename"]);
    if (!fileName.success) {
      throw badRequest("invalid_doc_template_filename", {
        reason: fileName.error.issues[0]?.message ?? "missing X-Maestro-Filename header",
      });
    }

    const content = bodyBytes(request);
    const view = await uploadDocTemplate(deps, {
      fileName: fileName.data,
      content,
      actor: sessionActor(sessionOf(request)),
    });
    // 201: the upload created a version rather than updating the current one.
    return reply.code(201).send(view);
  });

  /**
   * A specific version's bytes — how a pinned run (M83) fetches the file it
   * must render against, and how a document owner downloads what they
   * uploaded to check it in Word.
   */
  app.get("/doc-template/versions/:version/file", { preHandler: readHandler }, async (request, reply) => {
    const params = VersionParams.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_doc_template_version");

    const record = await deps.docTemplates.get(params.data.version);
    if (record === null) {
      throw notFound("doc_template_version_not_found", { version: params.data.version });
    }

    return reply
      .code(200)
      .header(
        "content-type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      )
      // `attachment` rather than inline: the browser must never be talked into
      // rendering an uploaded file in this origin.
      .header("content-disposition", `attachment; filename="${asciiFileName(record.fileName)}"`)
      .send(Buffer.from(record.content));
  });
}

/**
 * The raw upload.
 *
 * A body that is not a Buffer means the request arrived with a content type
 * the parser above does not cover — JSON, a form — and that is refused by name
 * rather than coerced. `Buffer.from(anything)` would happily produce bytes,
 * and those bytes would then be stored as a corporate template.
 */
function bodyBytes(request: FastifyRequest): Uint8Array {
  const body: unknown = request.body;
  if (!Buffer.isBuffer(body)) {
    throw badRequest("doc_template_body", {
      reason: "send the .docx as a raw body with a Word or octet-stream content type",
    });
  }
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

/**
 * `Content-Disposition` is a header, and a header is ASCII. A Turkish file
 * name ("Analiz Şablonu.docx") would otherwise put raw non-ASCII bytes into
 * the response headers, and a quote in a name would end the quoted string
 * early — the classic header-injection shape.
 */
function asciiFileName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return ascii.trim().length === 0 ? "template.docx" : ascii;
}
