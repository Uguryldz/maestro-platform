import { describe, expect, it } from "vitest";
import {
  PrismaVariantWriter,
  type VariantConfigJson,
  type VariantRow,
  type VariantVersionRow,
} from "../src/stores/write-variants.js";

/**
 * `PrismaVariantWriter` — the variant WRITE side over Postgres (M38/M83).
 *
 * These pin the two promises the platform makes about agent configuration, the
 * SAME ones the in-memory store keeps, against a fake that behaves like the two
 * tables (a `Variant` row, its `VariantVersion` rows keyed by `(variantId,
 * version)`):
 *
 *  · a version is APPENDED, never mutated — an old version's model/persona are
 *    unchanged after a new one lands, and the sequence is `latest + 1`;
 *  · `publishedBy` and `publishedAt` are DERIVED from the caller's actor and the
 *    passed clock, taken from the request, not from any body field — a forged
 *    author cannot reach the row.
 */

interface Fake {
  writer: PrismaVariantWriter;
  variants: Map<string, VariantRow>;
  versions: VariantVersionRow[];
}

function fake(seed: { variants?: VariantRow[]; versions?: VariantVersionRow[] } = {}): Fake {
  const variants = new Map<string, VariantRow>();
  for (const row of seed.variants ?? []) variants.set(row.id, { ...row });
  const versions: VariantVersionRow[] = (seed.versions ?? []).map((v) => ({ ...v }));

  const writer = new PrismaVariantWriter(
    {
      findUnique: ({ where }) => Promise.resolve(variants.get(where.id) ?? null),
      create: ({ data }) => {
        variants.set(data.id, { id: data.id, role: data.role, name: data.name });
        return Promise.resolve(undefined);
      },
      update: ({ where, data }) => {
        const existing = variants.get(where.id);
        if (existing === undefined) return Promise.reject(new Error("no such variant"));
        variants.set(where.id, { ...existing, name: data.name });
        return Promise.resolve(undefined);
      },
    },
    {
      findMany: ({ where }) =>
        Promise.resolve(
          versions
            .filter((v) => v.variantId === where.variantId)
            .sort((a, b) => b.version - a.version)
            .map((v) => ({ ...v })),
        ),
      create: ({ data }) => {
        if (versions.some((v) => v.variantId === data.variantId && v.version === data.version)) {
          // What the composite primary key does in Postgres.
          return Promise.reject(new Error("unique violation on (variantId, version)"));
        }
        versions.push({
          variantId: data.variantId,
          version: data.version,
          model: data.model,
          configJson: data.configJson,
          evalScore: data.evalScore,
          createdAt: data.createdAt,
        });
        return Promise.resolve(undefined);
      },
    },
  );

  return { writer, variants, versions };
}

const CREATE = {
  variantId: "analyst-web",
  role: "analyst" as const,
  platform: "web",
  fields: {
    model: "anthropic/claude-sonnet-4.5",
    persona: "ilk persona",
    knowledgeRefs: ["bddk-uyum.md", "bddk-uyum.md", "pci.md"],
    note: "ilk",
  },
  actor: "ayse.kaya@ugurbank.local",
  at: "2026-08-01T09:00:00.000Z",
};

describe("PrismaVariantWriter.create", () => {
  it("publishes version 1 with the model, persona and server-derived author", async () => {
    const f = fake();
    const detail = await f.writer.create(CREATE);

    expect(detail.variantId).toBe("analyst-web");
    expect(detail.role).toBe("analyst");
    expect(detail.platform).toBe("web");
    expect(detail.activeVersion).toBe(1);
    expect(detail.model).toBe("anthropic/claude-sonnet-4.5");
    expect(detail.persona).toBe("ilk persona");
    // publishedBy is the ACTOR, published at is the passed clock — not body.
    expect(detail.versions[0]?.publishedBy).toBe("ayse.kaya@ugurbank.local");
    expect(detail.versions[0]?.publishedAt).toBe("2026-08-01T09:00:00.000Z");

    // The stored configJson carries the overlay under the agreed keys.
    const stored = f.versions[0]?.configJson as VariantConfigJson;
    expect(stored["persona"]).toBe("ilk persona");
    expect(stored["publishedBy"]).toBe("ayse.kaya@ugurbank.local");
  });

  it("refuses a variantId that already exists (would orphan its history)", async () => {
    const f = fake({ variants: [{ id: "analyst-web", role: "analyst", name: "web" }] });
    await expect(f.writer.create(CREATE)).rejects.toThrow(/already exists/);
  });
});

describe("PrismaVariantWriter.publishVersion (append-only, M83)", () => {
  it("appends latest+1 and leaves the old version's model/persona untouched", async () => {
    const f = fake();
    await f.writer.create(CREATE);

    const after = await f.writer.publishVersion({
      variantId: "analyst-web",
      fields: {
        model: "anthropic/claude-opus-5",
        persona: "yeni persona",
        knowledgeRefs: ["pci.md"],
        note: "model yükseltildi",
      },
      actor: "mehmet.demir@ugurbank.local",
      at: "2026-08-02T10:00:00.000Z",
    });

    expect(after?.activeVersion).toBe(2);
    expect(after?.model).toBe("anthropic/claude-opus-5");
    expect(after?.persona).toBe("yeni persona");

    // Version 1 is unchanged — the whole point of append-only.
    const v1 = f.versions.find((v) => v.version === 1);
    expect(v1?.model).toBe("anthropic/claude-sonnet-4.5");
    expect((v1?.configJson as VariantConfigJson)["persona"]).toBe("ilk persona");

    // The version list carries BOTH, newest first, each with its own author.
    expect(after?.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(after?.versions[0]?.publishedBy).toBe("mehmet.demir@ugurbank.local");
    expect(after?.versions[1]?.publishedBy).toBe("ayse.kaya@ugurbank.local");
  });

  it("returns null for an unknown variant (the route answers 404)", async () => {
    const f = fake();
    const result = await f.writer.publishVersion({
      variantId: "ghost",
      fields: { model: "m", persona: "p", knowledgeRefs: [], note: "" },
      actor: "a@b.local",
      at: "2026-08-02T10:00:00.000Z",
    });
    expect(result).toBeNull();
  });
});

describe("PrismaVariantWriter.edit", () => {
  it("changes only the platform overlay, never a versioned field", async () => {
    const f = fake();
    await f.writer.create(CREATE);
    const edited = await f.writer.edit({
      variantId: "analyst-web",
      platform: "mobile-ios",
      actor: "ayse.kaya@ugurbank.local",
      at: "2026-08-03T09:00:00.000Z",
    });
    expect(edited?.platform).toBe("mobile-ios");
    // Model and persona are version-1's still — edit never touches them.
    expect(edited?.model).toBe("anthropic/claude-sonnet-4.5");
    expect(edited?.activeVersion).toBe(1);
  });

  it("returns null for an unknown variant", async () => {
    const f = fake();
    const result = await f.writer.edit({
      variantId: "ghost",
      platform: "web",
      actor: "a@b.local",
      at: "2026-08-03T09:00:00.000Z",
    });
    expect(result).toBeNull();
  });
});
