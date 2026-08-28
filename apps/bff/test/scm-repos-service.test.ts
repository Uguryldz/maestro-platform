import { describe, expect, it } from "vitest";
import { listScmRepos } from "../src/scm-repos-service.js";
import type { ConnectionRecord } from "../src/connection-store.js";
import type { ConnectorFetch } from "../src/connection-service.js";

/**
 * Listing an SCM connection's repositories for onboarding.
 *
 * The properties under test are the ones a leak or an SSRF would breach: the URL
 * is built from the STORED baseUrl (never the caller), the STORED token is
 * presented with the right scheme, GitHub and ADO bodies normalize to
 * {id, fullName}, and every failure is a secret-free key — the token never
 * appears in a result.
 */

const TOKEN = "ghp_secrettoken_abc123";

function conn(over: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: "github",
    kind: "github",
    displayName: "GitHub",
    baseUrl: "https://api.github.com",
    authKind: "bearer",
    config: {},
    secretRef: "connector:github:1",
    secretMask: "c123",
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

/** A fetch stub that records the request and returns the given body. */
function stub(status: number, body: unknown): { fetch: ConnectorFetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: ConnectorFetch = (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetch, calls };
}

describe("listScmRepos", () => {
  it("normalizes a GitHub /user/repos body to {id, fullName}", async () => {
    const { fetch, calls } = stub(200, [
      { id: 1, full_name: "Uguryldz/maestro-pilot" },
      { id: 2, full_name: "Uguryldz/wendococr" },
    ]);
    const result = await listScmRepos(conn(), TOKEN, fetch);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repos).toEqual([
        { id: "1", fullName: "Uguryldz/maestro-pilot" },
        { id: "2", fullName: "Uguryldz/wendococr" },
      ]);
    }
    // URL from the STORED baseUrl; token under Bearer; never in the URL.
    expect(calls[0]?.url).toBe(
      "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
    );
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it("normalizes an ADO repositories body to project/repo", async () => {
    const { fetch, calls } = stub(200, {
      value: [
        { id: "guid-1", name: "ugurpay", project: { name: "UgurPay" } },
        { id: "guid-2", name: "ugurweb", project: { name: "UgurWeb" } },
      ],
    });
    const result = await listScmRepos(
      conn({ id: "ado", kind: "ado", baseUrl: "https://dev.azure.com/ugurbank" }),
      TOKEN,
      fetch,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repos.map((r) => r.fullName)).toEqual(["UgurPay/ugurpay", "UgurWeb/ugurweb"]);
    }
    // ADO uses Basic with an empty username.
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toMatch(/^Basic /);
  });

  it("refuses a kind that cannot list, without calling the network", async () => {
    const { fetch, calls } = stub(200, []);
    const result = await listScmRepos(conn({ kind: "jira_cloud" }), TOKEN, fetch);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("reports no-token as a secret-free failure", async () => {
    const { fetch } = stub(200, []);
    const result = await listScmRepos(conn(), null, fetch);
    expect(result).toMatchObject({ ok: false, messageKey: "onboard.scm.no_token" });
  });

  it("maps a 401 to a secret-free http_error and never leaks the token", async () => {
    const { fetch } = stub(401, { message: "Bad credentials" });
    const result = await listScmRepos(conn(), TOKEN, fetch);
    expect(result).toMatchObject({ ok: false, messageKey: "onboard.scm.http_error" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reports a thrown fetch as unreachable, not a stack trace", async () => {
    const fetch: ConnectorFetch = () => Promise.reject(new Error(`connect failed to ${TOKEN}`));
    const result = await listScmRepos(conn(), TOKEN, fetch);
    expect(result).toMatchObject({ ok: false, messageKey: "onboard.scm.unreachable" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
