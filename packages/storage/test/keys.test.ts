import { describe, expect, it } from "vitest";
import { InvalidKeyError } from "../src/errors.js";
import {
  archiveKey,
  assertValidKey,
  assertValidPrefix,
  encodeTagging,
  evidenceKey,
  evidenceTicketPrefix,
  parseEvidenceKey,
  RETENTION_YEARS_DEFAULT,
  retainUntil,
  retentionClassForKey,
  retentionPolicy,
  retentionTags,
} from "../src/keys.js";

const CREATED_AT = "2026-08-08T09:00:00.000Z";

describe("evidence key scheme (M34/M56)", () => {
  it("puts the year first so a lifecycle rule can expire one vintage", () => {
    expect(
      evidenceKey({
        ticketKey: "UGURPAY-4312",
        runId: "run-01H8ZQXYZ",
        fileName: "analysis.json",
        createdAt: CREATED_AT,
      }),
    ).toBe("evidence/2026/UGURPAY-4312/run-01H8ZQXYZ/analysis.json");
  });

  it("derives the year in UTC, not local time", () => {
    const key = evidenceKey({
      ticketKey: "UGURPAY-1",
      runId: "run-01H8ZQXYZ",
      fileName: "a.json",
      createdAt: "2026-12-31T23:30:00+03:00",
    });
    expect(key.startsWith("evidence/2026/")).toBe(true);
  });

  it("round-trips through parseEvidenceKey", () => {
    const input = {
      ticketKey: "UGURPAY-4312",
      runId: "run-01H8ZQXYZ",
      fileName: "diff.patch",
      createdAt: CREATED_AT,
    };
    expect(parseEvidenceKey(evidenceKey(input))).toEqual({
      year: 2026,
      ticketKey: "UGURPAY-4312",
      runId: "run-01H8ZQXYZ",
      fileName: "diff.patch",
    });
  });

  it("does not parse foreign keys", () => {
    expect(parseEvidenceKey("archive/2026/UGURPAY-1/a.json")).toBeUndefined();
    expect(parseEvidenceKey("evidence/20xx/UGURPAY-1/run/a.json")).toBeUndefined();
    expect(parseEvidenceKey("evidence/2026/lowercase-1/run/a.json")).toBeUndefined();
  });

  it("rejects ticket keys, run ids and file names that would escape the scheme", () => {
    const base = {
      ticketKey: "UGURPAY-1",
      runId: "run-01H8ZQXYZ",
      fileName: "a.json",
      createdAt: CREATED_AT,
    };
    expect(() => evidenceKey({ ...base, fileName: "../../etc/passwd" })).toThrow();
    expect(() => evidenceKey({ ...base, fileName: "a/b.json" })).toThrow();
    expect(() => evidenceKey({ ...base, ticketKey: "ugurpay-1" })).toThrow();
    expect(() => evidenceKey({ ...base, runId: "short" })).toThrow();
  });

  it.each([
    ["test-report (junit).xml"],
    ["rapor özet.pdf"],
    ["análisis.md"],
    ["_hidden.txt"],
    ["kanıt & özet %100.json"],
    ["already%20encoded.txt"],
  ])("accepts and round-trips a contract-legal file name: %s", (fileName) => {
    const key = evidenceKey({
      ticketKey: "UGURPAY-4312",
      runId: "run-01H8ZQXYZ",
      fileName,
      createdAt: CREATED_AT,
    });
    expect(key.split("/")).toHaveLength(5);
    expect(() => assertValidKey(key)).not.toThrow();
    expect(parseEvidenceKey(key)?.fileName).toBe(fileName);
  });

  it("round-trips the shortest run id the contract allows", () => {
    const runId = "R1234567";
    const key = evidenceKey({
      ticketKey: "UGURPAY-1",
      runId,
      fileName: "a.json",
      createdAt: CREATED_AT,
    });
    expect(parseEvidenceKey(key)?.runId).toBe(runId);
  });

  it("keeps a percent-encoded file name inside one segment", () => {
    const key = evidenceKey({
      ticketKey: "UGURPAY-1",
      runId: "run-01H8ZQXYZ",
      fileName: "a b-c.json",
      createdAt: CREATED_AT,
    });
    expect(key).toBe("evidence/2026/UGURPAY-1/run-01H8ZQXYZ/a%20b-c.json");
  });

  it("still refuses what cannot live inside one segment", () => {
    const base = { ticketKey: "UGURPAY-1", runId: "run-01H8ZQXYZ", createdAt: CREATED_AT };
    expect(() => evidenceKey({ ...base, fileName: "a/b.json" })).toThrow();
    expect(() => evidenceKey({ ...base, fileName: "a\u0007b.json" })).toThrow();
    expect(() => evidenceKey({ ...base, fileName: "" })).toThrow();
    expect(() => evidenceKey({ ...base, fileName: ".." })).toThrow();
  });

  it("does not parse a key whose file name is not decodable", () => {
    expect(parseEvidenceKey("evidence/2026/UGURPAY-1/run-01H8ZQXYZ/%E0%A4%A.json")).toBeUndefined();
  });

  it("refuses to build a listing prefix for a year that is not four digits", () => {
    expect(() => evidenceTicketPrefix("UGURPAY-1", 12)).toThrow();
    expect(() => evidenceTicketPrefix("UGURPAY-1", 20260)).toThrow();
  });

  it("builds a listing prefix that matches its own keys", () => {
    const key = evidenceKey({
      ticketKey: "UGURPAY-4312",
      runId: "run-01H8ZQXYZ",
      fileName: "a.json",
      createdAt: CREATED_AT,
    });
    expect(key.startsWith(evidenceTicketPrefix("UGURPAY-4312", 2026))).toBe(true);
  });

  it("builds workspace archive keys for M65", () => {
    expect(archiveKey({ ticketKey: "UGURPAY-1", fileName: "session.tar", createdAt: CREATED_AT })).toBe(
      "archive/2026/UGURPAY-1/session.tar",
    );
  });
});

