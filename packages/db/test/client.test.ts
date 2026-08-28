import { describe, expect, it } from "vitest";
import { assertPostgresUrl, createDb, InvalidDatabaseUrlError } from "../src/index.js";

const VALID_URL = "postgresql://maestro:s3cret@db.corp.local:5432/maestro?schema=public";

describe("assertPostgresUrl", () => {
  it("accepts postgres and postgresql schemes", () => {
    expect(() => assertPostgresUrl(VALID_URL)).not.toThrow();
    expect(() => assertPostgresUrl("postgres://u:p@localhost:5432/maestro")).not.toThrow();
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["not-a-url", "not a URL"],
    ["mysql://u:p@localhost:3306/maestro", "expected postgresql://"],
    ["postgresql://u:p@localhost:5432", "no database name"],
  ])("rejects %s", (url, reason) => {
    expect(() => assertPostgresUrl(url)).toThrow(InvalidDatabaseUrlError);
    expect(() => assertPostgresUrl(url)).toThrow(new RegExp(reason.replace(/[/\\]/g, "\\$&")));
  });

  it("never leaks the credential-bearing url in the error message", () => {
    try {
      assertPostgresUrl("mysql://maestro:s3cret@db:3306/maestro");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("s3cret");
    }
  });
});

describe("createDb", () => {
  it("builds a lazy client without connecting", async () => {
    const db = createDb(VALID_URL);
    expect(typeof db.$disconnect).toBe("function");
    // Every seeded delegate must exist on the generated client.
    expect(typeof db.param.upsert).toBe("function");
    expect(typeof db.paramVersion.upsert).toBe("function");
    await db.$disconnect();
  });

  it("exposes a delegate for every model in the schema", () => {
    const db = createDb(VALID_URL) as unknown as Record<string, unknown>;
    for (const delegate of [
      "workflowRun",
      "stepEvent",
      "journalEntry",
      "application",
      "repoCard",
      "jiraProjectBinding",
      "routingRule",
      "param",
      "paramVersion",
      "auditLog",
      "llmCall",
      "subscriptionAccount",
      "variant",
      "variantVersion",
      "knowledgeDoc",
      "evidencePackageRow",
      "user",
    ]) {
      expect(db[delegate], `missing delegate ${delegate}`).toBeDefined();
    }
  });

  it("refuses a bad url before any client is built", () => {
    expect(() => createDb("http://example.com/db")).toThrow(InvalidDatabaseUrlError);
  });
});
