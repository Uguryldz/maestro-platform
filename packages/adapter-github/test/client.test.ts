import { describe, expect, it } from "vitest";
import {
  GithubAuthError,
  GithubClient,
  GithubHttpError,
  GithubNotFoundError,
  GithubRateLimitError,
  GithubResponseError,
  GithubValidationError,
  parseGithubConfig,
} from "../src/index.js";
import { createFakeHttp, fixture, queryOf, respondWith } from "./helpers.js";

const cloud = parseGithubConfig({ tokenRef: "github/cloud/token" });
const ghes = parseGithubConfig({
  mode: "enterprise",
  apiBaseUrl: "https://ghe.ugurbank.local/api/v3",
  graphqlUrl: "https://ghe.ugurbank.local/api/graphql",
  tokenRef: "github/ghe/token",
});

function client(config: typeof cloud, http: { fetch: ReturnType<typeof respondWith>["fetch"] }) {
  return new GithubClient({ config, token: () => "token-secret", fetch: http.fetch });
}

describe("GithubClient URL building", () => {
  it("builds the cloud REST url and appends query params", async () => {
    const http = respondWith(fixture("repo-get"));
    await client(cloud, http).request({
      path: "repos/ugurbank/ugurpay/pulls/128/comments",
      query: { per_page: 100, unset: undefined },
    });
    const call = http.calls[0]!;
    expect(call.url).toContain(
      "https://api.github.com/repos/ugurbank/ugurpay/pulls/128/comments",
    );
    expect(queryOf(call, "per_page")).toBe("100");
    expect(call.url).not.toContain("unset");
  });

  it("builds the GHES REST url from the enterprise base", async () => {
    const http = respondWith(fixture("repo-get"));
    await client(ghes, http).request({ path: "repos/ugurbank/ugurpay" });
    expect(http.calls[0]!.url).toBe("https://ghe.ugurbank.local/api/v3/repos/ugurbank/ugurpay");
  });
});

describe("GithubClient authentication and headers", () => {
  it("sends a Bearer token and the pinned api-version header", async () => {
    const http = respondWith(fixture("repo-get"));
    await client(cloud, http).request({ path: "repos/x/y" });
    const headers = http.calls[0]!.headers;
    expect(headers["authorization"]).toBe("Bearer token-secret");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
    expect(headers["accept"]).toBe("application/vnd.github+json");
  });

  it("asks the token provider on every request (short-lived tokens)", async () => {
    let issued = 0;
    const http = respondWith(fixture("repo-get"));
    const gh = new GithubClient({
      config: cloud,
      token: () => Promise.resolve(`token-${++issued}`),
      fetch: http.fetch,
    });
    await gh.request({ path: "repos/x/y" });
    await gh.request({ path: "repos/x/y" });
    expect(issued).toBe(2);
  });
});

