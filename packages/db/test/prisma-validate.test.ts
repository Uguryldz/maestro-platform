import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT, SCHEMA_PATH } from "./paths.js";

/**
 * Runs the real Prisma CLI over the committed schema. Offline: `validate`
 * never opens a connection, so the URL below is a placeholder that only has
 * to satisfy `env("DATABASE_URL")`.
 */
const PLACEHOLDER_URL = "postgresql://placeholder:placeholder@localhost:5432/maestro";
const PRISMA_BIN = join(PACKAGE_ROOT, "node_modules/.bin/prisma");

describe("prisma validate", () => {
  it("accepts the committed schema", () => {
    const result = spawnSync(PRISMA_BIN, ["validate", "--schema", SCHEMA_PATH], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: PLACEHOLDER_URL,
        CHECKPOINT_DISABLE: "1", // no version-check network call
        PRISMA_HIDE_UPDATE_MESSAGE: "true",
      },
    });

    expect(result.error).toBeUndefined();
    expect(`${result.stdout}${result.stderr}`).toContain("is valid");
    expect(result.status).toBe(0);
  }, 60_000);
});
