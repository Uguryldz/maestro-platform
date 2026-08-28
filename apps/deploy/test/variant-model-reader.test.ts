import { describe, expect, it } from "vitest";
import {
  PrismaVariantModelReader,
  type VariantVersionModelDelegate,
  type VariantVersionModelRow,
} from "../src/stores/variant-model-reader.js";

/**
 * `PrismaVariantModelReader` — the pilot's `VariantModelReader` port over
 * Postgres (M38). These pin the reader's contract against a fake that behaves
 * like the `VariantVersion` table, so no live database is needed:
 *
 *  · the ACTIVE (highest-numbered) version's model is what a variant runs under;
 *  · a variant with no published version answers `null` (a real answer the pilot
 *    falls back on), and so does a version whose model is blank/whitespace;
 *  · a THROWING delegate (Postgres unreachable) propagates — the pilot must not
 *    silently boot on the env default when the DB is misconfigured.
 */

function fakeVersions(rows: VariantVersionModelRow[] | Error): VariantVersionModelDelegate {
  return {
    findMany: ({ where, orderBy, select }) => {
      // The reader must ask for exactly what it declares — newest first, just
      // the columns it needs — so the query stays a narrow index read.
      expect(orderBy).toEqual({ version: "desc" });
      expect(select).toEqual({ version: true, model: true, configJson: true });
      if (rows instanceof Error) return Promise.reject(rows);
      const matched = rows
        .filter(() => true)
        .slice()
        .sort((a, b) => b.version - a.version);
      void where;
      return Promise.resolve(matched);
    },
  };
}

/** A row helper defaulting configJson to an empty object (no persona). */
function row(version: number, model: string, configJson: unknown = {}): VariantVersionModelRow {
  return { version, model, configJson };
}

describe("PrismaVariantModelReader.activeModel", () => {
  it("returns the newest version's model (the active one)", async () => {
    const reader = new PrismaVariantModelReader(
      fakeVersions([
        row(1, "openai/gpt-4o-mini"),
        row(3, "anthropic/claude-x"),
        row(2, "openai/gpt-4o"),
      ]),
    );
    expect(await reader.activeModel("analyst-default")).toBe("anthropic/claude-x");
  });

  it("returns null when the variant has no published version", async () => {
    const reader = new PrismaVariantModelReader(fakeVersions([]));
    expect(await reader.activeModel("ghost")).toBeNull();
  });

  it("returns null (not a blank model) when the active version's model is empty", async () => {
    const reader = new PrismaVariantModelReader(
      fakeVersions([row(5, "   ")]),
    );
    expect(await reader.activeModel("analyst-default")).toBeNull();
  });

  it("trims the model the caller binds a role to", async () => {
    const reader = new PrismaVariantModelReader(
      fakeVersions([row(2, "  openai/gpt-4o  ")]),
    );
    expect(await reader.activeModel("analyst-default")).toBe("openai/gpt-4o");
  });

  it("propagates a throwing delegate rather than swallowing it", async () => {
    const reader = new PrismaVariantModelReader(fakeVersions(new Error("db unreachable")));
    await expect(reader.activeModel("analyst-default")).rejects.toThrow(/db unreachable/);
  });
});

describe("PrismaVariantModelReader.activePersona", () => {
  it("returns the newest version's persona from configJson", async () => {
    const reader = new PrismaVariantModelReader(
      fakeVersions([
        row(1, "m", { persona: "eski" }),
        row(3, "m", { persona: "Sen analiz ajanısın; risk odaklı incele." }),
        row(2, "m", { persona: "orta" }),
      ]),
    );
    expect(await reader.activePersona("analyst-default")).toBe(
      "Sen analiz ajanısın; risk odaklı incele.",
    );
  });

  it("returns null when the active version has no persona", async () => {
    const reader = new PrismaVariantModelReader(fakeVersions([row(1, "m", {})]));
    expect(await reader.activePersona("analyst-default")).toBeNull();
  });

  it("returns null (not blank) when the persona is empty/whitespace", async () => {
    const reader = new PrismaVariantModelReader(fakeVersions([row(1, "m", { persona: "  " })]));
    expect(await reader.activePersona("analyst-default")).toBeNull();
  });

  it("returns null when there is no published version", async () => {
    const reader = new PrismaVariantModelReader(fakeVersions([]));
    expect(await reader.activePersona("ghost")).toBeNull();
  });
});
