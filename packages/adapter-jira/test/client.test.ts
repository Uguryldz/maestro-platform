import { describe, expect, it } from "vitest";
import {
  JiraAuthError,
  JiraConfigError,
  JiraDcClient,
  JiraForbiddenError,
  JiraHttpError,
  JiraNotFoundError,
  JiraRateLimitError,
} from "../src/index.js";
import { stubFetch } from "./helpers.js";

function client(stub: ReturnType<typeof stubFetch>, baseUrl = "https://jira.internal.bank/") {
  return new JiraDcClient({
    baseUrl,
    token: () => Promise.resolve("pat-123"),
    fetchImpl: stub.fetchImpl,
    sleep: stub.sleep,
  });
}

describe("JiraDcClient", () => {
  it("sends PAT bearer auth and builds the URL from the base", async () => {
    const stub = stubFetch([{ body: { key: "UGURPAY-501" } }]);
    const res = await client(stub).get<{ key: string }>("/rest/api/2/issue/UGURPAY-501", { fields: "summary" });

    expect(res.key).toBe("UGURPAY-501");
    const call = stub.calls[0]!;
    expect(call.url).toBe("https://jira.internal.bank/rest/api/2/issue/UGURPAY-501?fields=summary");
    expect(call.headers["authorization"]).toBe("Bearer pat-123");
    expect(call.headers["accept"]).toBe("application/json");
    expect(call.headers["content-type"]).toBeUndefined();
  });

  it("serialises JSON bodies and sets the content type", async () => {
    const stub = stubFetch([{ body: { id: "1" } }]);
    await client(stub).post("/rest/api/2/issue/UGURPAY-501/comment", { body: "hello" });

    const call = stub.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({ body: "hello" });
  });

  it("treats 204 and empty bodies as void", async () => {
    const stub = stubFetch([{ status: 204 }, { status: 200 }]);
    const jira = client(stub);
    await expect(jira.put("/rest/api/2/issue/UGURPAY-501", { fields: {} })).resolves.toBeUndefined();
    await expect(jira.get("/rest/api/2/issue/UGURPAY-501")).resolves.toBeUndefined();
  });

  it("maps 401/403/404 to typed errors", async () => {
    const cases = [
      { status: 401, error: JiraAuthError },
      { status: 403, error: JiraForbiddenError },
      { status: 404, error: JiraNotFoundError },
    ] as const;

    for (const { status, error } of cases) {
      const stub = stubFetch([{ status, body: { errorMessages: ["nope"] } }]);
      await expect(client(stub).get("/rest/api/2/issue/UGURPAY-1")).rejects.toBeInstanceOf(error);
    }
  });

  it("keeps status and a body snippet on unmapped failures", async () => {
    const stub = stubFetch([{ status: 500, body: { errorMessages: ["boom"] } }]);
    await expect(client(stub).get("/rest/api/2/issue/UGURPAY-1")).rejects.toMatchObject({
      name: "JiraHttpError",
      status: 500,
      responseBody: expect.stringContaining("boom") as unknown as string,
    });
  });

  it("backs off exactly once on 429 and then succeeds", async () => {
    const stub = stubFetch([
      { status: 429, headers: { "retry-after": "2" }, body: { message: "slow down" } },
      { body: { ok: true } },
    ]);
    const res = await client(stub).get<{ ok: boolean }>("/rest/api/2/myself");

    expect(res.ok).toBe(true);
    expect(stub.calls).toHaveLength(2);
    expect(stub.sleeps).toEqual([2000]);
  });

  it("gives up after the second 429", async () => {
    const stub = stubFetch([
      { status: 429, headers: { "retry-after": "1" }, body: {} },
      { status: 429, headers: { "retry-after": "1" }, body: {} },
    ]);
    const error = await client(stub)
      .get("/rest/api/2/myself")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JiraRateLimitError);
    expect((error as JiraRateLimitError).retryAfterMs).toBe(1000);
    expect(stub.calls).toHaveLength(2);
  });

  it("does not retry a throttled POST — a duplicate comment is worse than a failure", async () => {
    const stub = stubFetch([{ status: 429, headers: { "retry-after": "1" }, body: {} }]);
    await expect(client(stub).post("/rest/api/2/issue/UGURPAY-1/comment", { body: "x" })).rejects.toBeInstanceOf(
      JiraRateLimitError,
    );

    expect(stub.calls).toHaveLength(1);
    expect(stub.sleeps).toEqual([]);
  });

  it("caps the honoured Retry-After", async () => {
    const stub = stubFetch([{ status: 429, headers: { "retry-after": "3600" }, body: {} }, { body: {} }]);
    await new JiraDcClient({
      baseUrl: "https://jira.internal.bank",
      token: () => "pat",
      fetchImpl: stub.fetchImpl,
      sleep: stub.sleep,
      maxBackoffMs: 5_000,
    }).get("/rest/api/2/myself");

    expect(stub.sleeps).toEqual([5000]);
  });

  it("refuses an empty base URL", () => {
    expect(() => new JiraDcClient({ baseUrl: "   ", token: () => "pat", fetchImpl: stubFetch([]).fetchImpl })).toThrow(
      JiraConfigError,
    );
  });

  // O-5: `Bearer ` with an empty token is accepted by Jira as an anonymous
  // request, which silently downgrades the identity instead of failing.
  it("refuses to send a request when the PAT resolves to nothing", async () => {
    for (const token of ["", "   ", undefined as unknown as string]) {
      const stub = stubFetch([{ body: {} }]);
      const jira = new JiraDcClient({
        baseUrl: "https://jira.internal.bank",
        token: () => token,
        fetchImpl: stub.fetchImpl,
      });

      await expect(jira.get("/rest/api/2/myself")).rejects.toBeInstanceOf(JiraConfigError);
      expect(stub.calls).toHaveLength(0);
    }
  });

  it("exports JiraHttpError as the shared base class", () => {
    expect(new JiraAuthError("GET", "u", "")).toBeInstanceOf(JiraHttpError);
  });
});