describe("key safety", () => {
  it.each([
    "evidence/2026/UGURPAY-1/run/a.json",
    "a.json",
    "a/b/c/d~e.json",
    "tenant-a/evidence/x.bin",
  ])("accepts a safe key: %s", (key) => {
    expect(() => assertValidKey(key)).not.toThrow();
  });

  it.each([
    "",
    "/absolute",
    "trailing/",
    "double//slash",
    "..",
    "a/../b",
    "a/./b",
    "back\\slash",
    "x".repeat(1025),
  ])("rejects an unsafe key: %s", (key) => {
    expect(() => assertValidKey(key)).toThrow(InvalidKeyError);
  });

  it("measures the length limit in bytes, not characters", () => {
    expect(() => assertValidKey("ç".repeat(513))).toThrow(InvalidKeyError);
    expect(() => assertValidKey("ç".repeat(512))).not.toThrow();
  });

  it("accepts an empty prefix and a prefix ending in a separator", () => {
    expect(() => assertValidPrefix("")).not.toThrow();
    expect(() => assertValidPrefix("evidence/2026/")).not.toThrow();
    expect(() => assertValidPrefix("../secrets/")).toThrow(InvalidKeyError);
  });
});

describe("retention policy (M56)", () => {
  it("defaults to ten years", () => {
    expect(RETENTION_YEARS_DEFAULT).toBe(10);
    expect(retentionPolicy("evidence").retentionYears).toBe(10);
  });

  it("adds the retention years in UTC", () => {
    expect(retainUntil("2026-08-08T09:00:00.000Z")).toBe("2036-08-08T09:00:00.000Z");
    expect(retainUntil("2026-08-08T09:00:00.000Z", 1)).toBe("2027-08-08T09:00:00.000Z");
  });

  it("never shortens retention for a 29 February start", () => {
    const until = retainUntil("2024-02-29T00:00:00.000Z", 10);
    expect(new Date(until).getTime()).toBeGreaterThanOrEqual(
      new Date("2034-02-28T00:00:00.000Z").getTime(),
    );
  });

  it("rejects a non-positive retention", () => {
    expect(() => retainUntil("2026-08-08T09:00:00.000Z", 0)).toThrow();
  });

  it("keeps knowledge objects hot far longer than evidence", () => {
    expect(retentionPolicy("knowledge").archiveAfterDays).toBeGreaterThan(
      retentionPolicy("evidence").archiveAfterDays,
    );
  });

  it("derives the class from the key layout, not from the deployment (M65)", () => {
    expect(retentionClassForKey("archive/2026/UGURPAY-1/session.tar", "evidence")).toBe("archive");
    expect(retentionClassForKey("evidence/2026/UGURPAY-1/run/a.json", "archive")).toBe("evidence");
    expect(retentionClassForKey("knowledge/a.md", "evidence")).toBe("knowledge");
    expect(retentionClassForKey("scratch/x.bin", "evidence")).toBe("evidence");
  });

  it("encodes tags as an url-encoded tag set", () => {
    expect(encodeTagging(retentionTags(retentionPolicy("journal")))).toBe(
      "maestro-class=journal&maestro-retention-years=10&maestro-archive-after-days=90",
    );
    expect(encodeTagging({ "a b": "c&d" })).toBe("a%20b=c%26d");
  });
});
