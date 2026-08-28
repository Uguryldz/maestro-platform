import { readFileSync } from "node:fs";
import { envVarName, parseSecretKey } from "@maestro/secrets";
import { describe, expect, it } from "vitest";
import { DeployEnvSchema } from "../src/env.js";
import { composePath, envExamplePath } from "./paths.js";

/**
 * The secret-name contract.
 *
 * `.env.example` and `compose.yaml` both spell out `MAESTRO_SECRET_*` variable
 * names, and the env-file driver derives those names from a reference with its
 * own encoding (`kv/jira#token` → `MAESTRO_SECRET_KV_JIRA__TOKEN`). Two places
 * writing the same name by hand is a drift waiting to happen, and the symptom
 * would be the worst kind: the driver reports "secret not found", an operator
 * checks the variable, sees it set, and has no way to tell that the name the
 * driver looked for differed by one underscore.
 *
 * So the names are DERIVED here and asserted against the files.
 */

const REFERENCE_VARS = [
  "JIRA_TOKEN_REF",
  "JIRA_WEBHOOK_SECRET_REF",
  "ADO_TOKEN_REF",
  "ADO_WEBHOOK_SECRET_REF",
  "LLM_API_KEY_REF",
  "LDAP_BIND_PASSWORD_REF",
] as const;

/** The default reference for each pointer variable, from the schema itself. */
function defaultRefs(): Record<string, string> {
  const parsed = DeployEnvSchema.parse({});
  return Object.fromEntries(
    REFERENCE_VARS.map((name) => [name, (parsed as Record<string, unknown>)[name] as string]),
  );
}

describe("secret reference → environment variable mapping", () => {
  const refs = defaultRefs();
  const expectedNames = Object.values(refs).map((ref) =>
    envVarName(parseSecretKey(ref), "MAESTRO_SECRET_"),
  );

  it("derives the names the driver will actually look up", () => {
    // Pins the encoding itself: `#field` becomes a DOUBLE underscore, which is
    // the detail a hand-written variable name gets wrong.
    expect(envVarName(parseSecretKey("kv/jira#token"), "MAESTRO_SECRET_")).toBe(
      "MAESTRO_SECRET_KV_JIRA__TOKEN",
    );
  });

  it("names every secret in .env.example exactly as the driver derives it", () => {
    const example = readFileSync(envExamplePath(), "utf8");
    for (const name of expectedNames) {
      expect(example, `${name} missing from .env.example`).toContain(name);
    }
  });

  it("passes those same names through compose to the containers", () => {
    const compose = readFileSync(composePath(), "utf8");
    for (const name of expectedNames) {
      expect(compose, `${name} not forwarded by compose.yaml`).toContain(name);
    }
  });

  it("puts no secret VALUE in compose.yaml — only references and pass-throughs", () => {
    const compose = readFileSync(composePath(), "utf8");
    for (const name of expectedNames) {
      // Every MAESTRO_SECRET_* line must be a `${VAR}` interpolation, never a
      // literal. A literal here would be a credential committed to the repo.
      // Assignments only; a comment naming the variable is documentation.
      for (const line of compose.split("\n")) {
        const match = new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`).exec(line);
        if (match === null) continue;
        expect(match[1]?.trim(), `compose.yaml assigns a literal to ${name}`).toMatch(/^\$\{.*\}$/);
      }
    }
  });

  /**
   * The comments have to be right too.
   *
   * `.env.example:178` documented `kv/jira#token → MAESTRO_SECRET_KV_JIRA_TOKEN`
   * — single underscore, wrong — five lines above a note explaining that the
   * name takes a DOUBLE underscore and that getting it wrong "looks set to an
   * operator and unset to the driver". The file refuted itself, and the tests
   * above missed it because they only looked at variable ASSIGNMENTS while the
   * mistake was in prose. An operator following the wrong sentence lands in
   * exactly the trap the right sentence describes.
   *
   * So: any `MAESTRO_SECRET_*` token anywhere in the file — assignment or
   * comment — must be a name the driver would actually derive, UNLESS it is
   * explicitly negated. The note deliberately quotes the wrong name after "and
   * not", and a warning that cannot name the thing it warns about is a weaker
   * warning; that is the one shape allowed to be wrong, and it has to say so.
   */
  it("spells every MAESTRO_SECRET_ name correctly, in prose as well as in assignments", () => {
    const example = readFileSync(envExamplePath(), "utf8");
    const wrong: string[] = [];

    for (const line of example.split("\n")) {
      for (const match of line.matchAll(/MAESTRO_SECRET_[A-Z0-9_]+/g)) {
        const name = match[0];
        // The bare prefix is the schema's own, not a secret name.
        if (name === "MAESTRO_SECRET_") continue;
        if (expectedNames.includes(name)) continue;
        // A counter-example must be marked as one, on its own line.
        if (/\band not\b/.test(line) || /\bnot\b\s*$/.test(line.slice(0, match.index))) continue;
        wrong.push(`${name} (in: ${line.trim()})`);
      }
    }

    expect(wrong, "a MAESTRO_SECRET_ name the driver would never look up").toEqual([]);
  });

  /**
   * The negative example is load-bearing: it is what makes the double
   * underscore visible. If it disappears the rule above silently gets easier.
   */
  it("keeps the wrong name in the file only as an explicit counter-example", () => {
    const example = readFileSync(envExamplePath(), "utf8");
    const lines = example.split("\n").filter((line) => line.includes("MAESTRO_SECRET_KV_JIRA_TOKEN"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/not/);
  });

  it("keeps every *_REF default a pointer rather than a credential", () => {
    for (const [name, ref] of Object.entries(refs)) {
      // A reference has the shape mount/path#field and is safe to commit; a
      // value would not parse as one.
      expect(() => parseSecretKey(ref), `${name} is not a secret reference`).not.toThrow();
      expect(ref).toMatch(/^[a-z0-9]+\/[^#]+#.+$/);
    }
  });
});
