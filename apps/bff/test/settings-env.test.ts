import { type Env, EnvSchema } from "@maestro/config";
import { describe, expect, it } from "vitest";
import type { HealthReader, ServiceHealth } from "../src/read-models.js";
import { EnvSettingsReader } from "../src/stores/settings-env.js";
import { firstConfigured, llmEndpoint, maskEndpointCredentials } from "../src/stores/settings-wiring.js";

/**
 * The settings screen's connection table, against the environment a real
 * deployment presents.
 *
 * The screen is where an operator answers "what is this platform wired to, and
 * is it up". Three ways it can lie, and all three have happened:
 *  · omit a connection the platform depends on, so the question cannot be
 *    asked at all (Temporal — the workflow engine every run goes through);
 *  · read the wrong variable name, so a WORKING integration reports
 *    `unconfigured` and sends someone to fix nothing (Jira Cloud);
 *  · print a credential, because the honest endpoint happens to contain one
 *    (the Postgres DSN).
 */

const CHECKED_AT = "2026-08-16T09:00:00.000Z";

function health(states: Readonly<Record<string, ServiceHealth["state"]>>): HealthReader {
  return {
    services: () =>
      Promise.resolve(
        Object.entries(states).map(([service, state]) => ({
          service,
          state,
          version: service,
          checkedAt: CHECKED_AT,
          note: null,
        })),
      ),
  };
}

/** The base env, parsed through the real schema so defaults are the real ones. */
function env(overrides: Record<string, string> = {}): Env {
  return EnvSchema.parse({ NODE_ENV: "test", ...overrides });
}

async function rows(
  overrides: Record<string, string> = {},
  states: Readonly<Record<string, ServiceHealth["state"]>> = {},
  llm: { baseUrl?: string; model?: string; apiKeyRef?: string } = {},
): Promise<Map<string, { endpoint: string; status: string; credentialRef: string; checkedAt: string | null }>> {
  const reader = new EnvSettingsReader(env(overrides), health(states), [], {
    baseUrl: llm.baseUrl,
    model: llm.model,
    apiKeyRef: llm.apiKeyRef,
  });
  const connections = await reader.connections();
  return new Map(connections.map((row) => [row.id, { ...row }]));
}

describe("the engine has a row", () => {
  it("lists Temporal, with the address the deployment dials", async () => {
    const table = await rows({ TEMPORAL_ADDRESS: "temporal.bank.local:7233" }, { temporal: "healthy" });

    // It was missing entirely. Every run this platform starts is a Temporal
    // workflow, so a settings screen without it cannot answer the first
    // question an operator has.
    expect(table.get("temporal")?.endpoint).toBe("temporal.bank.local:7233");
  });

  it("says connected only when the engine's OWN probe answered", async () => {
    const table = await rows({ TEMPORAL_ADDRESS: "localhost:7233" }, { temporal: "healthy" });

    expect(table.get("temporal")?.status).toBe("connected");
    expect(table.get("temporal")?.checkedAt).toBe(CHECKED_AT);
  });

  it("says degraded — not connected — when the engine is configured but down", async () => {
    const table = await rows({ TEMPORAL_ADDRESS: "localhost:7233" }, { temporal: "down" });

    // The whole reason to wire the probe in: a variable being set is not
    // evidence the engine answers, and a green light on a dead engine is the
    // single most expensive thing this screen could say.
    expect(table.get("temporal")?.status).toBe("degraded");
  });

  it("says unconfigured, never degraded, when no address is set", async () => {
    const table = await rows({}, { temporal: "down" });

    // Nobody set it up; that is a different next action from "it is broken".
    expect(table.get("temporal")?.status).toBe("unconfigured");
  });
});

describe("the database has a row and no password in it", () => {
  it("shows the host and replaces the password with ***", async () => {
    const table = await rows(
      { DATABASE_URL: "postgresql://maestro:s3cr3t-pw@db.bank.local:5432/maestro" },
      { postgres: "healthy" },
    );

    const endpoint = table.get("database")?.endpoint ?? "";
    expect(endpoint).not.toContain("s3cr3t-pw");
    expect(endpoint).toContain("db.bank.local:5432");
    // The user survives: it names the role, and an operator needs it.
    expect(endpoint).toContain("maestro:***@");
  });

  it("keeps the password out of the whole serialised table, not just one field", async () => {
    const table = await rows(
      { DATABASE_URL: "postgresql://maestro:s3cr3t-pw@db.bank.local:5432/maestro" },
      { postgres: "healthy" },
    );

    // The row travels as JSON into a browser and a log aggregator. Asserting
    // on one field would pass while the secret leaked through another.
    expect(JSON.stringify([...table])).not.toContain("s3cr3t-pw");
  });

  it("reflects the Postgres probe rather than the DSN's presence", async () => {
    const dsn = { DATABASE_URL: "postgresql://maestro:pw@db.bank.local:5432/maestro" };

    expect((await rows(dsn, { postgres: "healthy" })).get("database")?.status).toBe("connected");
    expect((await rows(dsn, { postgres: "down" })).get("database")?.status).toBe("degraded");
  });
});

