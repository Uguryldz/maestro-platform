import { PortRegistry, type SecretPort, type WorkPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  createJiraCloudWorkPort,
  JIRA_CLOUD_DRIVER,
  JIRA_DC_DRIVER,
  JiraCloudConfig,
  JiraCloudWorkPort,
  JiraConfigError,
  JiraWebhookVerificationError,
  registerJiraDrivers,
  signWebhookBody,
  WORK_PORT,
} from "../../src/index.js";
import { fixture, stubFetch } from "../helpers.js";

const secrets: SecretPort = {
  get: (key: string) => Promise.resolve(`resolved:${key}`),
  issueShortLived: () => Promise.resolve({ secret: "s", expiresAt: "2026-08-10T13:00:00.000+03:00" }),
  set: () => Promise.reject(new Error("not used")),
};

const baseConfig = {
  baseUrl: "https://uyildiz.atlassian.net",
  email: "pilot@bank.example",
  apiTokenRef: "kv/jira-cloud/token",
};

describe("jira-cloud driver registration", () => {
  it("registers jira-cloud next to jira-dc on the work port", () => {
    const registry = new PortRegistry();
    registerJiraDrivers(registry);

    expect(registry.drivers(WORK_PORT)).toEqual([JIRA_DC_DRIVER, JIRA_CLOUD_DRIVER]);
    const factory = registry.resolve<WorkPort>(WORK_PORT, JIRA_CLOUD_DRIVER);
    expect(factory({ ...baseConfig, deps: { secrets } })).toBeInstanceOf(JiraCloudWorkPort);
  });

  it("resolves the API token through the SecretPort reference into Basic auth", async () => {
    const stub = stubFetch([{ body: fixture("cloud/issue-get") }]);
    const driver = createJiraCloudWorkPort({ ...baseConfig, deps: { secrets, fetchImpl: stub.fetchImpl } });

    await driver.getTicket("OPS-6");
    const expected = Buffer.from("pilot@bank.example:resolved:kv/jira-cloud/token", "utf8").toString("base64");
    expect(stub.calls[0]!.headers["authorization"]).toBe(`Basic ${expected}`);
  });

  it("applies the documented defaults", () => {
    expect(JiraCloudConfig.parse(baseConfig)).toEqual({
      ...baseConfig,
      childIssueTypeName: "Task",
      linkTypeName: "Relates",
      requestTimeoutMs: 15_000,
      groupPageSize: 50,
    });
  });

  it("resolves the webhook secret through the SecretPort reference when one is declared", async () => {
    const driver = createJiraCloudWorkPort({
      ...baseConfig,
      webhookSecretRef: "kv/jira#webhook",
      deps: { secrets },
    });
    const body = '{"webhookEvent":"jira:issue_created"}';

    // Verifies only against the value the SecretPort returned for that key —
    // proof the reference was resolved rather than the literal string used.
    await expect(
      driver.verifyWebhook(body, { "x-hub-signature": signWebhookBody(body, "resolved:kv/jira#webhook") }),
    ).resolves.toBeUndefined();
    await expect(
      driver.verifyWebhook(body, { "x-hub-signature": signWebhookBody(body, "kv/jira#webhook") }),
    ).rejects.toBeInstanceOf(JiraWebhookVerificationError);
  });

  it("builds without a webhook secret — and that driver REFUSES deliveries", async () => {
    const driver = createJiraCloudWorkPort({ ...baseConfig, deps: { secrets } });
    const body = '{"webhookEvent":"jira:issue_created"}';

    await expect(
      driver.verifyWebhook(body, { "x-hub-signature": signWebhookBody(body, "anything") }),
    ).rejects.toThrow(/missing_secret/);
  });

  it("rejects an invalid config with the offending fields", () => {
    const error = (() => {
      try {
        createJiraCloudWorkPort({ baseUrl: "not-a-url", email: "not-an-email", deps: { secrets } });
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(JiraConfigError);
    expect((error as Error).message).toMatch(/baseUrl/);
    expect((error as Error).message).toMatch(/email/);
    expect((error as Error).message).toMatch(/apiTokenRef/);
  });

  it("refuses to build without a SecretPort — no silent unauthenticated client", () => {
    expect(() => createJiraCloudWorkPort(baseConfig)).toThrow(/SecretPort/);
    expect(() => createJiraCloudWorkPort({ ...baseConfig, deps: { secrets: {} } })).toThrow(JiraConfigError);
  });
});
