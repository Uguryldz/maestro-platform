import type { CiPort, ScmPort } from "@maestro/ports";
import { PortRegistry } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  ADO_DRIVER_ID,
  AdoConfigError,
  AdoScmDriver,
  AdoWebhookAuthError,
  registerAdoDrivers,
} from "../src/index.js";
import { APP, authHeaders, CI_CONFIG, fixture, respondWith, WEBHOOK_SECRET } from "./helpers.js";

const secrets: Record<string, string> = {
  "ado/services/pat": "pat-for-ado/services/pat",
  "ado/server/pat": "pat-for-ado/server/pat",
  "ado/webhook/secret": WEBHOOK_SECRET,
};

const deps = {
  resolveToken: (tokenRef: string) => secrets[tokenRef] ?? `pat-for-${tokenRef}`,
  issueSecret: (_scope: string, ttlSeconds: number) =>
    Promise.resolve({
      secret: "s",
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    }),
};

const servicesConfig = {
  mode: "services",
  org: "ugurbank",
  tokenRef: "ado/services/pat",
  ci: CI_CONFIG,
};
const serverConfig = {
  mode: "server",
  baseUrl: "https://tfs.ugurbank.local/tfs",
  collection: "DefaultCollection",
  tokenRef: "ado/server/pat",
  ci: CI_CONFIG,
};

describe("registerAdoDrivers (M44 registry)", () => {
  it("registers the ado driver under both the scm and the ci port", () => {
    const registry = new PortRegistry();
    registerAdoDrivers(registry, deps);

    expect(registry.drivers("scm")).toEqual([ADO_DRIVER_ID]);
    expect(registry.drivers("ci")).toEqual([ADO_DRIVER_ID]);
    expect(registry.resolve<ScmPort>("scm", "ado")(servicesConfig)).toBeInstanceOf(AdoScmDriver);
  });

  it("wires the webhook secret into the ci driver it builds (O1)", async () => {
    // Not "is it an AdoCiDriver" — that proves nothing. The question is
    // whether the registered driver actually authenticates with the secret
    // the config named, and refuses everything else.
    const registry = new PortRegistry();
    registerAdoDrivers(registry, deps);
    const ci = registry.resolve<CiPort>("ci", "ado")(serverConfig);

    const event = fixture("event-build-complete-server");
    await expect(
      ci.parseBuildEvent({ headers: authHeaders(WEBHOOK_SECRET), body: event }),
    ).resolves.toMatchObject({ ticketKey: "UGURWEB-902", prId: 77, status: "failed" });

    await expect(
      ci.parseBuildEvent({ headers: authHeaders("not-the-secret"), body: event }),
    ).rejects.toBeInstanceOf(AdoWebhookAuthError);
    // a bare body (no headers) can never be authenticated — fail-closed
    await expect(
      ci.parseBuildEvent(event as unknown as { headers: Record<string, string>; body: unknown }),
    ).rejects.toBeInstanceOf(AdoWebhookAuthError);
  });

  it("validates the config at construction time, in both modes", () => {
    const registry = new PortRegistry();
    registerAdoDrivers(registry, deps);
    const scm = registry.resolve<ScmPort>("scm", "ado");
    const ci = registry.resolve<CiPort>("ci", "ado");

    expect(() => scm({ mode: "services" })).toThrow(AdoConfigError);
    expect(() => scm({ ...serverConfig, collection: "" })).toThrow(AdoConfigError);
    expect(() => ci({ mode: "nowhere" })).toThrow(AdoConfigError);
  });

  it("refuses to build a ci driver with no webhook secret or no allow-list", () => {
    const registry = new PortRegistry();
    registerAdoDrivers(registry, deps);
    const ci = registry.resolve<CiPort>("ci", "ado");
    const { ci: _ci, ...withoutCi } = servicesConfig;

    expect(() => ci(withoutCi)).toThrow(AdoConfigError);
    expect(() => ci({ ...servicesConfig, ci: { ...CI_CONFIG, webhookSecretRef: "" } })).toThrow(
      AdoConfigError,
    );
    expect(() => ci({ ...servicesConfig, ci: { ...CI_CONFIG, prValidationBuilds: [] } })).toThrow(
      AdoConfigError,
    );
  });

  it("wires the token provider through to the request", async () => {
    const registry = new PortRegistry();
    const http = respondWith(fixture("repo-get"));
    registerAdoDrivers(registry, { ...deps, fetch: http.fetch });

    const scm = registry.resolve<ScmPort>("scm", "ado")(servicesConfig);
    await scm.resolveRepo(APP);

    const header = http.calls[0]!.headers["authorization"]!;
    expect(Buffer.from(header.slice("Basic ".length), "base64").toString("utf8")).toBe(
      ":pat-for-ado/services/pat",
    );
  });

  it("wires the configured push ttl ceiling into the scm driver", async () => {
    const registry = new PortRegistry();
    registerAdoDrivers(registry, deps);
    const scm = registry.resolve<ScmPort>("scm", "ado")({
      ...servicesConfig,
      maxPushTtlSeconds: 120,
    });
    await expect(scm.getPushCredential({ project: "UgurPay", repo: "ugurpay" }, 900)).rejects.toThrow(
      /120s ceiling/,
    );
  });

  it("keeps the two ports independent — a second registration is refused", () => {
    const registry = new PortRegistry();
    registerAdoDrivers(registry, deps);
    expect(() => registerAdoDrivers(registry, deps)).toThrow(/duplicate/);
  });
});
