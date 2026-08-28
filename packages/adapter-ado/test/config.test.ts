import { describe, expect, it } from "vitest";
import {
  ADO_API_VERSIONS,
  AdoConfigError,
  apiRoot,
  apiVersionFor,
  DEFAULT_MAX_PUSH_TTL_SECONDS,
  parseAdoConfig,
  PUSH_TTL_CEILING_SECONDS,
} from "../src/index.js";
import { CI_CONFIG } from "./helpers.js";

const server = {
  mode: "server",
  baseUrl: "https://tfs.ugurbank.local/tfs",
  collection: "DefaultCollection",
  tokenRef: "ado/server/pat",
  ci: CI_CONFIG,
};

const services = {
  mode: "services",
  org: "ugurbank",
  tokenRef: "ado/services/pat",
  ci: CI_CONFIG,
};

describe("AdoConfig (M11 dual mode)", () => {
  it("accepts the on-prem shape and builds a collection-scoped API root", () => {
    const config = parseAdoConfig(server);
    expect(apiRoot(config, "UgurPay")).toBe(
      "https://tfs.ugurbank.local/tfs/DefaultCollection/UgurPay/_apis",
    );
  });

  it("defaults the Services base URL to dev.azure.com and scopes by org", () => {
    const config = parseAdoConfig(services);
    expect(apiRoot(config, "UgurPay")).toBe("https://dev.azure.com/ugurbank/UgurPay/_apis");
  });

  it("pins api-version per mode: Server 6.0, Services 7.1", () => {
    expect(apiVersionFor(parseAdoConfig(server))).toBe(ADO_API_VERSIONS.server);
    expect(apiVersionFor(parseAdoConfig(services))).toBe("7.1");
    expect(ADO_API_VERSIONS.server).toBe("6.0");
  });

  it("honours an explicit api-version override", () => {
    const config = parseAdoConfig({ ...services, apiVersion: "7.1-preview.1" });
    expect(apiVersionFor(config)).toBe("7.1-preview.1");
  });

  it("rejects an api-version that is not a version string", () => {
    expect(() => parseAdoConfig({ ...services, apiVersion: "latest" })).toThrow(AdoConfigError);
  });

  it("requires a collection in server mode and rejects it being absent", () => {
    const { collection: _collection, ...withoutCollection } = server;
    expect(() => parseAdoConfig(withoutCollection)).toThrow(AdoConfigError);
  });

  it("requires an org in services mode", () => {
    expect(() => parseAdoConfig({ mode: "services", tokenRef: "x", ci: CI_CONFIG })).toThrow(
      AdoConfigError,
    );
  });

  it("rejects an unknown mode with a readable issue list", () => {
    try {
      parseAdoConfig({ mode: "github", tokenRef: "x" });
      expect.unreachable("unknown mode must not parse");
    } catch (error) {
      expect(error).toBeInstanceOf(AdoConfigError);
      expect((error as AdoConfigError).issues.join()).toMatch(/mode/);
    }
  });

  it("encodes multi-segment collections and project names with spaces", () => {
    const config = parseAdoConfig({ ...server, collection: "tfs/Banka Koleksiyon" });
    expect(apiRoot(config, "Ugur Pay")).toBe(
      "https://tfs.ugurbank.local/tfs/tfs/Banka%20Koleksiyon/Ugur%20Pay/_apis",
    );
  });

  it("tolerates a trailing slash on the base URL", () => {
    const config = parseAdoConfig({ ...server, baseUrl: "https://tfs.ugurbank.local/tfs/" });
    expect(apiRoot(config, "UgurPay")).toBe(
      "https://tfs.ugurbank.local/tfs/DefaultCollection/UgurPay/_apis",
    );
  });
});

