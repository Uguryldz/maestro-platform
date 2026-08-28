import { describe, expect, it } from "vitest";
import {
  isRetryableJiraError,
  JiraAuthError,
  JiraCloudClient,
  JiraConfigError,
  JiraForbiddenError,
  JiraHttpError,
  JiraNotFoundError,
  JiraRateLimitError,
  JiraRetryableError,
} from "../../src/index.js";
import { stubFetch, type FetchStub } from "../helpers.js";

function client(stub: FetchStub, token = "api-token-123"): JiraCloudClient {
  return new JiraCloudClient({
    baseUrl: "https://uyildiz.atlassian.net/",
    email: "pilot@bank.example",
    token: () => token,
    fetchImpl: stub.fetchImpl,
  });
}

describe("JiraCloudClient", () => {
  it("sends HTTP Basic auth built from email and API token", async () => {
    const stub = stubFetch([{ body: { ok: true } }]);
    await client(stub).get("/rest/api/3/myself");

    const expected = Buffer.from("pilot@bank.example:api-token-123", "utf8").toString("base64");
    expect(stub.calls[0]!.headers["authorization"]).toBe(`Basic ${expected}`);
    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/myself");
  });

  it("refuses to send with an empty resolved token — no anonymous downgrade", async () => {
    const stub = stubFetch([]);
    await expect(client(stub, "  ").get("/rest/api/3/myself")).rejects.toBeInstanceOf(JiraConfigError);
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses to construct with an empty email or baseUrl", () => {
    const stub = stubFetch([]);
    expect(
      () => new JiraCloudClient({ baseUrl: " ", email: "a@b.c", token: () => "t", fetchImpl: stub.fetchImpl }),
    ).toThrowError(JiraConfigError);
    expect(
      () => new JiraCloudClient({ baseUrl: "https://x.atlassian.net", email: " ", token: () => "t", fetchImpl: stub.fetchImpl }),
    ).toThrowError(JiraConfigError);
  });

  it("returns undefined for 204 and empty bodies", async () => {
    const stub = stubFetch([{ status: 204 }]);
    await expect(client(stub).put("/rest/api/3/issue/OPS-6", {})).resolves.toBeUndefined();
  });

  it("maps 401/403/404 to their typed, final errors", async () => {
    const stub = stubFetch([{ status: 401, body: {} }, { status: 403, body: {} }, { status: 404, body: {} }]);
    const c = client(stub);
    await expect(c.get("/x")).rejects.toBeInstanceOf(JiraAuthError);
    await expect(c.get("/x")).rejects.toBeInstanceOf(JiraForbiddenError);
    await expect(c.get("/x")).rejects.toBeInstanceOf(JiraNotFoundError);
  });

  it("classifies 429 as retryable WITHOUT retrying in-process", async () => {
    const stub = stubFetch([{ status: 429, body: {}, headers: { "retry-after": "2" } }]);
    const error = await client(stub).get("/x").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JiraRateLimitError);
    expect((error as JiraRateLimitError).retryAfterMs).toBe(2000);
    expect(stub.calls).toHaveLength(1); // exactly one request — Temporal retries, not us
    expect(isRetryableJiraError(error)).toBe(true);
  });

  it("classifies 5xx as JiraRetryableError, other 4xx as final", async () => {
    const stub = stubFetch([{ status: 500, body: {} }, { status: 503, body: {} }, { status: 400, body: {} }]);
    const c = client(stub);

    const serverError = await c.get("/x").catch((e: unknown) => e);
    expect(serverError).toBeInstanceOf(JiraRetryableError);
    expect((serverError as JiraRetryableError).status).toBe(500);
    expect(isRetryableJiraError(serverError)).toBe(true);

    await expect(c.get("/x")).rejects.toBeInstanceOf(JiraRetryableError);

    const badRequest = await c.get("/x").catch((e: unknown) => e);
    expect(badRequest).toBeInstanceOf(JiraHttpError);
    expect(badRequest).not.toBeInstanceOf(JiraRetryableError);
    expect(isRetryableJiraError(badRequest)).toBe(false);
  });
});
