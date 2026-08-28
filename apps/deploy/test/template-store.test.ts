import { describe, expect, it } from "vitest";
import {
  PrismaTemplateStore,
  type AnalysisTemplateCreateData,
  type AnalysisTemplateRow,
  type PinnedRunRow,
  type TemplateBindingRow,
} from "../src/stores/template.js";

/**
 * `PrismaTemplateStore` — the analysis template's durability (M108/M83).
 *
 * The store this replaced kept versions in a JavaScript array, so the bug it
 * exists to fix is not visible in a unit test: it showed up as a 404 after a
 * restart. What IS testable, and is what these cases pin down, is everything
 * the store must get right on the way to and from a row — that a stored
 * section list is parsed rather than trusted, that the pinned-run count is a
 * real count, and that a publish inserts instead of overwriting.
 */

const SECTIONS = [
  {
    key: "amac",
    title: "Amaç",
    description: "Neden",
    aiInstruction: "Amacı yaz",
    required: true,
    format: "free_text",
    example: "Örnek",
  },
];

function row(overrides: Partial<AnalysisTemplateRow> = {}): AnalysisTemplateRow {
  return {
    version: 1,
    name: "Standart analiz şablonu v1",
    sectionsJson: SECTIONS,
    publishedBy: "installer",
    publishedAt: new Date("2026-08-01T09:00:00.000Z"),
    ...overrides,
  };
}

interface Harness {
  store: PrismaTemplateStore;
  created: AnalysisTemplateCreateData[];
}

function harness(options: {
  rows?: AnalysisTemplateRow[];
  bindings?: TemplateBindingRow[];
  runs?: PinnedRunRow[];
}): Harness {
  const rows = options.rows ?? [];
  const created: AnalysisTemplateCreateData[] = [];

  const store = new PrismaTemplateStore(
    {
      findFirst: () =>
        Promise.resolve(
          [...rows].sort((a, b) => b.version - a.version)[0] ?? null,
        ),
      findUnique: ({ where }) =>
        Promise.resolve(rows.find((r) => r.version === where.version) ?? null),
      findMany: () => Promise.resolve([...rows].sort((a, b) => b.version - a.version)),
      create: ({ data }) => {
        if (rows.some((r) => r.version === data.version)) {
          // What the primary key does in Postgres.
          return Promise.reject(new Error("unique violation on version"));
        }
        created.push(data);
        return Promise.resolve(undefined);
      },
    },
    { findMany: () => Promise.resolve(options.bindings ?? []) },
    { findMany: () => Promise.resolve(options.runs ?? []) },
  );

  return { store, created };
}

describe("PrismaTemplateStore.latest / get", () => {
  it("returns null before the first publish, which is not an error", async () => {
    const { store } = harness({});
    expect(await store.latest()).toBeNull();
  });

  it("returns the HIGHEST version, not the first row", async () => {
    const { store } = harness({
      rows: [row({ version: 1 }), row({ version: 3, name: "v3" }), row({ version: 2 })],
    });
    const latest = await store.latest();
    expect(latest?.version).toBe(3);
    expect(latest?.name).toBe("v3");
  });

  it("reads an OLDER version, which is why they are kept (M83 pinning)", async () => {
    const { store } = harness({ rows: [row({ version: 1 }), row({ version: 2 })] });
    expect((await store.get(1))?.version).toBe(1);
    expect(await store.get(99)).toBeNull();
  });

  it("converts publishedAt to an ISO string", async () => {
    const { store } = harness({ rows: [row()] });
    expect((await store.latest())?.publishedAt).toBe("2026-08-01T09:00:00.000Z");
  });
});

