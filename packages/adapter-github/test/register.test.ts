import type { ScmPort } from "@maestro/ports";
import { PortRegistry } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  GITHUB_DRIVER_ID,
  GithubConfigError,
  GithubScmDriver,
  registerGithubDrivers,
} from "../src/index.js";
import { APP, fixture, respondWith } from "./helpers.js";

const secrets: Record<string, string> = {
  "github/cloud/token": "token-for-github/cloud/token",
};

const deps = {
  resolveToken: (tokenRef: string) => secrets[tokenRef] ?? `token-for-${tokenRef}`,
  issueSecret: (_scope: string, ttlSeconds: number) =>
    Promise.resolve({
      secret: "s",
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    }),
};

const cloudConfig = { tokenRef: "github/cloud/token" };

describe("registerGithubDrivers (M44 registry)", () => {
  it("registers the github driver under the scm port", () => {
    const registry = new PortRegistry();
    registerGithubDrivers(registry, deps);

    expect(registry.drivers("scm")).toEqual([GITHUB_DRIVER_ID]);
    expect(registry.resolve<ScmPort>("scm", "github")(cloudConfig)).toBeInstanceOf(
      GithubScmDriver,
    );
  });

  it("validates the config at construction time", () => {
    const registry = new PortRegistry();
    registerGithubDrivers(registry, deps);
    const scm = registry.resolve<ScmPort>("scm", "github");

    expect(() => scm({})).toThrow(GithubConfigError);
    expect(() => scm({ tokenRef: "" })).toThrow(GithubConfigError);
    expect(() => scm({ mode: "enterprise", tokenRef: "t" })).toThrow(GithubConfigError);
  });

  it("wires the token provider through to the request as a Bearer header", async () => {
    const registry = new PortRegistry();
    const http = respondWith(fixture("repo-get"));
    registerGithubDrivers(registry, { ...deps, fetch: http.fetch });

    const scm = registry.resolve<ScmPort>("scm", "github")(cloudConfig);
    await scm.resolveRepo(APP);

    expect(http.calls[0]!.headers["authorization"]).toBe("Bearer token-for-github/cloud/token");
  });

  it("wires the configured push ttl ceiling into the scm driver", async () => {
    const registry = new PortRegistry();
    registerGithubDrivers(registry, deps);
    const scm = registry.resolve<ScmPort>("scm", "github")({
      ...cloudConfig,
      maxPushTtlSeconds: 120,
    });
    await expect(
      scm.getPushCredential({ project: "ugurbank", repo: "ugurpay" }, 900),
    ).rejects.toThrow(/120s ceiling/);
  });

  it("refuses a duplicate registration on the same port", () => {
    const registry = new PortRegistry();
    registerGithubDrivers(registry, deps);
    expect(() => registerGithubDrivers(registry, deps)).toThrow(/duplicate/);
  });
});
