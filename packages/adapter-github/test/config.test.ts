import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PUSH_TTL_SECONDS,
  GITHUB_API_VERSION,
  GithubConfigError,
  apiVersionFor,
  parseGithubConfig,
} from "../src/index.js";

describe("parseGithubConfig", () => {
  it("defaults a bare cloud config to github.com REST + GraphQL roots", () => {
    const config = parseGithubConfig({ tokenRef: "github/cloud/token" });
    expect(config.mode).toBe("cloud");
    expect(config.apiBaseUrl).toBe("https://api.github.com");
    expect(config.graphqlUrl).toBe("https://api.github.com/graphql");
    expect(config.maxPushTtlSeconds).toBe(DEFAULT_MAX_PUSH_TTL_SECONDS);
    expect(apiVersionFor(config)).toBe(GITHUB_API_VERSION);
  });

  it("accepts an enterprise config with explicit REST and GraphQL roots", () => {
    const config = parseGithubConfig({
      mode: "enterprise",
      apiBaseUrl: "https://ghe.ugurbank.local/api/v3",
      graphqlUrl: "https://ghe.ugurbank.local/api/graphql",
      tokenRef: "github/ghe/token",
    });
    expect(config.mode).toBe("enterprise");
    expect(config.apiBaseUrl).toBe("https://ghe.ugurbank.local/api/v3");
  });

  it("honours an explicit api-version override", () => {
    const config = parseGithubConfig({ tokenRef: "t", apiVersion: "2024-01-01" });
    expect(apiVersionFor(config)).toBe("2024-01-01");
  });

  it("refuses an empty token ref", () => {
    expect(() => parseGithubConfig({ tokenRef: "" })).toThrow(GithubConfigError);
  });

  it("refuses an enterprise config missing its GraphQL root", () => {
    expect(() =>
      parseGithubConfig({
        mode: "enterprise",
        apiBaseUrl: "https://ghe.ugurbank.local/api/v3",
        tokenRef: "t",
      }),
    ).toThrow(GithubConfigError);
  });

  it("refuses a plain-http base url unless allowInsecureHttp is set", () => {
    expect(() =>
      parseGithubConfig({ apiBaseUrl: "http://api.github.local", tokenRef: "t" }),
    ).toThrow(/https/);
    expect(
      parseGithubConfig({
        apiBaseUrl: "http://api.github.local",
        graphqlUrl: "http://api.github.local/graphql",
        tokenRef: "t",
        allowInsecureHttp: true,
      }).apiBaseUrl,
    ).toBe("http://api.github.local");
  });

  it("refuses a non-http(s) scheme even with allowInsecureHttp", () => {
    expect(() =>
      parseGithubConfig({
        apiBaseUrl: "javascript:alert(1)",
        tokenRef: "t",
        allowInsecureHttp: true,
      }),
    ).toThrow(GithubConfigError);
  });

  it("caps maxPushTtlSeconds at the hard ceiling", () => {
    expect(() => parseGithubConfig({ tokenRef: "t", maxPushTtlSeconds: 999_999 })).toThrow(
      GithubConfigError,
    );
  });
});
