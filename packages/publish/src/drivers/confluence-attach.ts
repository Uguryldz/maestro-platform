import { z } from "zod";
import { PublishRenderError, PublishResponseError } from "../errors.js";

/**
 * Confluence attachment upload (M103r).
 *
 * Split out of `confluence.ts` to keep that file within the size budget, and
 * because attaching a BINARY is a different conversation with the API than
 * writing a page: multipart instead of JSON, an XSRF header, and two different
 * endpoints depending on whether the file is new.
 */

/** A generated document on its way to a page. */
export interface AttachableFile {
  name: string;
  bytes: Uint8Array;
  contentType: string;
}

/**
 * The driver's own `request`, injected so this module needs no config, no
 * token handling and no fetch of its own — and so the tests that already fake
 * the driver's HTTP layer cover this path too.
 */
export type ConfluenceRequest = (
  method: "GET" | "POST" | "PUT",
  path: string,
  query?: Record<string, string>,
  body?: unknown,
  allow404?: boolean,
) => Promise<unknown>;

/**
 * Creating returns `{results:[…]}`; updating an existing attachment returns the
 * attachment object itself. Both are accepted so the caller never has to know
 * which endpoint ran.
 */
const AttachmentResponse = z.object({
  id: z.string().min(1).optional(),
  results: z.array(z.object({ id: z.string().min(1) })).optional(),
});

/**
 * Attach `file` to `pageId`, updating in place when a file of that name is
 * already there.
 *
 * Updating matters: POSTing the same name twice makes Confluence keep BOTH, as
 * `analiz.docx` and `analiz(1).docx`. A reviewer opening the page then has to
 * guess which one the gate approved, and an evidence package that carries three
 * near-identical Word files is worse than useless at an audit. One name, one
 * attachment, versioned by Confluence.
 */
export async function attachToPage(
  request: ConfluenceRequest,
  pageId: string,
  file: AttachableFile,
): Promise<{ attachmentId: string }> {
  if (file.bytes.byteLength === 0) {
    // A zero-byte attachment uploads perfectly happily and opens as a corrupt
    // document. Refused here, where the reason is still knowable.
    throw new PublishRenderError(`refusing to attach an empty file (${file.name}) to page ${pageId}`);
  }

  const existing = await findAttachment(request, pageId, file.name);
  const path =
    existing === null
      ? `/rest/api/content/${pageId}/child/attachment`
      : `/rest/api/content/${pageId}/child/attachment/${existing}/data`;

  const form = new FormData();
  // A fresh copy rather than a Blob over the caller's view: a Blob built on a
  // pooled Node Buffer whose view does not start at offset 0 can serialise
  // neighbouring bytes — i.e. another document's contents.
  const copy = new Uint8Array(file.bytes.byteLength);
  copy.set(file.bytes);
  form.append("file", new Blob([copy], { type: file.contentType }), file.name);
  form.append("minorEdit", "true");

  const parsed = AttachmentResponse.safeParse(await request("POST", path, undefined, form));
  const id = parsed.success ? (parsed.data.results?.[0]?.id ?? parsed.data.id) : undefined;
  if (id === undefined || id.length === 0) {
    throw new PublishResponseError("attachment", ["no attachment id in the response"]);
  }
  return { attachmentId: id };
}

/** Attachment id for `fileName` on this page, or null when there is none. */
async function findAttachment(
  request: ConfluenceRequest,
  pageId: string,
  fileName: string,
): Promise<string | null> {
  const found = await request(
    "GET",
    `/rest/api/content/${pageId}/child/attachment`,
    { filename: fileName },
    undefined,
    true,
  );
  if (found === null) return null;
  const parsed = AttachmentResponse.safeParse(found);
  return parsed.success ? (parsed.data.results?.[0]?.id ?? null) : null;
}
