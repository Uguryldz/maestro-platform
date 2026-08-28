import { describe, expect, it } from "vitest";
import { classifyChangeTypes } from "../src/change-type.js";

/**
 * B11 — special change types. `classifyChangeTypes` is what turns "this ticket
 * touches a migration" into the engineer guardrails and the reviewer note. The
 * tests pin: each type is caught from natural TR/EN ticket wording, an ordinary
 * ticket matches nothing, and every match carries at least one guardrail rule.
 */

describe("classifyChangeTypes", () => {
  it("detects a DB migration from schema-change wording", () => {
    const m = classifyChangeTypes(["Müşteri tablosuna yeni kolon eklenecek (ALTER TABLE)."]);
    expect(m.map((x) => x.type)).toContain("migration");
  });

  it("detects a feature flag", () => {
    const m = classifyChangeTypes(["Yeni ödeme akışı feature flag ile kademeli açılacak."]);
    expect(m.map((x) => x.type)).toContain("feature_flag");
  });

  it("detects a config change", () => {
    const m = classifyChangeTypes(["Zaman aşımı süresi ortam değişkeni (env var) ile ayarlanacak."]);
    expect(m.map((x) => x.type)).toContain("config");
  });

  it("detects a dependency bump", () => {
    const m = classifyChangeTypes(["axios kütüphane sürümü güvenlik yaması için yükseltilecek."]);
    expect(m.map((x) => x.type)).toContain("dependency");
  });

  it("detects more than one type in the same ticket", () => {
    const m = classifyChangeTypes([
      "Migration ile yeni tablo açılıp yeni davranış feature flag arkasında verilecek.",
    ]);
    const types = m.map((x) => x.type);
    expect(types).toContain("migration");
    expect(types).toContain("feature_flag");
  });

  it("matches nothing for an ordinary UI change", () => {
    const m = classifyChangeTypes([
      "Ödeme ekranında Öde butonunun hizası mobilde bozuk, düzeltilecek.",
    ]);
    expect(m).toEqual([]);
  });

  it("every match carries at least one engineer rule and a note", () => {
    const m = classifyChangeTypes(["ALTER TABLE ile göç yapılacak, config env var eklenecek."]);
    expect(m.length).toBeGreaterThan(0);
    for (const match of m) {
      expect(match.rules.length).toBeGreaterThan(0);
      expect(match.note.length).toBeGreaterThan(0);
      expect(match.label.length).toBeGreaterThan(0);
    }
  });
});
