import { CapabilityNotSupportedError } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  createEnvFileSecretPort,
  EnvFileSecretPort,
  parseDotEnv,
  SecretConfigError,
  SecretKeyError,
  SecretNotFoundError,
  SecretPermissionDeniedError,
} from "../src/index.js";
import { ENV_FILE_CONFIG, fakeClock, withAmbientNodeEnv } from "./helpers.js";

const ENV = { MAESTRO_SECRET_KV_JIRA_PAT__TOKEN: "dev-jira-pat" };

function port(overrides: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) {
  return createEnvFileSecretPort({
    ...ENV_FILE_CONFIG,
    ...overrides,
    deps: { env: ENV, nodeEnv: "development", ...deps },
  });
}

describe("env-file driver get()", () => {
  it("resolves a key from the environment", async () => {
    await expect(port().get("kv/jira/pat#token")).resolves.toBe("dev-jira-pat");
  });

  it("throws SecretNotFoundError for an absent variable", async () => {
    await expect(port().get("kv/jira/missing#token")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("treats an empty variable as absent (M6: no placeholder secrets)", async () => {
    const driver = port({}, { env: { MAESTRO_SECRET_KV_JIRA_PAT__TOKEN: "" } });

    await expect(driver.get("kv/jira/pat#token")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("refuses a mount outside the allow-list", async () => {
    await expect(port().get("root/jira/pat#token")).rejects.toBeInstanceOf(SecretPermissionDeniedError);
  });

  it("refuses a malformed key", async () => {
    await expect(port().get("kv/../etc/passwd")).rejects.toBeInstanceOf(SecretKeyError);
  });

  it("honours a custom prefix", async () => {
    const driver = port({ envPrefix: "DEV_" }, { env: { DEV_KV_JIRA_PAT__TOKEN: "prefixed" } });

    await expect(driver.get("kv/jira/pat#token")).resolves.toBe("prefixed");
  });

  it("never serves one secret in place of another whose name only differs by a separator", async () => {
    const driver = port({}, { env: { MAESTRO_SECRET_KV_JIRA_PROD_PAT__VALUE: "value-of-kv-slash-jira-slash-prod" } });

    await expect(driver.get("kv/jira/prod/pat")).resolves.toBe("value-of-kv-slash-jira-slash-prod");
    await expect(driver.get("kv/jira-prod/pat")).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(driver.get("kv/jira.prod/pat")).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(driver.get("kv/jira_prod/pat")).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});

describe("env-file driver file source", () => {
  const FILE = ["# dev secrets", "", "MAESTRO_SECRET_KV_JIRA_PAT__TOKEN=from-file", 'MAESTRO_SECRET_KV_ADO_PAT__VALUE="quoted-value"'].join("\n");

  it("falls back to the file when the variable is unset", async () => {
    const driver = port({ filePath: "/dev/.env.secrets" }, { env: {}, readFile: () => Promise.resolve(FILE) });

    await expect(driver.get("kv/jira/pat#token")).resolves.toBe("from-file");
    await expect(driver.get("kv/ado/pat")).resolves.toBe("quoted-value");
  });

  it("lets the environment override the file", async () => {
    const driver = port({ filePath: "/dev/.env.secrets" }, { readFile: () => Promise.resolve(FILE) });

    await expect(driver.get("kv/jira/pat#token")).resolves.toBe("dev-jira-pat");
  });

  it("reads the file once and re-reads after invalidate()", async () => {
    let reads = 0;
    const driver = port(
      { filePath: "/dev/.env.secrets" },
      {
        env: {},
        readFile: () => {
          reads += 1;
          return Promise.resolve(FILE);
        },
      },
    );

    await driver.get("kv/jira/pat#token");
    await driver.get("kv/ado/pat");
    expect(reads).toBe(1);

    driver.invalidate();
    await driver.get("kv/jira/pat#token");
    expect(reads).toBe(2);
  });

  it("fails loudly when the configured file cannot be read — no silent empty source", async () => {
    const driver = port(
      { filePath: "/nope/.env" },
      { env: {}, readFile: () => Promise.reject(new Error("ENOENT")) },
    );

    await expect(driver.get("kv/jira/pat#token")).rejects.toThrow(/ENOENT/);
  });
});

describe("parseDotEnv", () => {
  it("ignores comments, blanks and malformed lines, and strips quotes", () => {
    const parsed = parseDotEnv(
      ["# comment", "  ", "A=1", "export B=two", 'C="three"', "D='four'", "not a pair", "E = 5 "].join("\n"),
    );

    expect(parsed).toEqual({ A: "1", B: "two", C: "three", D: "four", E: "5" });
  });

  it("keeps an empty assignment empty rather than dropping the name", () => {
    expect(parseDotEnv("A=")).toEqual({ A: "" });
  });
});

describe("env-file driver capabilities and stage gate", () => {
  it("rejects issueShortLived with CapabilityNotSupportedError (M44)", async () => {
    await expect(port().issueShortLived("repo/x/push", 60)).rejects.toBeInstanceOf(CapabilityNotSupportedError);
  });

  it("REFUSES to be constructed in production (M6)", () => {
    expect(() => port({}, { nodeEnv: "production" })).toThrow(SecretConfigError);
    expect(() => port({}, { nodeEnv: "production" })).toThrow(/forbidden in production/);
  });

  it("cannot be smuggled past the gate by constructing the class directly", () => {
    expect(
      () =>
        new EnvFileSecretPort({
          config: { allowedMounts: ["kv"], cacheTtlSeconds: 0, envPrefix: "MAESTRO_SECRET_" },
          env: ENV,
          nodeEnv: "production",
          clock: fakeClock().clock,
        }),
    ).toThrow(SecretConfigError);
  });

  it("is allowed in development and test", () => {
    expect(() => port({}, { nodeEnv: "development" })).not.toThrow();
    expect(() => port({}, { nodeEnv: "test" })).not.toThrow();
  });
});

/**
 * The production gate is a SAFETY gate, so the environment may only harden it:
 * whatever the composition root passes as `deps.nodeEnv`, a process that is
 * itself running in production must not get a dev secret source (M6).
 */
describe("env-file production gate cannot be talked open by the caller", () => {
  it("refuses inside a production process even when the caller claims development", () => {
    withAmbientNodeEnv("production", () => {
      expect(() => port({}, { nodeEnv: "development" })).toThrow(SecretConfigError);
      expect(() => port({}, { nodeEnv: "test" })).toThrow(SecretConfigError);
      expect(() => port({}, { nodeEnv: undefined })).toThrow(SecretConfigError);
    });
  });

  it.each(["prod", "PRODUCTION", "Production", "production ", "staging", "PROD"])(
    "refuses the near-miss stage %j instead of waving it through",
    (stage) => {
      expect(() => port({}, { nodeEnv: stage })).toThrow(SecretConfigError);
    },
  );

  it("refuses an ambient stage it cannot recognise", () => {
    withAmbientNodeEnv("Production", () => {
      expect(() => port({}, { nodeEnv: "test" })).toThrow(SecretConfigError);
    });
    withAmbientNodeEnv("prod", () => {
      expect(() => port({}, { nodeEnv: "test" })).toThrow(SecretConfigError);
    });
  });

  it("rejects a non-string stage rather than comparing it to a string", () => {
    expect(() => port({}, { nodeEnv: 1 })).toThrow(SecretConfigError);
    expect(() => port({}, { nodeEnv: { toString: () => "development" } })).toThrow(SecretConfigError);
  });

  it("still allows the dev driver when neither side says production", () => {
    withAmbientNodeEnv("development", () => {
      expect(() => port({}, { nodeEnv: undefined })).not.toThrow();
      expect(() => port({}, { nodeEnv: "test" })).not.toThrow();
    });
    withAmbientNodeEnv(undefined, () => {
      expect(() => port({}, { nodeEnv: undefined })).not.toThrow();
    });
  });
});
