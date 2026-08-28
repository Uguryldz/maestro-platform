import { describe, expect, it } from "vitest";
import { MemoryArgumentError } from "../src/errors.js";
import { enrichLivingSummary } from "../src/enrich.js";
import { buildLivingSummary, SUMMARY_MAX_CHARS } from "../src/summary.js";
import { entry, RUN_ID, SAMPLE_EMAIL, testMasker } from "./fakes/support.js";

describe("enrichLivingSummary", () => {
  const entries = [entry({ seq: 0, kind: "intake", title: "ticket read" })];

  it("returns the deterministic summary when no enricher is configured", async () => {
    const enriched = await enrichLivingSummary(RUN_ID, entries);
    expect(enriched.text).toBe(buildLivingSummary(RUN_ID, entries).text);
  });

  it("appends the model note and masks it (M82)", async () => {
    const enriched = await enrichLivingSummary(RUN_ID, entries, {
      masker: testMasker(),
      enrich: async () => `the reporter is ${SAMPLE_EMAIL}`,
    });
    expect(enriched.text).toContain("## notes (model)");
    expect(enriched.text).toMatch(/\[EMAIL_1\.[0-9a-f]+\]/);
    expect(enriched.text).not.toContain(SAMPLE_EMAIL);
    // Everything the deterministic pass guaranteed is still there, first.
    expect(enriched.text.startsWith(buildLivingSummary(RUN_ID, entries).text)).toBe(true);
  });

  it("falls back to the deterministic summary when the model fails", async () => {
    const failures: unknown[] = [];
    const enriched = await enrichLivingSummary(RUN_ID, entries, {
      masker: testMasker(),
      enrich: async () => {
        throw new Error("gateway queued");
      },
      onEnrichFailed: (error) => failures.push(error),
    });
    expect(enriched.text).toBe(buildLivingSummary(RUN_ID, entries).text);
    expect(failures).toHaveLength(1);
  });

  it("clips a rambling model answer to the remaining budget", async () => {
    const enriched = await enrichLivingSummary(RUN_ID, entries, {
      masker: testMasker(),
      enrich: async () => "n".repeat(20000),
    });
    expect(enriched.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it("refuses to run a model pass without a masker", async () => {
    await expect(
      enrichLivingSummary(RUN_ID, entries, { enrich: async () => "note" }),
    ).rejects.toBeInstanceOf(MemoryArgumentError);
  });
});
