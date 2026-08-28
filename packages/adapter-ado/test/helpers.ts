import { fileURLToPath } from "node:url";
import type { ApplicationRecord } from "@maestro/contracts";
import type { RepoRef } from "@maestro/ports";
import { loadFixture } from "@maestro/test-kit";
import { z } from "zod";
import {
  AdoClient,
  AdoScmDriver,
  type FetchLike,
  parseAdoConfig,
  type SecretIssuer,
} from "../src/index.js";

const FIXTURE_DIR = fileURLToPath(new URL("fixtures", import.meta.url));

/**
 * Loads a recorded-style ADO response/event. Shapes follow the documented
 * Azure DevOps REST + Service Hooks payloads for Server 2022 and Services;
 * they are the offline stand-in until corporate access allows live smoke
 * tests (insa-plani §6).
 */
export function fixture(name: string): unknown {
  return loadFixture(FIXTURE_DIR, name, z.unknown());
}

/**
 * PR validation definitions that match the `build.complete` fixtures:
 * UgurPay/ugurpay#12 (Services) and UgurWeb/ugurweb#33 (Server). Anything
 * outside this list is a build the 10b gate must not accept.
 */
export const PR_VALIDATION_BUILDS = [
  { project: "UgurPay", repository: "ugurpay", definitionId: 12 },
  { project: "UgurWeb", repository: "ugurweb", definitionId: 33 },
];

/** Service Hook shared secret used across the offline tests. */
export const WEBHOOK_SECRET = "s3cr3t-shared-value";
export const WEBHOOK_USERNAME = "maestro-hook";

/** CI ingest block every driver config in the tests carries. */
export const CI_CONFIG = {
  webhookSecretRef: "ado/webhook/secret",
  webhookUsername: WEBHOOK_USERNAME,
  prValidationBuilds: PR_VALIDATION_BUILDS,
};

/** Request headers carrying a Service Hook basic-auth credential. */
export function authHeaders(
  password: string = WEBHOOK_SECRET,
  username: string = WEBHOOK_USERNAME,
): Record<string, string> {
  return {
    "content-type": "application/json",
    Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
  };
}

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON request body, or undefined for bodyless requests. */
  body: unknown;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
}

/** Deterministic offline transport: records every call, replies per handler. */
export function createFakeHttp(handler: (call: FakeCall) => FakeReply): {
  fetch: FetchLike;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = (input, init) => {
    const rawBody = init?.body;
    const call: FakeCall = {
      url: input,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : undefined,
    };
    calls.push(call);

    const reply = handler(call);
    const status = reply.status ?? 200;
    const body =
      status === 204
        ? null
        : (reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json)));
    return Promise.resolve(
      new Response(body, { status, headers: { "content-type": "application/json" } }),
    );
  };
  return { fetch, calls };
}

/** Replies with one fixture for every request — the common single-call case. */
export function respondWith(value: unknown, status = 200): {
  fetch: FetchLike;
  calls: FakeCall[];
} {
  return createFakeHttp(() => ({ status, json: value }));
}

/** Query string value of a recorded call, or null. */
export function queryOf(call: FakeCall, key: string): string | null {
  return new URL(call.url).searchParams.get(key);
}

/** Path (no query) of a recorded call. */
export function pathOf(call: FakeCall): string {
  const url = new URL(call.url);
  return `${url.origin}${url.pathname}`;
}

/* ------------------------------------------------------------------ *
 * ScmPort test harness — one driver factory for every scm test file. *
 * ------------------------------------------------------------------ */

export const SERVICES_CONFIG = parseAdoConfig({
  mode: "services",
  org: "ugurbank",
  tokenRef: "ado/services/pat",
  ci: CI_CONFIG,
});

export const REPO: RepoRef = { project: "UgurPay", repo: "ugurpay" };

export const APP: ApplicationRecord = {
  appId: "ugurpay",
  displayName: "UgurPay",
  adoProject: "UgurPay",
  adoRepo: "ugurpay",
  platform: "linux-node",
  jiraComponent: null,
  maestroYamlPresent: true,
  createdVia: "onboarding",
};

/** Frozen clock: the driver's expiry checks must not depend on the wall clock. */
export const NOW_MS = Date.UTC(2026, 7, 8, 12, 0, 0);

/** Well-behaved issuer: mints a credential that expires exactly at now + ttl. */
export const issuer: SecretIssuer = (_scope, ttlSeconds) =>
  Promise.resolve({
    secret: "ephemeral-pat",
    expiresAt: new Date(NOW_MS + ttlSeconds * 1000).toISOString(),
  });

export interface ScmHarnessOptions {
  issueSecret?: SecretIssuer;
  maxPushTtlSeconds?: number;
  now?: () => number;
  client?: AdoClient;
}

/** Driver wired to a fake transport, a frozen clock and the fixture issuer. */
export function scmDriver(
  handler: (call: FakeCall) => FakeReply,
  options: ScmHarnessOptions = {},
): { scm: AdoScmDriver; calls: FakeCall[] } {
  const http = createFakeHttp(handler);
  const client =
    options.client ??
    new AdoClient({ config: SERVICES_CONFIG, token: () => "pat", fetch: http.fetch });
  const scm = new AdoScmDriver({
    client,
    issueSecret: options.issueSecret ?? issuer,
    maxPushTtlSeconds: options.maxPushTtlSeconds,
    now: options.now ?? (() => NOW_MS),
  });
  return { scm, calls: http.calls };
}
