import { defaultPiiPolicy, loadPiiPolicy, PiiLeakError, type MaskCounts } from "@maestro/pii";
import { describe, expect, it } from "vitest";
import { createJournalMasker, type Journaled } from "../src/masking.js";
import { RUN_ID, SAMPLE_EMAIL, testMasker } from "./fakes/support.js";

const IDENTITY = {
  runId: RUN_ID,
  seq: 3,
  at: "2026-08-08T10:00:00+03:00",
  actor: "ai",
  kind: "analysis",
} as const;

describe("createJournalMasker", () => {
  it("masks the free text and seals a contract-valid entry", () => {
    const masker = testMasker();
    const text = masker.prepare({ title: `mail ${SAMPLE_EMAIL}`, detail: "" });
    const entry = masker.seal(IDENTITY, text);

    expect(entry.title).toMatch(/^mail \[EMAIL_1\.[0-9a-f]+\]$/);
    expect(entry.seq).toBe(3);
    expect(entry.detail).toBe("");
  });

  it("reports counts to the audit hook and never values (M33)", () => {
    const seen: MaskCounts[] = [];
    const masker = testMasker((counts) => seen.push(counts));
    masker.prepare({ title: `a ${SAMPLE_EMAIL} b ${SAMPLE_EMAIL}`, detail: SAMPLE_EMAIL });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.occurrences).toBe(3);
    expect(JSON.stringify(seen)).not.toContain(SAMPLE_EMAIL);
  });

  it("falls back to the strictest class for an unusable data class", () => {
    const masker = createJournalMasker({
      policy: loadPiiPolicy(defaultPiiPolicy()),
      dataClass: "not-a-class",
    });
    expect(masker.dataClass).toBe("gizli");
  });

  it("trips at runtime when raw PII is smuggled past the type", () => {
    const masker = testMasker();
    // A caller that casts its way around the brand still cannot get raw PII in.
    const forged = { title: `mail ${SAMPLE_EMAIL}`, detail: "" } as Journaled<{
      title: string;
      detail: string;
    }>;
    expect(() => masker.seal(IDENTITY, forged)).toThrow(PiiLeakError);
  });

  it("refuses to seal an entry the contract would not accept", () => {
    const masker = testMasker();
    const text = masker.prepare({ title: "ok", detail: "" });
    expect(() => masker.seal({ ...IDENTITY, seq: -1 }, text)).toThrow();
    expect(() => masker.seal({ ...IDENTITY, runId: "no" }, text)).toThrow();
  });

  it("masks standalone strings and leaves already-masked text alone", () => {
    const masker = testMasker();
    const once = masker.text(`write to ${SAMPLE_EMAIL}`);
    // The token carries a per-session nonce (pii B-8/B-9), so match its shape.
    expect(once).toMatch(/^write to \[EMAIL_1\.[0-9a-f]+\]$/);
    expect(masker.text(once)).toBe(once);
  });

  it("does not accept unmasked text where masked text is required", () => {
    const masker = testMasker();
    // Two independent refusals: the brand keeps a bare object out at compile
    // time, and `assertNoPii` keeps its contents out at runtime.
    expect(() =>
      // @ts-expect-error — a bare object is not `Journaled`; only the masker mints it.
      masker.seal(IDENTITY, { title: `mail ${SAMPLE_EMAIL}`, detail: "" }),
    ).toThrow(PiiLeakError);
  });

  it("keeps one masking session for its whole lifetime, not one per call", () => {
    // The same value must carry the same token in every entry a run writes —
    // that is what makes a ten-year journal readable — and re-masking an
    // already-masked entry must be a no-op rather than a second round of
    // tokens. Both follow from the session living as long as the masker.
    const masker = testMasker();
    const first = masker.prepare({ title: `a ${SAMPLE_EMAIL}`, detail: "" });
    const second = masker.text(`later, ${SAMPLE_EMAIL} again`);
    const token = /\[EMAIL_1\.[0-9a-f]+\]/.exec(first.title)?.[0] as string;
    expect(second).toContain(token);
    expect(masker.text(second)).toBe(second);
    // A different masker is a different session, so its tokens differ.
    expect(testMasker().text(`x ${SAMPLE_EMAIL}`)).not.toContain(token);
  });

  it("keeps the reverse map out of everything it returns (M20/M82)", () => {
    const masker = testMasker();
    const text = masker.prepare({ title: SAMPLE_EMAIL, detail: SAMPLE_EMAIL });
    const entry = masker.seal(IDENTITY, text);
    expect(Object.keys(entry).sort()).toEqual(["actor", "at", "detail", "kind", "runId", "seq", "title"]);
  });
});
