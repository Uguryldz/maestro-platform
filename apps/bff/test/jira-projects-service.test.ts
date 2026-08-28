import { describe, expect, it } from "vitest";
import { listJiraProjects } from "../src/jira-projects-service.js";
import type { ConnectionRecord } from "../src/connection-store.js";
import type { ConnectorFetch } from "../src/connection-service.js";

/**
 * Listing a Jira connection's projects for onboarding (Faz E).
 *
 * The sibling of `scm-repos-service.test.ts`: the URL is built from the STORED
 * baseUrl, the STORED token is presented with the right scheme (Cloud Basic with
 * the stored email, DC bearer), Cloud (`{values}`) and DC (bare array) bodies
 * normalize to {key, name}, and every failure is a secret-free key — the token
 * never appears in a result.
 */

const TOKEN = "jira_secrettoken_xyz789";

function conn(over: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: "jira",
    kind: "jira_cloud",
    displayName: "Jira Cloud",
    baseUrl: "https://ugurbank.atlassian.net",
    authKind: "basic",
    config: { email: "bot@ugurbank.local" },
    secretRef: "connector:jira:1",
    secretMask: "z789",
    enabled: true,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    lastTestedAt: null,
    lastTestOk: null,
    lastTestNote: null,
    onPrem: false,
    isDefault: false,
    ...over,
  };
}

function stub(
  status: number,
  body: unknown,
): { fetch: ConnectorFetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: ConnectorFetch = (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetch, calls };
}

describe("listJiraProjects", () => {
  it("normalizes a Cloud /project/search body to {key, name}", async () => {
    const { fetch, calls } = stub(200, {
      values: [
        { key: "UGURPAY", name: "Ugur Payments" },
        { key: "UGURWEB", name: "Ugur Web" },
      ],
    });
    const result = await listJiraProjects(conn(), TOKEN, fetch);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projects).toEqual([
        { key: "UGURPAY", name: "Ugur Payments" },
        { key: "UGURWEB", name: "Ugur Web" },
      ]);
    }
    // URL from the STORED baseUrl; Cloud uses Basic with the stored email.
    expect(calls[0]?.url).toBe(
      "https://ugurbank.atlassian.net/rest/api/3/project/search?maxResults=100&orderBy=key",
    );
    const auth = (calls[0]?.init?.headers as Record<string, string>).authorization ?? "";
    expect(auth).toMatch(/^Basic /);
    // The email is part of the Basic pair; the token is not in the URL.
    const decoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString();
    expect(decoded).toBe(`bot@ugurbank.local:${TOKEN}`);
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it("normalizes a Data Center /project bare array with a bearer token", async () => {
    const { fetch, calls } = stub(200, [
      { key: "CORE", name: "Core Banking" },
      { key: "OPS" }, // name absent → falls back to the key
    ]);
    const result = await listJiraProjects(conn({ kind: "jira_dc" }), TOKEN, fetch);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projects).toEqual([
        { key: "CORE", name: "Core Banking" },
        { key: "OPS", name: "OPS" },
      ]);
    }
    expect(calls[0]?.url).toBe("https://ugurbank.atlassian.net/rest/api/2/project");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses a kind that cannot list projects, without calling the network", async () => {
    const { fetch, calls } = stub(200, []);
    const result = await listJiraProjects(conn({ kind: "github" }), TOKEN, fetch);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("reports no-token as a secret-free failure", async () => {
    const { fetch } = stub(200, {});
    const result = await listJiraProjects(conn(), null, fetch);
    expect(result).toMatchObject({ ok: false, messageKey: "onboard.jira.no_token" });
  });

  it("maps a 401 to a secret-free http_error and never leaks the token", async () => {
    const { fetch } = stub(401, { message: "Unauthorized" });
    const result = await listJiraProjects(conn(), TOKEN, fetch);
    expect(result).toMatchObject({ ok: false, messageKey: "onboard.jira.http_error" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reports a thrown fetch as unreachable, not a stack trace", async () => {
    const fetch: ConnectorFetch = () => Promise.reject(new Error(`connect failed to ${TOKEN}`));
    const result = await listJiraProjects(conn(), TOKEN, fetch);
    expect(result).toMatchObject({ ok: false, messageKey: "onboard.jira.unreachable" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
