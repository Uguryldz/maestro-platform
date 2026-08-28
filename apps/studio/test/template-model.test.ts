import { describe, expect, it } from "vitest";
import {
  addSection,
  canRemoveSection,
  keysAreUnique,
  moveSection,
  removeSection,
  slugify,
  toDraftSections,
  toWireSections,
  uniqueKey,
  updateSection,
  type TemplateDraft,
  type TemplateSection,
} from "../src/screens/template/model.ts";

function section(title: string, key: string): TemplateSection {
  return {
    key,
    title,
    description: "",
    aiInstruction: "",
    required: true,
    format: "free_text",
    example: "",
  };
}

function draftOf(...titles: readonly string[]): TemplateDraft {
  const sections = toDraftSections(titles.map((t) => section(t, slugify(t))));
  return { name: "Kurumsal", version: 3, sections, selectedId: sections[0]?.id ?? null };
}

const NEW = { title: "Yeni bölüm", aiInstruction: "talimat" };

describe("slugify", () => {
  it("folds Turkish letters instead of dropping them", () => {
    expect(slugify("Kapsam (dahil / hariç)")).toBe("kapsam_dahil_haric");
    expect(slugify("Işık ölçümü")).toBe("isik_olcumu");
    expect(slugify("Ürün Şablonu")).toBe("urun_sablonu");
  });

  it("collapses punctuation and trims separators", () => {
    expect(slugify("  Amaç / iş değeri!!  ")).toBe("amac_is_degeri");
  });

  it("never returns a leading or trailing underscore", () => {
    const slug = slugify("--- risk ---");
    expect(slug).toBe("risk");
  });
});

describe("uniqueKey", () => {
  it("returns the base when it is free", () => {
    expect(uniqueKey("kapsam", ["amac"])).toBe("kapsam");
  });

  it("suffixes until it finds a free key", () => {
    expect(uniqueKey("kapsam", ["kapsam"])).toBe("kapsam_2");
    expect(uniqueKey("kapsam", ["kapsam", "kapsam_2"])).toBe("kapsam_3");
  });

  it("falls back to a usable key when the title slugifies to nothing", () => {
    expect(uniqueKey("", [])).toBe("bolum");
    expect(uniqueKey("", ["bolum"])).toBe("bolum_2");
  });
});

describe("addSection", () => {
  it("appends and selects the new section", () => {
    const before = draftOf("Amaç");
    const after = addSection(before, NEW);
    expect(after.sections).toHaveLength(2);
    expect(after.sections[1]?.title).toBe("Yeni bölüm");
    expect(after.selectedId).toBe(after.sections[1]?.id);
  });

  it("does not mutate the previous draft", () => {
    const before = draftOf("Amaç");
    addSection(before, NEW);
    expect(before.sections).toHaveLength(1);
  });

  it("gives repeated additions distinct keys", () => {
    let draft = draftOf("Amaç");
    draft = addSection(draft, NEW);
    draft = addSection(draft, NEW);
    draft = addSection(draft, NEW);
    expect(draft.sections.map((s) => s.key)).toEqual([
      "amac",
      "yeni_bolum",
      "yeni_bolum_2",
      "yeni_bolum_3",
    ]);
    expect(keysAreUnique(draft.sections)).toBe(true);
  });
});

describe("removeSection", () => {
  it("removes the section and keeps the rest in order", () => {
    const draft = draftOf("Amaç", "Kapsam", "Risk");
    const target = draft.sections[1]!;
    const after = removeSection(draft, target.id);
    expect(after.sections.map((s) => s.title)).toEqual(["Amaç", "Risk"]);
  });

  it("moves the selection to a surviving section when the selected one goes", () => {
    const draft = draftOf("Amaç", "Kapsam", "Risk");
    const target = draft.sections[1]!;
    const after = removeSection({ ...draft, selectedId: target.id }, target.id);
    const stillThere = after.sections.some((s) => s.id === after.selectedId);
    expect(after.selectedId).not.toBe(target.id);
    expect(stillThere).toBe(true);
  });

  it("keeps a selection that was not the removed section", () => {
    const draft = draftOf("Amaç", "Kapsam", "Risk");
    const keep = draft.sections[0]!;
    const after = removeSection({ ...draft, selectedId: keep.id }, draft.sections[2]!.id);
    expect(after.selectedId).toBe(keep.id);
  });

  it("refuses to remove the last section", () => {
    const draft = draftOf("Amaç");
    expect(canRemoveSection(draft)).toBe(false);
    expect(removeSection(draft, draft.sections[0]!.id)).toBe(draft);
  });

  it("leaves the draft alone for an unknown id", () => {
    const draft = draftOf("Amaç", "Kapsam");
    expect(removeSection(draft, "nope")).toBe(draft);
  });
});

