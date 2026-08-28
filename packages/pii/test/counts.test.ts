import { AuditAction } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  createSession,
  defaultPiiPolicy,
  EMPTY_COUNTS,
  maskValue,
  toAuditMeta,
  type MaskProfile,
} from "../src/index.js";
import { SAMPLE_TCKN, SAMPLE_TR_IBAN } from "./synthetic.js";

const PROFILE: MaskProfile = {
  ...defaultPiiPolicy().profiles.gizli,
  fieldRules: ["customerName"],
};

describe("audit counters (M33 PII_MASKED)", () => {
  it("separates occurrences from fields", () => {
    const { counts } = maskValue(
      {
        summary: `TCKN ${SAMPLE_TCKN} ve IBAN ${SAMPLE_TR_IBAN}`,
        customerName: "Ayse Yilmaz",
        note: "temiz",
      },
      createSession(PROFILE),
    );
    expect(counts.occurrences).toBe(3);
    expect(counts.fields).toBe(2);
    expect(counts.byType).toEqual({ iban: 1, tckn: 1, field: 1 });
  });

  it("reports zero for a clean payload", () => {
    const { counts } = maskValue({ note: "temiz" }, createSession(PROFILE));
    expect(counts).toEqual(EMPTY_COUNTS);
  });

  it("produces audit meta that carries no value, only numbers and type names", () => {
    const { counts } = maskValue(
      { summary: `TCKN ${SAMPLE_TCKN}`, customerName: "Ayse Yilmaz" },
      createSession(PROFILE),
    );
    const meta = toAuditMeta(counts);
    expect(meta).toEqual({
      maskedOccurrences: 2,
      maskedFields: 2,
      maskedTypes: ["tckn", "field"],
    });
    const serialised = JSON.stringify(meta);
    expect(serialised).not.toContain(SAMPLE_TCKN);
    expect(serialised).not.toContain("Ayse");
  });

  it("names an action the audit contract actually has", () => {
    // ID consistency: the producer of this meta and the audit chain that
    // consumes it must agree on the action name.
    expect(AuditAction.options).toContain("PII_MASKED");
  });
});
