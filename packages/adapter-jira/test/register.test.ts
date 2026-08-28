import { PortRegistry, type SecretPort, type WorkPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  createJiraDcWorkPort,
  JIRA_CLOUD_DRIVER,
  JIRA_DC_DRIVER,
  JiraConfigError,
  JiraDcConfig,
  JiraDcWorkPort,
  registerJiraDrivers,
  WORK_PORT,
} from "../src/index.js";
import { fixture, stubFetch } from "./helpers.js";

const secrets: SecretPort = {
  get: (key: string) => Promise.resolve(`resolved:${key}`),
  issueShortLived: () => Promise.resolve({ secret: "s", expiresAt: "2026-08-08T13:00:00.000+03:00" }),
  set: () => Promise.reject(new Error("not used")),
};

const baseConfig = {
  baseUrl: "https://jira.internal.bank",
  tokenRef: "kv/jira/pat",
  webhookSecretRef: "kv/jira/webhook",
};

describe("driver registration", () => {
  it("registers the jira-dc driver on the work port", () => {
    const registry = new PortRegistry();
    registerJiraDrivers(registry);

    expect(registry.drivers(WORK_PORT)).toEqual([JIRA_DC_DRIVER, JIRA_CLOUD_DRIVER]);
    const factory = registry.resolve<WorkPort>(WORK_PORT, JIRA_DC_DRIVER);
    expect(factory({ ...baseConfig, deps: { secrets } })).toBeInstanceOf(JiraDcWorkPort);
  });

  it("resolves the PAT through the SecretPort reference", async () => {
    const stub = stubFetch([{ body: fixture("issue-get") }]);
    const driver = createJiraDcWorkPort({ ...baseConfig, deps: { secrets, fetchImpl: stub.fetchImpl } });

    await driver.getTicket("UGURPAY-501");
    expect(stub.calls[0]!.headers["authorization"]).toBe("Bearer resolved:kv/jira/pat");
  });

  it("applies the documented defaults", async () => {
    expect(JiraDcConfig.parse(baseConfig)).toEqual({
      ...baseConfig,
      childIssueTypeName: "Task",
      linkTypeName: "Relates",
      requestTimeoutMs: 15_000,
      groupPageSize: 50,
    });

    // …and the defaults reach the wire, not just the parsed object.
    const stub = stubFetch([{ body: { isLast: true, total: 0, values: [] } }]);
    const driver = createJiraDcWorkPort({ ...baseConfig, deps: { secrets, fetchImpl: stub.fetchImpl } });
    expect(driver.driver).toBe(JIRA_DC_DRIVER);

    await driver.verifyMembership("mert.demir", "tech-leads");
    expect(stub.calls[0]!.url).toContain("maxResults=50");
  });

  it("rejects an invalid config with the offending fields", () => {
    const error = (() => {
      try {
        createJiraDcWorkPort({ baseUrl: "not-a-url", tokenRef: "", deps: { secrets } });
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(JiraConfigError);
    expect((error as Error).message).toMatch(/baseUrl/);
    expect((error as Error).message).toMatch(/webhookSecretRef/);
  });

  it("refuses to build without a SecretPort — no silent unauthenticated client", () => {
    expect(() => createJiraDcWorkPort(baseConfig)).toThrow(/SecretPort/);
    expect(() => createJiraDcWorkPort({ ...baseConfig, deps: { secrets: {} } })).toThrow(JiraConfigError);
  });
});
