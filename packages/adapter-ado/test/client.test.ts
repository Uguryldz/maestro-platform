import { describe, expect, it } from "vitest";
import {
  AdoAuthError,
  AdoClient,
  AdoHttpError,
  AdoNotFoundError,
  parseAdoConfig,
} from "../src/index.js";
import { CI_CONFIG, createFakeHttp, fixture, queryOf, respondWith } from "./helpers.js";

const serverConfig = parseAdoConfig({
  mode: "server",
  baseUrl: "https://tfs.ugurbank.local/tfs",
  collection: "DefaultCollection",
  tokenRef: "ado/server/pat",
  ci: CI_CONFIG,
});

const servicesConfig = parseAdoConfig({
  mode: "services",
  org: "ugurbank",
  tokenRef: "ado/services/pat",
  ci: CI_CONFIG,
});

function client(config: typeof serverConfig, http: { fetch: ReturnType<typeof respondWith>["fetch"] }) {
  return new AdoClient({ config, token: () => "pat-secret", fetch: http.fetch });
}

describe("AdoClient URL building", () => {
  it("builds the on-prem URL with collection and pinned api-version 6.0", async () => {
    const http = respondWith(fixture("repo-get"));
    await client(serverConfig, http).request({ project: "UgurPay", path: "git/repositories/ugurpay" });

    const call = http.calls[0]!;
    expect(call.url).toContain(
      "https://tfs.ugurbank.local/tfs/DefaultCollection/UgurPay/_apis/git/repositories/ugurpay",
    );
    expect(queryOf(call, "api-version")).toBe("6.0");
  });

  it("builds the Services URL with org and pinned api-version 7.1", async () => {
    const http = respondWith(fixture("repo-get"));
    await client(servicesConfig, http).request({
      project: "UgurPay",
      path: "git/repositories/ugurpay",
    });

    const call = http.calls[0]!;
    expect(call.url).toContain(
      "https://dev.azure.com/ugurbank/UgurPay/_apis/git/repositories/ugurpay",
    );
    expect(queryOf(call, "api-version")).toBe("7.1");
  });

  it("appends query parameters and drops undefined ones", async () => {
    const http = respondWith(fixture("refs-list"));
    await client(servicesConfig, http).request({
      project: "UgurPay",
      path: "git/repositories/ugurpay/refs",
      query: { filter: "heads/main", latestStatusesOnly: undefined, top: 10 },
    });

    const call = http.calls[0]!;
    expect(queryOf(call, "filter")).toBe("heads/main");
    expect(queryOf(call, "top")).toBe("10");
    expect(call.url).not.toContain("latestStatusesOnly");
  });
});

describe("AdoClient authentication and transport", () => {
  it("sends the PAT as basic auth with an empty username", async () => {
    const http = respondWith(fixture("repo-get"));
    await client(servicesConfig, http).request({ project: "UgurPay", path: "git/repositories/x" });

    const header = http.calls[0]!.headers["authorization"]!;
    expect(header.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(header.slice("Basic ".length), "base64").toString("utf8")).toBe(":pat-secret");
  });

  it("asks the token provider on every request (short-lived tokens)", async () => {
    let issued = 0;
    const http = respondWith(fixture("repo-get"));
    const ado = new AdoClient({
      config: servicesConfig,
      token: () => Promise.resolve(`pat-${++issued}`),
      fetch: http.fetch,
    });
    await ado.request({ project: "P", path: "git/repositories/x" });
    await ado.request({ project: "P", path: "git/repositories/x" });
    expect(issued).toBe(2);
  });

  it("serialises the body as JSON and sets the content type", async () => {
    const http = respondWith(fixture("pr-create-draft"));
    await client(servicesConfig, http).request({
      project: "UgurPay",
      path: "git/repositories/ugurpay/pullrequests",
      method: "POST",
      body: { title: "t" },
    });

    const call = http.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({ title: "t" });
  });

  it("maps 401/403 to AdoAuthError and 404 to AdoNotFoundError", async () => {
    const unauthorized = createFakeHttp(() => ({ status: 401, text: "unauthorized" }));
    await expect(
      client(servicesConfig, unauthorized).request({ project: "P", path: "git/repositories/x" }),
    ).rejects.toBeInstanceOf(AdoAuthError);

    const forbidden = createFakeHttp(() => ({ status: 403, text: "forbidden" }));
    await expect(
      client(servicesConfig, forbidden).request({ project: "P", path: "git/repositories/x" }),
    ).rejects.toBeInstanceOf(AdoAuthError);

    const missing = createFakeHttp(() => ({ status: 404, text: "TF401019: repo not found" }));
    await expect(
      client(servicesConfig, missing).request({ project: "P", path: "git/repositories/x" }),
    ).rejects.toBeInstanceOf(AdoNotFoundError);
  });

  it("treats the 203 sign-in page as an auth failure, not as a body", async () => {
    const signIn = createFakeHttp(() => ({ status: 203, text: "<html>sign in</html>" }));
    await expect(
      client(servicesConfig, signIn).request({ project: "P", path: "git/repositories/x" }),
    ).rejects.toBeInstanceOf(AdoAuthError);
  });

  it("reports method, url and a truncated body on other HTTP errors", async () => {
    const failing = createFakeHttp(() => ({ status: 500, text: "x".repeat(900) }));
    try {
      await client(servicesConfig, failing).request({
        project: "P",
        path: "git/repositories/x",
        method: "POST",
        body: {},
      });
      expect.unreachable("a 500 must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdoHttpError);
      const http = error as AdoHttpError;
      expect(http.status).toBe(500);
      expect(http.method).toBe("POST");
      expect(http.url).toContain("git/repositories/x");
      expect(http.bodySnippet.length).toBeLessThanOrEqual(501);
    }
  });

  it("returns null for 204 and for an empty 200 body", async () => {
    const noContent = createFakeHttp(() => ({ status: 204 }));
    await expect(
      client(servicesConfig, noContent).request({ project: "P", path: "git/x", method: "DELETE" }),
    ).resolves.toBeNull();

    const empty = createFakeHttp(() => ({ status: 200, text: "" }));
    await expect(client(servicesConfig, empty).request({ project: "P", path: "git/x" })).resolves.toBeNull();
  });
});
