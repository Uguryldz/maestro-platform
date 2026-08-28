import type { Page, PageRequest } from "../read-models.js";

/**
 * Offset cursors, opaque to the caller.
 *
 * The offset is bound to a fingerprint of the filter that produced it, so a
 * cursor from one query cannot be replayed against another to page past a
 * project scope. A foreign cursor RESTARTS rather than continuing: paging
 * through one list at an offset that meant something in a different one would
 * skip rows silently, and a silent skip in a work queue is a ticket nobody
 * ever sees.
 */
export function encodeCursor(offset: number, fingerprint: string): string {
  return Buffer.from(`${offset}:${fingerprint}`, "utf8").toString("base64url");
}

/**
 * The offset a cursor carries, or 0 when it does not belong to this query.
 *
 * Split on the FIRST colon, not the last: every fingerprint here contains
 * colons (`journal:<runId>:<actor>`), and splitting on the last one parsed the
 * offset out of the middle of the fingerprint, so every cursor looked foreign
 * and every "next page" silently served page one again. An endless first page
 * is the failure a paged list is least likely to be noticed making.
 */
export function decodeCursor(cursor: string | null, fingerprint: string): number {
  if (cursor === null) return 0;
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = raw.indexOf(":");
  if (separator < 0) return 0;
  const offset = Number.parseInt(raw.slice(0, separator), 10);
  if (!Number.isInteger(offset) || offset < 0) return 0;
  return raw.slice(separator + 1) === fingerprint ? offset : 0;
}

/** Slice one page out of an already-filtered list. */
export function paginate<T>(rows: readonly T[], page: PageRequest, fingerprint: string): Page<T> {
  const offset = decodeCursor(page.cursor, fingerprint);
  const items = rows.slice(offset, offset + page.limit);
  const next = offset + items.length;
  return {
    items,
    nextCursor: next < rows.length ? encodeCursor(next, fingerprint) : null,
  };
}

/** The Jira project a ticket key belongs to. */
export function projectOf(ticketKey: string): string {
  return ticketKey.split("-")[0] ?? "";
}

/** `null` means "every project" (M86 cross-project roles). */
export function inScope(ticketKey: string, projectKeys: readonly string[] | null): boolean {
  return projectKeys === null || projectKeys.includes(projectOf(ticketKey));
}
