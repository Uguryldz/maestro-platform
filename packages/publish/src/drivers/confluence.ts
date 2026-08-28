import { z } from "zod";
import { NonEmpty, type PublishReceipt, type PublishRequest, type PublishTarget } from "@maestro/contracts";
import type { SecretPort } from "@maestro/ports";
import { PublishConfigError, PublishHttpError, PublishRenderError, PublishResponseError } from "../errors.js";
import { attachToPage, type AttachableFile } from "./confluence-attach.js";
import { DOC_TITLE_KEY } from "../keys.js";
import { label } from "../md.js";
import { markdownToStorage } from "../storage-format.js";
import type { FetchLike, PublishStateStore, RunContextResolver, TargetPublisher, Translate } from "../types.js";

/**
 * The PAT travels in an `Authorization: Bearer` header, so the scheme decides
 * whether it travels in clear text. `z.url()` on its own accepts `http:`,
 * `ftp:` and `javascript:` alike, which is why the scheme is checked
 * explicitly — same rule as the sibling ADO adapter.
 */
function baseUrlIssue(value: { baseUrl: string; allowInsecureHttp: boolean }): string | null {
  let protocol: string;
  try {
    protocol = new URL(value.baseUrl).protocol;
  } catch {
    return "baseUrl is not an absolute URL";
  }
  if (protocol === "https:") return null;
  if (protocol === "http:" && value.allowInsecureHttp) return null;
  return (
    `baseUrl must use https (got ${protocol}` +
    `${protocol === "http:" ? "; set allowInsecureHttp for local development only" : ""})`
  );
}

export const ConfluencePublishConfig = z
  .object({
    /** e.g. https://confluence.internal.bank (a `/confluence` context path is fine). */
    baseUrl: z.url(),
    spaceKey: z.string().regex(/^[A-Za-z0-9._~-]+$/),
    /** SecretPort reference for the PAT — never the token itself (M80). */
    tokenRef: NonEmpty,
    parentPageId: z.string().regex(/^\d+$/).optional(),
    /** Version conflicts are someone else editing the page at the same time. */
    maxVersionAttempts: z.number().int().min(1).max(5).default(3),
    timeoutMs: z.number().int().positive().max(120_000).default(15_000),
    retryDelayMs: z.number().int().nonnegative().max(10_000).default(250),
    /** Local development escape hatch for a plain-HTTP base URL; never in a bank. */
    allowInsecureHttp: z.boolean().default(false),
  })
  .strict()
  .check((ctx) => {
    const value = ctx.value as { baseUrl: string; allowInsecureHttp: boolean };
    const issue = baseUrlIssue(value);
    if (issue !== null) ctx.issues.push({ code: "custom", message: issue, input: value.baseUrl, path: ["baseUrl"] });
  });
export type ConfluencePublishConfig = z.infer<typeof ConfluencePublishConfig>;

const PageVersion = z.object({ number: z.number().int().positive() });
const Page = z.object({
  id: z.string().min(1),
  version: PageVersion,
  body: z.object({ storage: z.object({ value: z.string() }) }).optional(),
});
const SearchResult = z.object({ results: z.array(Page) });
type Page = z.infer<typeof Page>;

/** Confluence answers 400, not 409, when a space already holds the title. */
const DUPLICATE_TITLE = /already exist|duplicate title|title.*already/i;

export interface ConfluencePublisherDeps {
  secrets: SecretPort;
  state: PublishStateStore;
  runContext: RunContextResolver;
  translate: Translate;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Confluence driver (M47): one page per (run, document), created once and
 * updated afterwards — republishing bumps the page version, it never opens a
 * second page. The page id is remembered so a changed page TITLE (a catalog
 * edit, a renamed ticket) cannot orphan the page and fork the document.
 *
 * Concurrent edits answer 409; the driver re-reads the version and retries a
 * bounded number of times instead of overwriting blindly.
 */
export class ConfluencePublisher implements TargetPublisher {
  readonly target: PublishTarget = "confluence";
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: ConfluencePublishConfig,
    private readonly deps: ConfluencePublisherDeps,
  ) {
    const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) throw new PublishConfigError("the confluence target has no fetch implementation");
    if (typeof deps.secrets?.get !== "function") {
      throw new PublishConfigError("the confluence target needs deps.secrets (SecretPort)");
    }
    this.fetchImpl = fetchImpl;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async publish(req: PublishRequest, markdownSource: string): Promise<PublishReceipt> {
    const { ticketKey } = await this.deps.runContext(req.runId);
    const title = label(this.deps.translate, req.locale, DOC_TITLE_KEY[req.doc], { ticket: ticketKey });
    const storage = markdownToStorage(markdownSource);
    if (storage.trim().length === 0) {
      // The source was not blank (the port checks that) but nothing survived
      // parsing — an unterminated comment, a document of markers only. An
      // empty page with a "published" receipt is a lie in the evidence pack.
      throw new PublishRenderError(`document ${req.doc} rendered to empty Confluence storage format`);
    }
    // Keyed by TICKET, exactly like the title: the page is one living document
    // per ticket, so a run-scoped key made the producer and the consumer of
    // the identity disagree — the second run of a ticket looked the page up by
    // title instead of by id and any title drift forked the document.
    const stateKey = `publish:confluence:${ticketKey}:${req.doc}`;

    for (let attempt = 1; attempt <= this.config.maxVersionAttempts; attempt += 1) {
      const existing = await this.locate(stateKey, title);
      if (!existing) {
        const created = await this.create(title, storage);
        if (created) {
          await this.deps.state.set(stateKey, created.id);
          return { target: this.target, ref: created.id };
        }
        // Confluence says the title is taken but the search has not caught up
        // with its own index yet: wait and look again instead of forking.
        await this.sleep(this.config.retryDelayMs * attempt);
        continue;
      }

      // Same bytes already on the page: a new version would be noise in the
      // page history and would tell an auditor the document changed.
      if (existing.body?.storage.value === storage) {
        await this.deps.state.set(stateKey, existing.id);
        return { target: this.target, ref: existing.id };
      }

      const updated = await this.update(existing, title, storage);
      if (updated) {
        await this.deps.state.set(stateKey, existing.id);
        return { target: this.target, ref: existing.id };
      }
      await this.sleep(this.config.retryDelayMs * attempt);
    }

    throw new PublishHttpError(
      409,
      "PUT",
      `${this.config.baseUrl}/rest/api/content`,
      `page "${title}" could not be settled in ${String(this.config.maxVersionAttempts)} attempts ` +
        `(version race, or a page with this title exists but is not searchable yet)`,
    );
  }

