import { CiResultSignal } from "@maestro/contracts";
import type { CiPort } from "@maestro/ports";
import { z } from "zod";
import { extractPullRequestId, extractTicketKey } from "./branch.js";
import type { AdoCiConfig, AdoPrValidationBuild } from "./config.js";
import { AdoConfigError, AdoResponseError, AdoWebhookAuthError } from "./errors.js";
import { parseOrThrow } from "./parse.js";
import { BuildCompleteResource, ServiceHookEnvelope } from "./schemas.js";
import { assertServiceHookAuth } from "./webhook.js";

/** The only Service Hook event type this driver acts on (M12). */
export const BUILD_COMPLETE_EVENT = "build.complete";

/** The only build reason a branch policy validation build carries. */
export const PULL_REQUEST_BUILD_REASON = "pullRequest";

/**
 * ADO build results → gate outcome. Anything that is not a clean success
 * counts as failed: `partiallySucceeded` means some test/step failed, and a
 * cancelled build proves nothing. Fail-closed at the CI gate (10b).
 */
const BUILD_RESULT: Record<string, CiResultSignal["status"]> = {
  succeeded: "succeeded",
  partiallySucceeded: "failed",
  failed: "failed",
  canceled: "failed",
  cancelled: "failed",
  none: "failed",
};

/**
 * What the driver knows about a build event: the port signal plus the
 * provenance the signal itself cannot carry (`CiResultSignal` is frozen and
 * has no project/repo/definition fields). The webhook endpoint keeps this
 * around for correlation and audit; only `signal` crosses the port.
 */
export interface AdoBuildEvent {
  signal: CiResultSignal;
  project: string;
  repository: string;
  definitionId: number;
}

/** Incoming request headers; values as a Node-style header bag. */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

/**
 * What `parseBuildEvent` accepts: the raw Service Hook body TOGETHER with the
 * headers of the request that carried it. The endpoint must build this from
 * the real HTTP request — never from fields inside the JSON body.
 */
export interface AdoWebhookRequest {
  headers: WebhookHeaders;
  body: unknown;
}

export interface AdoCiDriverOptions {
  ci: AdoCiConfig;
  /** Resolves `ci.webhookSecretRef` to the shared secret — SecretPort.get. */
  resolveWebhookSecret: () => string | Promise<string>;
}

/**
 * CiPort driver "ado" — PASSIVE (M12). Maestro never triggers a pipeline:
 * the ADO branch policy runs build validation on the PR and the
 * `build.complete` Service Hook is parsed here into the workflow signal.
 *
 * Nothing is parsed before the request authenticates. Service Hooks are not
 * signed, so the basic-auth shared secret is the whole authentication story;
 * an unauthenticated body is refused rather than read, because a forged
 * "succeeded" build would walk straight through the 10b gate.
 *
 * Once authenticated, the parser returns null (= "ignore this webhook") so
 * the endpoint can answer 200 without inventing a signal:
 *   1. the event is not `build.complete` (push, PR update, work item…);
 *   2. the build is not a branch-policy PR validation build — its `reason` is
 *      not `pullRequest`, or its project/repository/definition is not in the
 *      configured allow-list (a manually queued "always green" pipeline, or
 *      another project's build, must not answer for this PR);
 *   3. no pull request id, or no Jira ticket key in the source branch (M49
 *      `feature/<TICKET-KEY>-*`). Guessing a key would signal the wrong run.
 *
 * A `build.complete` payload that IS a Maestro build but whose fields do
 * not validate throws instead of returning null: silence there would hang
 * the 10b gate forever.
 */
export class AdoCiDriver implements CiPort {
  private readonly ci: AdoCiConfig;
  private readonly resolveWebhookSecret: () => string | Promise<string>;

  constructor(options: AdoCiDriverOptions) {
    this.ci = options.ci;
    this.resolveWebhookSecret = options.resolveWebhookSecret;
  }

  /**
   * CiPort entry point, sitting on top of {@link parseAuthenticatedBuildEvent}:
   * `rawBody` must be an {@link AdoWebhookRequest}. A bare Service Hook body
   * is rejected — there is no way to authenticate it, and "no header" must
   * never mean "no authentication required".
   */
  async parseBuildEvent(request: unknown): Promise<CiResultSignal | null> {
    const parsed = asWebhookRequest(request);
    if (parsed === null) throw new AdoWebhookAuthError("missing");
    const event = await this.parseAuthenticatedBuildEvent(parsed.headers, parsed.body);
    if (event === null) return null;
    // Carry provenance into the signal: ticketKey+prId alone do not identify a
    // build (a mirrored repo can reuse both). The workflow rejects a signal
    // whose origin does not match the run's ApplicationRecord.
    return { ...event.signal, adoProject: event.project, adoRepo: event.repository };
  }

  /**
   * Authenticates the Service Hook request, then parses it. Throws
   * `AdoWebhookAuthError` before touching the body when the shared secret
   * does not match, and `AdoConfigError` when no secret is configured.
   */
  async parseAuthenticatedBuildEvent(
    headers: WebhookHeaders,
    rawBody: unknown,
  ): Promise<AdoBuildEvent | null> {
    const password = await this.resolveWebhookSecret();
    assertServiceHookAuth(headerValue(headers, "authorization"), {
      username: this.ci.webhookUsername,
      password,
    });
    return parseBuildCompleteEvent(rawBody, this.ci.prValidationBuilds);
  }
}