describe("moveSection", () => {
  it("moves a section down and keeps every section", () => {
    const draft = draftOf("Amaç", "Kapsam", "Risk");
    const after = moveSection(draft, draft.sections[0]!.id, 1);
    expect(after.sections.map((s) => s.title)).toEqual(["Kapsam", "Amaç", "Risk"]);
    expect(after.sections).toHaveLength(3);
  });

  it("moves a section up", () => {
    const draft = draftOf("Amaç", "Kapsam", "Risk");
    const after = moveSection(draft, draft.sections[2]!.id, -1);
    expect(after.sections.map((s) => s.title)).toEqual(["Amaç", "Risk", "Kapsam"]);
  });

  it("is a no-op past either end and loses nothing", () => {
    const draft = draftOf("Amaç", "Kapsam");
    expect(moveSection(draft, draft.sections[0]!.id, -1)).toBe(draft);
    expect(moveSection(draft, draft.sections[1]!.id, 1)).toBe(draft);
  });

  it("keeps keys unique and content intact after reordering", () => {
    let draft = draftOf("Amaç", "Kapsam", "Risk");
    draft = updateSection(draft, draft.sections[1]!.id, "example", "örnek metin");
    const movedId = draft.sections[1]!.id;
    draft = moveSection(draft, movedId, -1);
    const moved = draft.sections.find((s) => s.id === movedId);
    expect(moved?.example).toBe("örnek metin");
    expect(moved?.key).toBe("kapsam");
    expect(keysAreUnique(draft.sections)).toBe(true);
  });
});

describe("updateSection", () => {
  it("edits one field of one section only", () => {
    const draft = draftOf("Amaç", "Kapsam");
    const after = updateSection(draft, draft.sections[0]!.id, "required", false);
    expect(after.sections[0]?.required).toBe(false);
    expect(after.sections[1]?.required).toBe(true);
  });

  it("re-derives the key when the title changes", () => {
    const draft = draftOf("Amaç");
    const after = updateSection(draft, draft.sections[0]!.id, "title", "Risk ve geri dönüş");
    expect(after.sections[0]?.key).toBe("risk_ve_geri_donus");
  });

  it("prevents a renamed title from colliding with another section's key", () => {
    const draft = draftOf("Amaç", "Kapsam");
    const after = updateSection(draft, draft.sections[1]!.id, "title", "Amaç");
    expect(after.sections[0]?.key).toBe("amac");
    expect(after.sections[1]?.key).toBe("amac_2");
    expect(keysAreUnique(after.sections)).toBe(true);
  });

  it("does not renumber a section against its own key when the title is unchanged", () => {
    const draft = draftOf("Amaç", "Kapsam");
    const after = updateSection(draft, draft.sections[0]!.id, "title", "Amaç");
    expect(after.sections[0]?.key).toBe("amac");
  });
});

describe("wire conversion", () => {
  it("strips the client-only id when sending back", () => {
    const draft = draftOf("Amaç", "Kapsam");
    const wire = toWireSections(draft.sections);
    for (const section of wire) {
      expect(section).not.toHaveProperty("id");
    }
    expect(wire.map((s) => s.key)).toEqual(["amac", "kapsam"]);
  });

  it("gives every section a distinct id when reading from the wire", () => {
    const sections = toDraftSections([section("Amaç", "amac"), section("Kapsam", "kapsam")]);
    expect(new Set(sections.map((s) => s.id)).size).toBe(2);
  });
});