describe("GithubClient error classification", () => {
  it("maps 401 and a plain 403 to GithubAuthError", async () => {
    const unauthorized = createFakeHttp(() => ({ status: 401, text: "Bad credentials" }));
    await expect(client(cloud, unauthorized).request({ path: "repos/x/y" })).rejects.toBeInstanceOf(
      GithubAuthError,
    );
    const forbidden = createFakeHttp(() => ({ status: 403, text: "Resource not accessible" }));
    await expect(client(cloud, forbidden).request({ path: "repos/x/y" })).rejects.toBeInstanceOf(
      GithubAuthError,
    );
  });

  it("maps 404 to GithubNotFoundError and 422 to GithubValidationError", async () => {
    const missing = createFakeHttp(() => ({ status: 404, text: "Not Found" }));
    await expect(client(cloud, missing).request({ path: "repos/x/y" })).rejects.toBeInstanceOf(
      GithubNotFoundError,
    );
    const invalid = createFakeHttp(() => ({ status: 422, text: "Reference already exists" }));
    await expect(client(cloud, invalid).request({ path: "repos/x/y" })).rejects.toBeInstanceOf(
      GithubValidationError,
    );
  });

  it("maps 429 to a retryable GithubRateLimitError", async () => {
    const throttled = createFakeHttp(() => ({ status: 429, text: "Too Many Requests" }));
    try {
      await client(cloud, throttled).request({ path: "repos/x/y" });
      expect.unreachable("429 must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GithubRateLimitError);
      expect((error as GithubRateLimitError).retryable).toBe(true);
    }
  });

  it("treats a 403 with a rate-limit tell as a retryable throttle, not auth", async () => {
    const secondary = createFakeHttp(() => ({
      status: 403,
      text: "You have exceeded a secondary rate limit",
      headers: { "retry-after": "60" },
    }));
    const error = await client(cloud, secondary)
      .request({ path: "repos/x/y" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubRateLimitError);
    expect(error).not.toBeInstanceOf(GithubAuthError);

    const exhausted = createFakeHttp(() => ({
      status: 403,
      text: "API rate limit exceeded",
      headers: { "x-ratelimit-remaining": "0" },
    }));
    await expect(exhausted.fetch("x").then(() => undefined)).resolves.toBeUndefined();
    await expect(
      client(cloud, exhausted).request({ path: "repos/x/y" }),
    ).rejects.toBeInstanceOf(GithubRateLimitError);
  });

  it("marks a 5xx retryable and a plain 4xx not", async () => {
    const server = createFakeHttp(() => ({ status: 502, text: "Bad Gateway" }));
    const e5 = (await client(cloud, server)
      .request({ path: "repos/x/y" })
      .catch((e: unknown) => e)) as GithubHttpError;
    expect(e5).toBeInstanceOf(GithubHttpError);
    expect(e5.retryable).toBe(true);

    const client400 = createFakeHttp(() => ({ status: 400, text: "Bad Request" }));
    const e4 = (await client(cloud, client400)
      .request({ path: "repos/x/y" })
      .catch((e: unknown) => e)) as GithubHttpError;
    expect(e4.retryable).toBe(false);
  });

  it("truncates a long error body", async () => {
    const failing = createFakeHttp(() => ({ status: 500, text: "x".repeat(900) }));
    const error = (await client(cloud, failing)
      .request({ path: "repos/x/y", method: "POST", body: {} })
      .catch((e: unknown) => e)) as GithubHttpError;
    expect(error.bodySnippet.length).toBeLessThanOrEqual(501);
    expect(error.method).toBe("POST");
  });

  it("returns null for 204 and an empty 200 body", async () => {
    const noContent = createFakeHttp(() => ({ status: 204 }));
    await expect(
      client(cloud, noContent).request({ path: "repos/x/y", method: "DELETE" }),
    ).resolves.toBeNull();
    const empty = createFakeHttp(() => ({ status: 200, text: "" }));
    await expect(client(cloud, empty).request({ path: "repos/x/y" })).resolves.toBeNull();
  });
});

describe("GithubClient GraphQL", () => {
  it("posts query + variables to the graphql endpoint and returns data", async () => {
    const http = createFakeHttp(() => ({ json: fixture("graphql-mark-ready") }));
    const data = (await client(cloud, http).graphql("mutation($id: ID!) { x }", {
      id: "PR_node",
    })) as { markPullRequestReadyForReview: unknown };
    expect(http.calls[0]!.url).toBe("https://api.github.com/graphql");
    expect(http.calls[0]!.method).toBe("POST");
    expect(http.calls[0]!.body).toEqual({
      query: "mutation($id: ID!) { x }",
      variables: { id: "PR_node" },
    });
    expect(data.markPullRequestReadyForReview).toBeTruthy();
  });

  it("turns a 200 GraphQL errors array into a GithubResponseError", async () => {
    const http = createFakeHttp(() => ({
      json: { data: null, errors: [{ message: "Could not resolve to a node." }] },
    }));
    await expect(client(cloud, http).graphql("q", {})).rejects.toBeInstanceOf(GithubResponseError);
    await expect(client(cloud, http).graphql("q", {})).rejects.toThrow(/Could not resolve/);
  });
});
