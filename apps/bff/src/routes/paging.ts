import { z } from "zod";
import type { SessionRecord } from "../deps.js";
import { badRequest } from "../errors.js";
import type { Page, PageRequest } from "../read-models.js";
import { CROSS_PROJECT_ROLES, projectGroupFor } from "./access.js";

/**
 * Every list endpoint is bounded (M7). A caller may ask for fewer than
 * {@link MAX_PAGE_SIZE} rows and continue with the cursor the previous page
 * returned; a caller may not ask for "all of them", because the journal and the
 * audit trail grow without limit and the one honest answer to an unbounded
 * request is a smaller page plus a cursor.
 */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * A query-string filter that treats `""` as absent.
 *
 * A browser serialises an unset filter as `?status=`, and a bare `.optional()`
 * rejects the empty string rather than ignoring it — the whole request then
 * fails with 400 and the screen shows nothing. The dashboard hit this twice:
 * once on `cursor`, once on `status`, each time as a 400 that `curl` never
 * reproduced because a hand-written URL simply omits the parameter.
 *
 * Wraps any schema: `blankAsAbsent(z.enum([...]))`, `blankAsAbsent(z.string()
 * .min(1).max(64))`. A present value is still held to its own rules.
 */
export function blankAsAbsent<T>(schema: z.ZodType<T, string>): z.ZodType<T | undefined, string> {
  return z
    .string()
    .transform((value) => (value.trim() === "" ? undefined : value.trim()))
    .pipe(schema.optional()) as unknown as z.ZodType<T | undefined, string>;
}

export const PageQuery = z.object({
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
  /**
   * Opaque to the caller: the shape is the store's business, and a cursor a
   * client can construct is a cursor a client can use to page past a filter.
   *
   * Blank means ABSENT, not invalid. A browser building the first page sends
   * `?cursor=` for an unset value, and `.min(1)` answered 400 `invalid_page` to
   * every such request — the live Studio could not list runs at all, while the
   * same URL without the parameter worked. An empty cursor is exactly what "no
   * cursor" looks like on a query string; refusing it protects nothing, because
   * the guard that matters is the length and opacity of a NON-empty one.
   */
  cursor: blankAsAbsent(z.string().min(1).max(512)).optional(),
});

export type PageQuery = z.infer<typeof PageQuery>;

/** Parse the shared `limit`/`cursor` pair, refusing anything out of range. */
export function pageOf(query: unknown): PageRequest {
  const parsed = PageQuery.safeParse(query);
  if (!parsed.success) throw badRequest("invalid_page");
  return {
    limit: parsed.data.limit ?? DEFAULT_PAGE_SIZE,
    cursor: parsed.data.cursor ?? null,
  };
}

/**
 * The wire shape of a page. `nextCursor: null` means "this was the last page",
 * which Studio needs to be able to tell from "ask again" without guessing from
 * a short page — a full final page is not a signal.
 */
export function pageBody<T>(page: Page<T>): { items: readonly T[]; nextCursor: string | null } {
  return { items: page.items, nextCursor: page.nextCursor };
}

/**
 * Which projects a session may see, or `null` for "all of them" (M86: an admin
 * and a tech lead carry gates across teams). Returning `null` rather than every
 * project key keeps the store from having to be told a list it would ignore.
 *
 * Group membership is the source (M8) and the naming convention is the seam:
 * `maestro-ugurpay` → `UGURPAY`. A group that is not a project group yields
 * nothing, so a stray directory group can never widen access.
 */
export function visibleProjects(session: SessionRecord): readonly string[] | null {
  if (CROSS_PROJECT_ROLES.some((role) => session.roles.includes(role))) return null;
  const prefix = projectGroupFor("");
  return session.groups
    .filter((group) => group.startsWith(prefix) && group.length > prefix.length)
    .map((group) => group.slice(prefix.length).toUpperCase());
}
