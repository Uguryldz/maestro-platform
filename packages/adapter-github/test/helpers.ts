import { fileURLToPath } from "node:url";
import type { ApplicationRecord } from "@maestro/contracts";
import type { RepoRef } from "@maestro/ports";
import { loadFixture } from "@maestro/test-kit";
import { z } from "zod";
import {
  GithubClient,
  GithubScmDriver,
  type FetchLike,
  parseGithubConfig,
  type SecretIssuer,
} from "../src/index.js";

const FIXTURE_DIR = fileURLToPath(new URL("fixtures", import.meta.url));

/**
 * Loads a recorded-style GitHub response. These are SHAPE fixtures: they are
 * hand-authored from the documented GitHub REST v3 / GraphQL response shapes,
 * not live recordings. The orchestrator re-records them against the user's
 * real repo before the driver goes live (insa-plani §6; see RAPOR.md).
 */
export function fixture(name: string): unknown {
  return loadFixture(FIXTURE_DIR, name, z.unknown());
}

export const CLOUD_CONFIG = parseGithubConfig({
  tokenRef: "github/cloud/token",
});

export const REPO: RepoRef = { project: "ugurbank", repo: "ugurpay" };

export const APP: ApplicationRecord = {
  appId: "ugurpay",
  displayName: "UgurPay",
  // ApplicationRecord field names predate GitHub; here they carry owner/repo.
  adoProject: "ugurbank",
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
    secret: "ghs-ephemeral-installation-token",
    expiresAt: new Date(NOW_MS + ttlSeconds * 1000).toISOString(),
  });

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
  /** Extra response headers (used to test the 403 rate-limit split). */
  headers?: Record<string, string>;
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
      new Response(body, {
        status,
        headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
      }),
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

/** True when a recorded call targets the GraphQL endpoint. */
export function isGraphql(call: FakeCall): boolean {
  return new URL(call.url).pathname.endsWith("/graphql");
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

export interface ScmHarnessOptions {
  issueSecret?: SecretIssuer;
  maxPushTtlSeconds?: number;
  now?: () => number;
  client?: GithubClient;
}

/** Driver wired to a fake transport, a frozen clock and the fixture issuer. */
export function scmDriver(
  handler: (call: FakeCall) => FakeReply,
  options: ScmHarnessOptions = {},
): { scm: GithubScmDriver; calls: FakeCall[] } {
  const http = createFakeHttp(handler);
  const client =
    options.client ??
    new GithubClient({ config: CLOUD_CONFIG, token: () => "token", fetch: http.fetch });
  const scm = new GithubScmDriver({
    client,
    issueSecret: options.issueSecret ?? issuer,
    maxPushTtlSeconds: options.maxPushTtlSeconds,
    now: options.now ?? (() => NOW_MS),
  });
  return { scm, calls: http.calls };
}
