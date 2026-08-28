/**
 * Reading a Jira issue's ATTACHMENTS (M-attach). The frozen `WorkPort` has no
 * attachment surface, so this is a driver-specific capability reached through
 * the concrete `JiraCloudWorkPort` (same shape as `readProjectWorkflow` and the
 * write-only `addAttachment`). It exists so the analyst is told a ticket carries
 * a screenshot / spec PDF instead of seeing only the text fields.
 */

/** One attachment's metadata — never the bytes; the URL is fetched only if a
 * text attachment's content is actually read. */
export interface JiraAttachment {
  id: string;
  filename: string;
  /** MIME type, e.g. "image/png", "application/pdf", "text/plain". */
  mimeType: string;
  /** Size in bytes. */
  size: number;
  /** Authenticated download URL (`content`) — same host as the connection. */
  contentUrl: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Pull the attachment list out of a `GET /issue/{key}?fields=attachment` body.
 * Robust to the field being absent, null, or not an array — all mean "no
 * attachments", which is normal. Each entry needs at least an id, filename and
 * content URL to be usable; incomplete entries are dropped, never faked.
 */
export function normalizeAttachments(raw: unknown): JiraAttachment[] {
  const fields = record(record(raw)?.["fields"]);
  const list = fields?.["attachment"];
  if (!Array.isArray(list)) return [];

  const out: JiraAttachment[] = [];
  for (const entry of list) {
    const a = record(entry);
    if (a === null) continue;
    const id = str(a["id"]);
    const filename = str(a["filename"]);
    const contentUrl = str(a["content"]);
    if (id === null || filename === null || contentUrl === null) continue;
    const size = typeof a["size"] === "number" ? a["size"] : 0;
    out.push({
      id,
      filename,
      mimeType: str(a["mimeType"]) ?? "application/octet-stream",
      size,
      contentUrl,
    });
  }
  return out;
}

/** A MIME type whose content is plain text the analyst can read inline. */
export function isTextAttachment(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/x-yaml" ||
    m === "application/yaml"
  );
}