  /** Remembered page first, then a title lookup in the configured space. */
  private async locate(stateKey: string, title: string): Promise<Page | null> {
    const knownId = await this.deps.state.get(stateKey);
    if (knownId !== null && /^\d+$/.test(knownId)) {
      const page = await this.request("GET", `/rest/api/content/${knownId}`, { expand: "version,body.storage" }, undefined, true);
      if (page !== null) return parse(Page, page, "page");
    }
    const found = await this.request(
      "GET",
      "/rest/api/content",
      { type: "page", spaceKey: this.config.spaceKey, title, expand: "version,body.storage" },
      undefined,
      true,
    );
    if (found === null) return null;
    return parse(SearchResult, found, "search").results[0] ?? null;
  }

  /** The created page, or null when the space already holds this title (F12). */
  private async create(title: string, storage: string): Promise<Page | null> {
    const body = {
      type: "page",
      title,
      space: { key: this.config.spaceKey },
      ...(this.config.parentPageId ? { ancestors: [{ id: this.config.parentPageId }] } : {}),
      body: { storage: { value: storage, representation: "storage" } },
    };
    try {
      const created = await this.request("POST", "/rest/api/content", undefined, body);
      return parse(Page, created, "create");
    } catch (error) {
      if (error instanceof PublishHttpError && error.status === 400 && DUPLICATE_TITLE.test(error.body)) return null;
      throw error;
    }
  }

  /** True when the update landed; false on a version conflict worth retrying. */
  private async update(page: Page, title: string, storage: string): Promise<boolean> {
    const body = {
      id: page.id,
      type: "page",
      title,
      space: { key: this.config.spaceKey },
      version: { number: page.version.number + 1, minorEdit: true },
      body: { storage: { value: storage, representation: "storage" } },
    };
    try {
      await this.request("PUT", `/rest/api/content/${page.id}`, undefined, body);
      return true;
    } catch (error) {
      if (error instanceof PublishHttpError && error.status === 409) return false;
      throw error;
    }
  }

  /**
   * Attach a generated `.docx`/`.pdf` to the ticket's living page (M103r).
   * See `confluence-attach.ts` for why re-attaching updates in place.
   */
  attach(pageId: string, file: AttachableFile): Promise<{ attachmentId: string }> {
    return attachToPage((method, path, query, body, allow404) => this.request(method, path, query, body, allow404), pageId, file);
  }

  /**
   * `allow404` turns "not found" into null — and ONLY the lookups in
   * `locate()` are allowed to ask for it. Translating 404 for every method
   * meant a PUT to a deleted page returned null, `update()` saw no exception
   * and the run received a "published" receipt for a document Confluence had
   * never stored: a forged record inside a ten-year evidence package (F1).
   */
  private async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    allow404 = false,
  ): Promise<unknown> {
    const url = new URL(this.config.baseUrl.replace(/\/+$/, "") + path);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    const token = await this.deps.secrets.get(this.config.tokenRef);
    if (typeof token !== "string" || token.trim().length === 0) {
      // An empty PAT would be sent as `Bearer ` and Confluence would answer as
      // the anonymous user — a silent identity downgrade, not a 401.
      throw new PublishConfigError(`the resolved Confluence token (${this.config.tokenRef}) is empty`);
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.config.timeoutMs) };
    if (body instanceof FormData) {
      // Confluence rejects an unmarked multipart POST as a cross-site request.
      // `content-type` is deliberately NOT set: fetch has to add the multipart
      // boundary itself, and a hand-written header loses it.
      headers["x-atlassian-token"] = "nocheck";
      init.body = body;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const res = await this.fetchImpl(url.toString(), init);
    const text = await res.text().catch(() => "");
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw new PublishHttpError(res.status, method, url.toString(), text.slice(0, 500));
    if (text.trim().length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PublishResponseError(method, ["body is not JSON"]);
    }
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new PublishResponseError(
      what,
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  return parsed.data;
}