describe("Jira reads the name the deployment actually sets", () => {
  it("reports a Cloud site as configured (JIRA_CLOUD_BASE_URL)", async () => {
    const table = await rows({ JIRA_CLOUD_BASE_URL: "https://bank.atlassian.net" });

    // The defect this replaces: the reader looked only at JIRA_BASE_URL, so a
    // Cloud deployment whose Jira was processing tickets showed an empty
    // endpoint and `unconfigured` — an operator dispatched to fix nothing.
    expect(table.get("jira")?.endpoint).toBe("https://bank.atlassian.net");
    expect(table.get("jira")?.status).toBe("connected");
  });

  it("still reports a Data Center site (JIRA_BASE_URL)", async () => {
    const table = await rows({ JIRA_BASE_URL: "https://jira.bank.local" });

    expect(table.get("jira")?.endpoint).toBe("https://jira.bank.local");
    expect(table.get("jira")?.status).toBe("connected");
  });

  it("prefers the Cloud site when a deployment carries both names", async () => {
    const table = await rows({
      JIRA_CLOUD_BASE_URL: "https://bank.atlassian.net",
      JIRA_BASE_URL: "https://jira.bank.local",
    });

    // Same order as `jiraCloudConfig` in apps/deploy, so the screen names the
    // site the work port is actually pointed at.
    expect(table.get("jira")?.endpoint).toBe("https://bank.atlassian.net");
  });

  it("carries the same resolution into the publish row", async () => {
    const table = await rows({ JIRA_CLOUD_BASE_URL: "https://bank.atlassian.net" });

    // Confluence rides the same site; it was unconfigured for the same reason.
    expect(table.get("publish")?.endpoint).toBe("https://bank.atlassian.net");
  });

  it("is unconfigured when neither name is set", async () => {
    const table = await rows({});

    expect(table.get("jira")?.status).toBe("unconfigured");
  });
});

describe("the LLM has a row that names the model", () => {
  it("shows the endpoint AND which model answers", async () => {
    const table = await rows({}, {}, {
      baseUrl: "https://openrouter.ai/api",
      model: "anthropic/claude-sonnet-4.5",
      apiKeyRef: "kv/llm#apikey",
    });

    // "Which model reviewed this bank's change request" is an audit question.
    expect(table.get("llm")?.endpoint).toBe("https://openrouter.ai/api (anthropic/claude-sonnet-4.5)");
    expect(table.get("llm")?.status).toBe("connected");
  });

  it("shows the key REFERENCE and never a key", async () => {
    const table = await rows({}, {}, { baseUrl: "https://llm.bank.local/v1", apiKeyRef: "kv/llm#apikey" });

    expect(table.get("llm")?.credentialRef).toBe("kv/llm#apikey");
    expect(JSON.stringify([...table])).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("is unconfigured when a model is named with nowhere to send it", async () => {
    const table = await rows({}, {}, { model: "gpt-4o-mini" });

    expect(table.get("llm")?.status).toBe("unconfigured");
    expect(table.get("llm")?.endpoint).toBe("");
  });
});

describe("what the table must NOT do", () => {
  it("keeps genuinely unconfigured connections on the list", async () => {
    const table = await rows({});

    // A connection missing from the table reads as "not part of the
    // platform"; audit forwarding very much is (M33). Absent is reported,
    // never omitted.
    for (const id of ["ado", "vault", "storage", "egress_proxy", "siem"]) {
      expect(table.get(id)?.status).toBe("unconfigured");
    }
  });

  it("does not claim connected for a connection nothing probes", async () => {
    // `identity` has no probe. With a driver selected it is `configured` in
    // spirit — reported here as `connected` by the pre-existing `statusOf`
    // rule — but it must not carry a probe timestamp it never earned.
    const table = await rows({}, { temporal: "healthy" });

    expect(table.get("identity")?.checkedAt).toBeNull();
  });
});

describe("the value rules on their own", () => {
  it("treats a blank variable as absent (Compose interpolates unset to \"\")", () => {
    expect(firstConfigured("", "https://jira.bank.local")).toBe("https://jira.bank.local");
    expect(firstConfigured("   ", undefined)).toBeUndefined();
  });

  it("masks a password containing @ and / that a regex would leak", () => {
    const masked = maskEndpointCredentials("postgresql://maestro:p%40ss%2Fword@db.local:5432/m") ?? "";

    expect(masked).not.toContain("ss%2Fword");
    expect(masked).toContain("db.local:5432");
  });

  it("withholds a DSN it cannot parse rather than printing it raw", () => {
    // The value whose shape we cannot establish is the last one to display on
    // a guess — it may be exactly the malformed string carrying a secret.
    expect(maskEndpointCredentials("not a url at all")).toBe("(set; unreadable form withheld)");
  });

  it("leaves a passwordless endpoint alone", () => {
    expect(maskEndpointCredentials("postgresql://db.local:5432/m")).toBe("postgresql://db.local:5432/m");
  });

  it("reports no LLM endpoint when only a model is named", () => {
    expect(llmEndpoint({ baseUrl: undefined, model: "gpt-4o-mini", apiKeyRef: undefined })).toBeUndefined();
  });
});