/**
 * Synchronous core of {@link AdoCiDriver.parseAuthenticatedBuildEvent}.
 * Authentication is the caller's job here; `allowedBuilds` is not optional
 * on purpose — an empty allow-list is refused, never read as "allow all".
 */
export function parseBuildCompleteEvent(
  rawBody: unknown,
  allowedBuilds: readonly AdoPrValidationBuild[],
): AdoBuildEvent | null {
  if (allowedBuilds.length === 0) {
    throw new AdoConfigError(["no PR validation build definitions are allow-listed"]);
  }

  const envelope = ServiceHookEnvelope.safeParse(rawBody);
  if (!envelope.success) return null;
  if (envelope.data.eventType !== BUILD_COMPLETE_EVENT) return null;

  const resource = parseOrThrow(BuildCompleteResource, envelope.data.resource, "build.complete resource");

  // Provenance gate. A build only speaks for a pull request when the branch
  // policy queued it (`reason`) AND it is one of the definitions this
  // deployment trusts, in the right project and repository.
  if (resource.reason !== PULL_REQUEST_BUILD_REASON) return null;
  const project = resource.project?.name;
  const repository = resource.repository?.name;
  const definitionId = resource.definition?.id;
  if (project === undefined || repository === undefined || definitionId === undefined) return null;
  if (!isAllowedBuild(allowedBuilds, project, repository, definitionId)) return null;

  const trigger = resource.triggerInfo ?? {};

  // Refs a build event can carry, most specific first. On a PR validation
  // build `sourceBranch` is the merge ref (refs/pull/<id>/merge) and the
  // real branch lives in triggerInfo; resourceVersion 1.0 payloads (older
  // on-prem subscriptions) carry neither and only have sourceGetVersion.
  const refs = [
    trigger["pr.sourceBranch"],
    resource.sourceBranch,
    refFromSourceGetVersion(resource.sourceGetVersion),
  ].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);

  const prId =
    parsePositiveInt(trigger["pr.number"]) ??
    firstNonNull(refs, extractPullRequestId);
  if (prId === null) return null;

  const ticketKey = firstNonNull(refs, extractTicketKey);
  if (ticketKey === null) return null;

  const finishedAt = toIsoDateTime(
    resource.finishTime ?? resource.lastChangedDate ?? envelope.data.createdDate,
  );
  if (finishedAt === null) {
    throw new AdoResponseError("build.complete resource", [
      `no usable finish time for ${ticketKey} (build ${resource.id})`,
    ]);
  }

  const detailsUrl = z.url().safeParse(resource._links?.web?.href);

  const signal = parseOrThrow(CiResultSignal, {
    ticketKey,
    prId,
    buildId: resource.id,
    status: buildOutcome(resource.result, resource.status),
    ...(detailsUrl.success ? { detailsUrl: detailsUrl.data } : {}),
    finishedAt,
  }, "build.complete signal");

  return { signal, project, repository, definitionId };
}

/** Project and repository names are case-insensitive in ADO; ids are not. */
function isAllowedBuild(
  allowed: readonly AdoPrValidationBuild[],
  project: string,
  repository: string,
  definitionId: number,
): boolean {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  return allowed.some(
    (entry) =>
      entry.definitionId === definitionId &&
      same(entry.project, project) &&
      same(entry.repository, repository),
  );
}

/** Narrows an unknown payload to the headers+body envelope, or null. */
function asWebhookRequest(rawBody: unknown): AdoWebhookRequest | null {
  if (typeof rawBody !== "object" || rawBody === null) return null;
  const candidate = rawBody as { headers?: unknown; body?: unknown };
  if (typeof candidate.headers !== "object" || candidate.headers === null) return null;
  if (!("body" in candidate)) return null;
  return { headers: candidate.headers as WebhookHeaders, body: candidate.body };
}

/** First value of a header, matched case-insensitively. */
function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Outcome of the build across both payload generations: resourceVersion 2.0
 * puts the verdict in `result` (with `status: "completed"`), while the older
 * 1.0 shape puts it straight in `status`. Anything unrecognised is failed.
 */
function buildOutcome(result: string | undefined, status: string | undefined): CiResultSignal["status"] {
  const verdict = result ?? (status === "completed" ? undefined : status);
  return (verdict !== undefined ? BUILD_RESULT[verdict] : undefined) ?? "failed";
}

/** `sourceGetVersion` of a 1.0 payload: "LG:refs/heads/feature/X-1:<sha>". */
function refFromSourceGetVersion(value: string | undefined): string | undefined {
  return /^[A-Z]{2}:(refs\/[^:]+)/.exec(value ?? "")?.[1];
}

function firstNonNull<T>(values: readonly string[], extract: (value: string) => T | null): T | null {
  for (const value of values) {
    const extracted = extract(value);
    if (extracted !== null) return extracted;
  }
  return null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Normalises an ADO timestamp to the contract's ISO form. ADO emits
 * 7-digit fractional seconds, and on-prem instances occasionally omit the
 * zone — which is read as UTC here rather than as the parser's local time,
 * so the result does not depend on the server's clock settings.
 */
function toIsoDateTime(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim();
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const date = new Date(zoned);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
