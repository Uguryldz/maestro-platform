import type { ScanFinding, ScanResult, ScanSeverity, ScanTool } from "@maestro/contracts";
import type { ScanPort, ScanTarget } from "@maestro/ports";
import type { z } from "zod";
import { reasonOf } from "../container-driver.js";
import { ScanConfigError } from "../errors.js";
import type { ParsedScan } from "../parse/common.js";
import { completedResult, errorResult } from "../result.js";
import { systemClock, type Clock } from "../runner.js";
import { decideOutcome } from "../severity.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Where the next page starts; `index` is 0-based. */
export interface PageCursor {
  index: number;
  /** Items already collected — the `start`/offset most APIs want. */ offset: number;
}

export interface HttpScanSpec {
  tool: ScanTool;
  /** Fills `ScanResult.imageDigest`, which a driver without an image cannot — see RAPOR.md. */
  provenance: string;
  blockLevel: ScanSeverity;
  timeoutMs: number;
  /** Items requested per page — used to detect "the page was full, so there may be more". */
  pageSize: number;
  url(target: ScanTarget, page: PageCursor): string;
  headers(): Record<string, string>;
  parse(body: string): ParsedScan;
}

/** Ceiling on paging, so a lying `total` cannot loop forever. */
const MAX_PAGES = 50;

export interface HttpScanPortOptions {
  spec: HttpScanSpec;
  fetchImpl?: FetchLike;
  clock?: Clock;
}

/**
 * Shared body of the optional org drivers (M77): pull a report over HTTP, map it,
 * apply the threshold. Fail-closed like the container drivers — `run()` never
 * throws and any transport, status or shape problem is `error`.
 */
export class HttpScanPort implements ScanPort {
  readonly #spec: HttpScanSpec;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;

  constructor(options: HttpScanPortOptions) {
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) throw new ScanConfigError(`${options.spec.tool}: no fetch implementation available`);
    this.#spec = options.spec;
    this.#fetch = fetchImpl;
    this.#clock = options.clock ?? systemClock;
  }

  get tool(): ScanTool {
    return this.#spec.tool;
  }

  /** Guarantees the "never throws" invariant even if a collaborator (clock) does. */
  async run(tool: ScanTool, target: ScanTarget): Promise<ScanResult> {
    try {
      return await this.#run(tool, target);
    } catch (error) {
      const epoch = new Date(0);
      return errorResult({
        tool: this.#spec.tool, imageDigest: this.#spec.provenance, startedAt: epoch, finishedAt: epoch,
        reason: `scan driver failed outside the scan — ${reasonOf(error)}`,
      });
    }
  }

  async #run(tool: ScanTool, target: ScanTarget): Promise<ScanResult> {
    const startedAt = this.#clock();
    const base = { tool: this.#spec.tool, imageDigest: this.#spec.provenance, startedAt };
    const failed = (reason: string): ScanResult =>
      errorResult({ ...base, finishedAt: this.#clock(), reason });

    if (tool !== this.#spec.tool) {
      return failed(`driver is wired for "${this.#spec.tool}" but was asked to run "${tool}"`);
    }

    const findings: ScanFinding[] = [];
    let fetched = 0;
    let total: number | undefined;

    for (let index = 0; index < MAX_PAGES; index += 1) {
      let page: ParsedScan;
      try {
        page = await this.#page(target, { index, offset: fetched });
      } catch (error) {
        return failed(reasonOf(error));
      }
      if (page.fatal) return failed(page.fatal);

      findings.push(...page.findings);
      const items = page.pageItems ?? page.findings.length;
      fetched += items;
      total = page.total ?? total;

      // Done when the server accounted for everything, or when a short page
      // proves there is no more. A full page with no total is NOT proof.
      if (total !== undefined && fetched >= total) break;
      if (total === undefined && items < this.#spec.pageSize) break;
      if (items === 0) {
        return failed(`report paging stalled after ${fetched} of ${total ?? "an unknown number of"} item(s)`);
      }
      if (index === MAX_PAGES - 1) {
        return failed(`report has more than ${MAX_PAGES} pages — refusing to decide on a partial report`);
      }
    }

    return completedResult({
      ...base,
      finishedAt: this.#clock(),
      findings,
      outcome: decideOutcome(findings, this.#spec.blockLevel),
    });
  }

  async #page(target: ScanTarget, cursor: PageCursor): Promise<ParsedScan> {
    let body: string;
    try {
      const response = await this.#fetch(this.#spec.url(target, cursor), {
        method: "GET",
        headers: this.#spec.headers(),
        signal: AbortSignal.timeout(this.#spec.timeoutMs),
      });
      if (!response.ok) return { findings: [], fatal: `report request failed with HTTP ${response.status}` };
      body = await response.text();
    } catch (error) {
      return { findings: [], fatal: `report request failed — ${reasonOf(error)}` };
    }
    return this.#spec.parse(body);
  }
}

/** Shared by every factory: invalid configuration is refused, never defaulted. */
export function parseConfig<T>(tool: string, schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  throw new ScanConfigError(`${tool}: ${issues}`);
}

/** Optional drivers carry a bearer-style credential; plain http would leak it. */
export function requireHttps(tool: string, baseUrl: string): string {
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new ScanConfigError(`${tool}: baseUrl "${baseUrl}" is not https — the API credential travels on this connection`);
  }
  return baseUrl.replace(/\/+$/, "");
}

/** No configuration at all means "this bank does not use the tool" (M77). */
export function isUnconfigured(input: unknown): boolean {
  return input === undefined || input === null || typeof input !== "object" || Object.keys(input).length === 0;
}

/** The only collaborators a declarative config may carry — they are objects, not secrets. */
const ALLOWED_DEPS = ["runner", "fetchImpl", "clock"] as const;
/** Credential-shaped keys. Declarative config is versioned in the DB and visible in Studio (M71). */
const CREDENTIAL_DEPS = ["token", "tokens", "password", "secret", "apiKey", "authorization"];

/**
 * Runtime collaborators lifted out of a config object (M44). Anything that
 * looks like a credential is REFUSED rather than ignored: a token that reaches
 * here has already been written into a versioned, auditable, Studio-visible
 * config row, and silently dropping it would leave it sitting there.
 */
export function depsOf<T>(input: unknown): T | undefined {
  const deps = (input as { deps?: unknown } | null | undefined)?.deps;
  if (typeof deps !== "object" || deps === null) return undefined;

  const record = deps as Record<string, unknown>;
  const credential = CREDENTIAL_DEPS.find((key) => record[key] !== undefined);
  if (credential) {
    throw new ScanConfigError(
      `deps.${credential} may not come from declarative configuration — credentials are runtime material (SecretPort, M80)`,
    );
  }
  const picked: Record<string, unknown> = {};
  for (const key of ALLOWED_DEPS) {
    if (record[key] !== undefined) picked[key] = record[key];
  }
  return picked as T;
}