describe("AdoConfig transport security (O6)", () => {
  it("refuses a plain-http base URL, which would put the PAT on the wire", () => {
    try {
      parseAdoConfig({ ...server, baseUrl: "http://tfs.ugurbank.local/tfs" });
      expect.unreachable("http must not be accepted by default");
    } catch (error) {
      expect(error).toBeInstanceOf(AdoConfigError);
      expect((error as AdoConfigError).issues.join()).toMatch(/baseUrl.*https/);
    }
  });

  it("refuses non-http(s) schemes that z.url() alone would accept", () => {
    for (const baseUrl of ["javascript:alert(1)", "ftp://tfs.ugurbank.local", "file:///tmp/tfs"]) {
      expect(() => parseAdoConfig({ ...server, baseUrl })).toThrow(AdoConfigError);
    }
  });

  it("refuses http on the Services side too, allowInsecureHttp or not", () => {
    expect(() => parseAdoConfig({ ...services, baseUrl: "http://dev.azure.com" })).toThrow(
      AdoConfigError,
    );
    expect(
      parseAdoConfig({ ...services, baseUrl: "http://localhost:8080", allowInsecureHttp: true })
        .baseUrl,
    ).toBe("http://localhost:8080");
  });

  it("allows http only behind the explicit local-development opt-in", () => {
    const config = parseAdoConfig({
      ...server,
      baseUrl: "http://localhost:8080/tfs",
      allowInsecureHttp: true,
    });
    expect(config.allowInsecureHttp).toBe(true);
    expect(apiRoot(config, "UgurPay")).toBe(
      "http://localhost:8080/tfs/DefaultCollection/UgurPay/_apis",
    );
    // The opt-in does not open the door to anything but http.
    expect(() =>
      parseAdoConfig({ ...server, baseUrl: "ftp://tfs.local", allowInsecureHttp: true }),
    ).toThrow(AdoConfigError);
  });

  it("defaults allowInsecureHttp to false rather than leaving it unset", () => {
    expect(parseAdoConfig(server).allowInsecureHttp).toBe(false);
  });
});

describe("AdoConfig CI ingest block (K1/O1 fail-closed)", () => {
  it("requires the ci block: no webhook secret, no driver", () => {
    const { ci: _ci, ...withoutCi } = services;
    expect(() => parseAdoConfig(withoutCi)).toThrow(AdoConfigError);
    expect(() =>
      parseAdoConfig({ ...services, ci: { ...CI_CONFIG, webhookSecretRef: "" } }),
    ).toThrow(AdoConfigError);
  });

  it("refuses an empty PR validation allow-list instead of allowing everything", () => {
    try {
      parseAdoConfig({ ...services, ci: { ...CI_CONFIG, prValidationBuilds: [] } });
      expect.unreachable("an empty allow-list must not parse");
    } catch (error) {
      expect((error as AdoConfigError).issues.join()).toMatch(/allow-listed/);
    }
  });

  it("requires project, repository and definition id on every allow-list entry", () => {
    for (const entry of [
      { repository: "ugurpay", definitionId: 12 },
      { project: "UgurPay", definitionId: 12 },
      { project: "UgurPay", repository: "ugurpay" },
      { project: "UgurPay", repository: "ugurpay", definitionId: 0 },
    ]) {
      expect(() =>
        parseAdoConfig({ ...services, ci: { ...CI_CONFIG, prValidationBuilds: [entry] } }),
      ).toThrow(AdoConfigError);
    }
  });

  it("defaults the webhook username to the empty form ADO also allows", () => {
    const { webhookUsername: _username, ...ci } = CI_CONFIG;
    expect(parseAdoConfig({ ...services, ci }).ci.webhookUsername).toBe("");
  });
});

describe("AdoConfig push credential ceiling (O5)", () => {
  it("defaults the ceiling to one hour", () => {
    expect(parseAdoConfig(services).maxPushTtlSeconds).toBe(DEFAULT_MAX_PUSH_TTL_SECONDS);
    expect(DEFAULT_MAX_PUSH_TTL_SECONDS).toBe(3600);
  });

  it("honours a lower ceiling and refuses one above the hard limit", () => {
    expect(parseAdoConfig({ ...services, maxPushTtlSeconds: 300 }).maxPushTtlSeconds).toBe(300);
    expect(() =>
      parseAdoConfig({ ...services, maxPushTtlSeconds: PUSH_TTL_CEILING_SECONDS + 1 }),
    ).toThrow(AdoConfigError);
    expect(() => parseAdoConfig({ ...services, maxPushTtlSeconds: 0 })).toThrow(AdoConfigError);
  });
});
