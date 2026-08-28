import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANALYSIS_TEMPLATE_NAME,
  DEFAULT_ANALYSIS_TEMPLATE_SECTIONS,
} from "../src/template-defaults.js";
import { seedAnalysisTemplate } from "../src/seed-template.js";

/**
 * The default analysis template (M108) and its one-time seed.
 *
 * Two things are being defended here. The first is that the seed is a REAL
 * template: a fresh install that published "Örnek bölüm 1" would be showing a
 * bank fabricated configuration, which is worse than the empty screen it
 * replaced. The second is that the seed never walks over a bank's own work —
 * `AnalysisTemplateVersion` is append-only, so re-running the installer against
 * a published version 4 must leave it alone.
 */

/**
 * The server's own slug function, copied from
 * `apps/bff/src/template-service.ts`. Copied rather than imported because
 * `@maestro/db` must not depend on the BFF; `template-service.ts` documents the
 * same duplication against Studio's copy for the same reason. The test's job is
 * to prove the KEYS in the seed are the ones this function derives, so a title
 * edited without its key fails here instead of producing a template whose
 * generated schema silently drops a section.
 */
const TR_FOLD: Readonly<Record<string, string>> = {
  ç: "c", Ç: "c", ğ: "g", Ğ: "g", ı: "i", I: "i", İ: "i",
  ö: "o", Ö: "o", ş: "s", Ş: "s", ü: "u", Ü: "u",
};
const TR_FOLD_RE = /[çÇğĞıIİöÖşŞüÜ]/g;

function slugify(title: string): string {
  return title
    .replace(TR_FOLD_RE, (ch) => TR_FOLD[ch] ?? ch)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

describe("the shipped analysis template", () => {
  it("has a name and at least the five sections a change record needs", () => {
    expect(DEFAULT_ANALYSIS_TEMPLATE_NAME.trim().length).toBeGreaterThan(0);
    expect(DEFAULT_ANALYSIS_TEMPLATE_SECTIONS.length).toBeGreaterThanOrEqual(5);
  });

  it("covers purpose, scope, impact, risk and acceptance", () => {
    const keys = DEFAULT_ANALYSIS_TEMPLATE_SECTIONS.map((s) => s.key);
    expect(keys).toContain("amac_ve_gerekce");
    expect(keys).toContain("kapsam");
    expect(keys).toContain("etki_analizi");
    expect(keys).toContain("riskler_ve_onlemler");
    expect(keys).toContain("test_ve_kabul_kriterleri");
  });

  it("derives every key from its own title", () => {
    for (const section of DEFAULT_ANALYSIS_TEMPLATE_SECTIONS) {
      expect(section.key).toBe(slugify(section.title));
    }
  });

  it("has unique keys — a collision would silently merge two sections", () => {
    const keys = DEFAULT_ANALYSIS_TEMPLATE_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every section a real AI instruction, not a placeholder", () => {
    for (const section of DEFAULT_ANALYSIS_TEMPLATE_SECTIONS) {
      // Short strings are the tell for "TODO" / "Örnek": a genuine instruction
      // tells the model what to write AND what to do when it cannot.
      expect(section.aiInstruction.length).toBeGreaterThan(80);
      expect(section.title.trim().length).toBeGreaterThan(0);
      expect(section.description.trim().length).toBeGreaterThan(0);
      expect(section.example.trim().length).toBeGreaterThan(0);
    }
  });

  it("uses only the four formats the designer offers", () => {
    const allowed = new Set(["free_text", "bullet_list", "table", "impact_matrix"]);
    for (const section of DEFAULT_ANALYSIS_TEMPLATE_SECTIONS) {
      expect(allowed.has(section.format)).toBe(true);
    }
  });

  it("marks the sections a gate depends on as required", () => {
    const required = DEFAULT_ANALYSIS_TEMPLATE_SECTIONS.filter((s) => s.required).map((s) => s.key);
    expect(required).toContain("etki_analizi");
    expect(required).toContain("riskler_ve_onlemler");
    expect(required).toContain("test_ve_kabul_kriterleri");
  });
});

interface FakeRow {
  version: number;
  name: string;
  sectionsJson: unknown;
  publishedBy: string;
  publishedAt: Date;
}

function fakeDb(rows: FakeRow[]) {
  return {
    analysisTemplateVersion: {
      findFirst: () =>
        Promise.resolve([...rows].sort((a, b) => b.version - a.version)[0] ?? null),
      create: ({ data }: { data: FakeRow }) => {
        if (rows.some((r) => r.version === data.version)) {
          return Promise.reject(new Error("unique violation"));
        }
        rows.push(data);
        return Promise.resolve(data);
      },
    },
  } as never;
}

describe("seedAnalysisTemplate", () => {
  it("publishes version 1 into an empty table", async () => {
    const rows: FakeRow[] = [];
    const result = await seedAnalysisTemplate(fakeDb(rows), {
      now: new Date("2026-08-01T09:00:00.000Z"),
    });

    expect(result.seeded).toBe(true);
    expect(result.sections).toBe(DEFAULT_ANALYSIS_TEMPLATE_SECTIONS.length);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.publishedBy).toBe("installer");
  });

  it("does NOT overwrite a template the bank has already published", async () => {
    const rows: FakeRow[] = [
      {
        version: 4,
        name: "Bankanın kendi şablonu",
        sectionsJson: [],
        publishedBy: "ayse.kaya@bank",
        publishedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ];

    const result = await seedAnalysisTemplate(fakeDb(rows));

    expect(result.seeded).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Bankanın kendi şablonu");
  });

  it("is idempotent across repeated installer runs", async () => {
    const rows: FakeRow[] = [];
    const db = fakeDb(rows);
    await seedAnalysisTemplate(db);
    await seedAnalysisTemplate(db);
    await seedAnalysisTemplate(db);
    expect(rows).toHaveLength(1);
  });

  it("treats a lost INSERT race as already-seeded rather than failing the install", async () => {
    let firstRead = true;
    const racing = {
      analysisTemplateVersion: {
        findFirst: () => {
          // Empty on the pre-check, occupied by the time the failure is
          // investigated — exactly what the losing installer observes.
          if (firstRead) {
            firstRead = false;
            return Promise.resolve(null);
          }
          return Promise.resolve({ version: 1 });
        },
        create: () => Promise.reject(new Error("unique violation")),
      },
    } as never;

    await expect(seedAnalysisTemplate(racing)).resolves.toEqual({ seeded: false, sections: 0 });
  });

  it("rethrows a real write failure instead of reporting a template nobody has", async () => {
    const broken = {
      analysisTemplateVersion: {
        findFirst: () => Promise.resolve(null),
        create: () => Promise.reject(new Error("connection refused")),
      },
    } as never;

    await expect(seedAnalysisTemplate(broken)).rejects.toThrow(/connection refused/);
  });
});