describe("PrismaTemplateStore section parsing", () => {
  it("REFUSES a row whose sections lost `required` rather than defaulting it", async () => {
    // The failure this prevents: `required: undefined` renders every section as
    // optional, so an analysis passes a completeness check it should fail.
    const { store } = harness({
      rows: [row({ sectionsJson: [{ ...SECTIONS[0], required: undefined }] })],
    });
    await expect(store.latest()).rejects.toThrow(/unusable sections/);
  });

  it("refuses a format outside the designer's closed set", async () => {
    const { store } = harness({
      rows: [row({ sectionsJson: [{ ...SECTIONS[0], format: "freeform_prose" }] })],
    });
    await expect(store.latest()).rejects.toThrow(/unusable sections/);
  });

  it("names the version and the column so the row can be found", async () => {
    const { store } = harness({ rows: [row({ version: 7, sectionsJson: "not an array" })] });
    await expect(store.latest()).rejects.toThrow(/version 7/);
  });

  it("distinguishes an unusable row from having no template at all", async () => {
    const { store } = harness({ rows: [row({ sectionsJson: [] })] });
    // An empty array parses; it is the DB's CHECK that refuses it on write.
    // What matters here is that a bad row throws instead of returning null,
    // because null means "publish one" and this row means "something is wrong".
    await expect(store.latest()).resolves.not.toBeNull();
  });
});

describe("PrismaTemplateStore.publish", () => {
  it("INSERTs, and the stored sections keep every designed field", async () => {
    const { store, created } = harness({});
    await store.publish({
      name: "v1",
      version: 1,
      sections: SECTIONS as never,
      publishedBy: "ayse.kaya@bank",
      publishedAt: "2026-08-01T09:00:00.000Z",
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.sectionsJson[0]).toEqual({
      key: "amac",
      title: "Amaç",
      description: "Neden",
      aiInstruction: "Amacı yaz",
      required: true,
      format: "free_text",
      example: "Örnek",
    });
  });

  it("lets the database refuse a duplicate version instead of overwriting", async () => {
    const { store } = harness({ rows: [row({ version: 1 })] });
    await expect(
      store.publish({
        name: "also v1",
        version: 1,
        sections: SECTIONS as never,
        publishedBy: "someone.else@bank",
        publishedAt: "2026-08-01T10:00:00.000Z",
      }),
    ).rejects.toThrow(/unique violation/);
  });
});

describe("PrismaTemplateStore.projects", () => {
  it("counts only runs pinned to an OLDER version, per project", async () => {
    const { store } = harness({
      rows: [row({ version: 3 })],
      bindings: [{ projectKey: "UGURPAY" }, { projectKey: "UGURWEB" }],
      runs: [
        { ticketKey: "UGURPAY-1", templateVersion: "2" }, // older -> counts
        { ticketKey: "UGURPAY-2", templateVersion: "1" }, // older -> counts
        { ticketKey: "UGURPAY-3", templateVersion: "3" }, // current -> no
        { ticketKey: "UGURWEB-9", templateVersion: "" }, // unpinned -> no
      ],
    });

    const projects = await store.projects();
    expect(projects).toEqual([
      { projectKey: "UGURPAY", version: 3, pinnedRuns: 2 },
      { projectKey: "UGURWEB", version: 3, pinnedRuns: 0 },
    ]);
  });

  it("reports version 0 when nothing is published, not a phantom version 1", async () => {
    const { store } = harness({ bindings: [{ projectKey: "UGURPAY" }] });
    expect(await store.projects()).toEqual([
      { projectKey: "UGURPAY", version: 0, pinnedRuns: 0 },
    ]);
  });

  it("drops a run whose ticket key names no project rather than inventing one", async () => {
    const { store } = harness({
      rows: [row({ version: 2 })],
      bindings: [{ projectKey: "UGURPAY" }],
      runs: [{ ticketKey: "malformed", templateVersion: "1" }],
    });
    expect((await store.projects())[0]?.pinnedRuns).toBe(0);
  });

  it("returns an empty list when no project is bound — a real answer", async () => {
    const { store } = harness({ rows: [row()] });
    expect(await store.projects()).toEqual([]);
  });
});

describe("PrismaTemplateStore.history", () => {
  it("lists newest first, with the section count derived from the stored rows", async () => {
    const { store } = harness({
      rows: [
        row({ version: 1 }),
        row({ version: 2, sectionsJson: [SECTIONS[0], { ...SECTIONS[0], key: "kapsam" }] }),
      ],
    });
    const history = await store.history();
    expect(history.map((entry) => entry.version)).toEqual([2, 1]);
    expect(history[0]?.summary).toBe("2");
    expect(history[1]?.summary).toBe("1");
  });
});
