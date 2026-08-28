import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Db, createDb } from "@maestro/db";
import type { PilotSettings } from "@maestro/pilot";
import {
  defaultSandboxRootPath,
  ensureSandboxRootDefault,
  loadPilotSettingsFile,
  persistPilotSettingsFile,
  pilotWiringFromEnv,
  variantReaderFromEnv,
} from "../src/bin/pilot.js";

/**
 * The LIVE pilot launcher's DB-first wiring (`apps/deploy/src/bin/pilot.ts`).
 *
 * `main.ts` boots the pilot DB-FREE (env fallback, warning). This launcher is
 * the one that hands the pilot a Postgres-backed `VariantModelReader`, so the
 * model comes from the variant (Studio/DB), not env. These pin the decision that
 * chooses that path — offline, with a fake `createDb`, so no real Postgres is
 * touched:
 *
 *  · with a `DATABASE_URL`, a reader is built over the DB's `variantVersion`
 *    delegate, and it resolves a variant's active model DB-first;
 *  · with no `DATABASE_URL`, the launcher fails closed (M6) — an operator with
 *    no database is meant to run the standalone `main.ts`, not this binary.
 */

/** A fake `createDb` whose `variantVersion.findMany` returns seeded rows. */
function fakeCreateDb(
  seed: { version: number; model: string }[],
): { makeDb: typeof createDb; calledWith: string[] } {
  const calledWith: string[] = [];
  const makeDb = ((url: string) => {
    calledWith.push(url);
    return {
      variantVersion: {
        findMany: () =>
          Promise.resolve(seed.slice().sort((a, b) => b.version - a.version)),
      },
    } as unknown as Db;
  }) as typeof createDb;
  return { makeDb, calledWith };
}

describe("variantReaderFromEnv", () => {
  it("builds a Postgres-backed reader that resolves the active model DB-first", async () => {
    const { makeDb, calledWith } = fakeCreateDb([
      { version: 1, model: "env-seed/gpt-4o-mini" },
      { version: 2, model: "studio-set/claude-x" },
    ]);
    const reader = variantReaderFromEnv(
      { DATABASE_URL: "postgresql://maestro:pw@localhost:55432/maestro" },
      makeDb,
    );

    // The URL from env reached createDb (the reader is over that DB).
    expect(calledWith).toEqual(["postgresql://maestro:pw@localhost:55432/maestro"]);
    // And the reader answers with the ACTIVE (newest) version's model — what an
    // admin last published in Studio, not the version-1 env seed.
    expect(await reader.activeModel("analyst-default")).toBe("studio-set/claude-x");
  });

  it("fails closed when DATABASE_URL is absent (run main.ts instead)", () => {
    const makeDb = vi.fn();
    expect(() => variantReaderFromEnv({}, makeDb as unknown as typeof createDb)).toThrow(
      /DATABASE_URL is required/,
    );
    // It never tried to build a client with a missing URL.
    expect(makeDb).not.toHaveBeenCalled();
  });

  it("treats a blank DATABASE_URL as absent", () => {
    const makeDb = vi.fn();
    expect(() =>
      variantReaderFromEnv({ DATABASE_URL: "   " }, makeDb as unknown as typeof createDb),
    ).toThrow(/DATABASE_URL is required/);
    expect(makeDb).not.toHaveBeenCalled();
  });
});

describe("pilotWiringFromEnv — Postgres-backed audit chain", () => {
  it("appends the pilot's audit events to the REAL AuditLog table (not memory)", async () => {
    // A fake db with just enough surface: the auditLog delegate captures the
    // INSERT, and $transaction runs the advisory-lock callback inline.
    const created: unknown[] = [];
    const makeDb = ((_url: string) =>
      ({
        variantVersion: { findMany: () => Promise.resolve([]) },
        auditLog: {
          findFirst: () => Promise.resolve(null), // empty chain → genesis
          findMany: () => Promise.resolve([]),
          create: (args: { data: unknown }) => {
            created.push(args.data);
            return Promise.resolve({});
          },
        },
        $transaction: <T,>(fn: (tx: unknown) => Promise<T>) =>
          fn({ $queryRawUnsafe: () => Promise.resolve([]) }),
      }) as unknown as Db) as typeof createDb;

    const wiring = pilotWiringFromEnv(
      { DATABASE_URL: "postgresql://maestro:pw@localhost:55432/maestro" },
      makeDb,
    );
    await wiring.audit.append({
      actor: "maestro-runner",
      action: "RUN_STARTED",
      subject: "OPS-1",
      meta: {},
    });

    // The event landed in the Postgres delegate — a restart can no longer
    // erase the regulator's trail.
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ seq: 1n, actor: "maestro-runner", action: "RUN_STARTED" });
  });
});

describe("pilotWiringFromEnv — loadSeeds dinleme kuralları (Faz 3 akış→ajan)", () => {
  it("kural satırındaki analyst/engineer varyant kolonları pilot seed'ine geçer (null → alan yok)", async () => {
    const baseRow = {
      ruleId: "lr_1",
      projectKey: "OPS",
      assigneeAccountId: "712020:bot",
      matchKind: "issuetype",
      matchValue: "Hata",
      flowType: "duzeltme",
      priority: 100,
      enabled: true,
    };
    const makeDb = ((_url: string) =>
      ({
        variantVersion: { findMany: () => Promise.resolve([]) },
        listeningRule: {
          findMany: () =>
            Promise.resolve([
              // A rule an admin mapped to Studio agents…
              { ...baseRow, analystVariantId: "mobil-analist", engineerVariantId: "mobil-muhendis" },
              // …and an unmapped one (DB NULL = default agent).
              { ...baseRow, ruleId: "lr_2", matchValue: "Görev", analystVariantId: null, engineerVariantId: null },
            ]),
        },
        analysisGuidance: { findMany: () => Promise.resolve([]) },
      }) as unknown as Db) as typeof createDb;

    const wiring = pilotWiringFromEnv(
      { DATABASE_URL: "postgresql://maestro:pw@localhost:55432/maestro" },
      makeDb,
    );
    const seeds = await wiring.loadSeeds();

    expect(seeds.listening).toHaveLength(2);
    // The mapped rule carries its agent variants into the pilot's seed…
    expect(seeds.listening[0]).toMatchObject({
      analystVariantId: "mobil-analist",
      engineerVariantId: "mobil-muhendis",
    });
    // …and the pilot rule shape carries no DB ruleId (not part of the seed).
    expect(seeds.listening[0]).not.toHaveProperty("ruleId");
    // …and the unmapped rule seeds WITHOUT the fields (null → absent), so the
    // pilot's `?? default` fallback picks the platform default agent.
    expect(seeds.listening[1]).not.toHaveProperty("analystVariantId");
    expect(seeds.listening[1]).not.toHaveProperty("engineerVariantId");
  });
});

describe("pilot ayarlarının dosya kalıcılığı (.pilot-settings.json)", () => {
  const SETTINGS: PilotSettings = {
    approverGroup: "jira-users-uyildiz",
    model: "openai/gpt-4o-mini",
    commandPollMs: 5_000,
    discoveryPollMs: 20_000,
    dataClass: "gizli",
    operatorAccount: "op@corp",
    sandboxRoot: "/srv/sandbox",
    reviewStatusName: "İNCELEMEDE",
    autoMerge: false,
    autoStart: false,
  };

  it("persist → load gidiş-dönüşü değerleri korur (restart senaryosu)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilot-settings-"));
    const path = join(dir, ".pilot-settings.json");
    await persistPilotSettingsFile(SETTINGS, path);
    const loaded = await loadPilotSettingsFile(path);
    expect(loaded).toEqual(SETTINGS);
  });

  it("dosya yoksa undefined döner (env varsayılanlarına düşülür)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilot-settings-"));
    expect(await loadPilotSettingsFile(join(dir, "yok.json"))).toBeUndefined();
  });

  it("bozuk JSON undefined döner — asla boot'u kırmaz", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilot-settings-"));
    const path = join(dir, ".pilot-settings.json");
    await writeFile(path, "{ bozuk", "utf8");
    expect(await loadPilotSettingsFile(path)).toBeUndefined();
  });

  it("bilinmeyen anahtarlar seed'e sızmaz (eski/yabancı dosya)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilot-settings-"));
    const path = join(dir, ".pilot-settings.json");
    await writeFile(path, JSON.stringify({ ...SETTINGS, apiToken: "sızıntı", evil: 1 }), "utf8");
    const loaded = await loadPilotSettingsFile(path);
    expect(loaded).toEqual(SETTINGS);
    expect(loaded).not.toHaveProperty("apiToken");
  });

  it("yazma atomiktir (tmp + rename) ve dosya okunur JSON bırakır", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilot-settings-"));
    const path = join(dir, ".pilot-settings.json");
    await persistPilotSettingsFile(SETTINGS, path);
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ autoStart: false });
  });
});

describe("pilotWiringFromEnv — aktif Word şablonu (DocTemplateVersion)", () => {
  function makeDbWith(row: unknown): typeof createDb {
    return ((_url: string) =>
      ({
        variantVersion: { findMany: () => Promise.resolve([]) },
        docTemplateVersion: {
          findFirst: (args: { orderBy: { version: "desc" } }) => {
            expect(args.orderBy.version).toBe("desc"); // aktif = en yüksek versiyon
            return Promise.resolve(row);
          },
        },
        docTemplateOutputRow: { findMany: () => Promise.resolve([]) },
      }) as unknown as Db) as typeof createDb;
  }

  it("en yüksek versiyonun scan metadata'sı + bytes'ı döner", async () => {
    const row = {
      version: 3,
      fileName: "banka-sablon.docx",
      uploadedAt: new Date("2026-08-01T10:00:00.000Z"),
      uploadedBy: "admin@corp",
      sizeBytes: 4,
      stylesJson: ["Başlık 1"],
      placeholdersJson: [
        { token: "{{govde}}", descriptionKey: "doc.govde", location: "body", found: true },
      ],
      content: Uint8Array.from([80, 75, 3, 4]),
    };
    const wiring = pilotWiringFromEnv(
      { DATABASE_URL: "postgresql://maestro:pw@localhost:55432/maestro" },
      makeDbWith(row),
    );
    const template = await wiring.docTemplate();
    expect(template).not.toBeNull();
    expect(template!.file.version).toBe(3);
    expect(template!.file.fileName).toBe("banka-sablon.docx");
    expect(template!.file.placeholders[0]).toMatchObject({ token: "{{govde}}", found: true });
    expect([...template!.bytes]).toEqual([80, 75, 3, 4]);
  });

  it("hiç şablon yüklenmemişse null (yerleşik düzen)", async () => {
    const wiring = pilotWiringFromEnv(
      { DATABASE_URL: "postgresql://maestro:pw@localhost:55432/maestro" },
      makeDbWith(null),
    );
    expect(await wiring.docTemplate()).toBeNull();
  });

  it("DB hatası null'a düşer — bir run asla şablon yüzünden ölmez", async () => {
    const makeDb = ((_url: string) =>
      ({
        variantVersion: { findMany: () => Promise.resolve([]) },
        docTemplateVersion: {
          findFirst: () => Promise.reject(new Error("bağlantı koptu")),
        },
        docTemplateOutputRow: { findMany: () => Promise.resolve([]) },
      }) as unknown as Db) as typeof createDb;
    const wiring = pilotWiringFromEnv(
      { DATABASE_URL: "postgresql://maestro:pw@localhost:55432/maestro" },
      makeDb,
    );
    expect(await wiring.docTemplate()).toBeNull();
  });
});

describe("pilotWiringFromEnv — Studio analiz şablonu overlay'i (AnalysisTemplateVersion)", () => {
  const SECTION = {
    key: "purpose",
    title: "İş Değeri (Studio)",
    description: "",
    aiInstruction: "Amacı iki cümlede, iş değeriyle yaz.",
    required: true,
    format: "free_text",
    example: "",
  };

  function makeDbWith(row: unknown): typeof createDb {
    return ((_url: string) =>
      ({
        variantVersion: { findMany: () => Promise.resolve([]) },
        analysisTemplateVersion: {
          findFirst: (args: { orderBy: { version: "desc" } }) => {
            expect(args.orderBy.version).toBe("desc"); // aktif = en yüksek versiyon
            return Promise.resolve(row);
          },
        },
        jiraProjectBinding: { findMany: () => Promise.resolve([]) },
        workflowRun: { findMany: () => Promise.resolve([]) },
      }) as unknown as Db) as typeof createDb;
  }

  it("aktif (en yüksek) versiyonun bölümleri {key,title,aiInstruction} olarak döner", async () => {
    const wiring = pilotWiringFromEnv(
      { DATABASE_URL: "postgresql://maestro:pw@localhost:55432/maestro" },
      makeDbWith({
        version: 4,
        name: "kurumsal-analiz",
        sectionsJson: [SECTION],
        publishedBy: "admin@corp",
        publishedAt: new Date("2026-08-10T10:00:00.000Z"),
      }),
    );

    const overlay = await wiring.analysisTemplateOverlay();
    expect(overlay).toEqual({
      sections: [
        {
          key: "purpose",
          title: "İş Değeri (Studio)",
          aiInstruction: "Amacı iki cümlede, iş değeriyle yaz.",
        },
      ],
    });
  });

  it("hiç şablon yayınlanmamışsa null (motorun varsayılan şablonu)", async () => {
    const wiring = pilotWiringFromEnv(
      { DATABASE_URL: "postgresql://maestro:pw@localhost:55432/maestro" },
      makeDbWith(null),
    );
    expect(await wiring.analysisTemplateOverlay()).toBeNull();
  });

  it("DB hatası null'a düşer — bir analiz asla şablon okuması yüzünden ölmez", async () => {
    const makeDb = ((_url: string) =>
      ({
        variantVersion: { findMany: () => Promise.resolve([]) },
        analysisTemplateVersion: {
          findFirst: () => Promise.reject(new Error("bağlantı koptu")),
        },
        jiraProjectBinding: { findMany: () => Promise.resolve([]) },
        workflowRun: { findMany: () => Promise.resolve([]) },
      }) as unknown as Db) as typeof createDb;
    const wiring = pilotWiringFromEnv(
      { DATABASE_URL: "postgresql://maestro:pw@localhost:55432/maestro" },
      makeDb,
    );
    expect(await wiring.analysisTemplateOverlay()).toBeNull();
  });

  it("bozuk sectionsJson (eski/elle yazılmış satır) da null'a düşer — fail-soft", async () => {
    const wiring = pilotWiringFromEnv(
      { DATABASE_URL: "postgresql://maestro:pw@localhost:55432/maestro" },
      makeDbWith({
        version: 2,
        name: "bozuk",
        sectionsJson: [{ key: "purpose" }], // required alanlar eksik → parse hatası
        publishedBy: "admin@corp",
        publishedAt: new Date("2026-08-10T10:00:00.000Z"),
      }),
    );
    expect(await wiring.analysisTemplateOverlay()).toBeNull();
  });
});

describe("ensureSandboxRootDefault — kalıcı sandbox hazırlığı", () => {
  it("seed'de VE env'de kök boşsa varsayılanı doldurur ve dizini mkdir -p ile açar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilot-sandbox-"));
    const fallback = join(dir, "derin", ".sandbox"); // iç içe: -p davranışı da kanıtlanır

    const seeded = await ensureSandboxRootDefault({ sandboxRoot: "" }, {}, fallback);

    expect(seeded?.sandboxRoot).toBe(fallback);
    expect((await stat(fallback)).isDirectory()).toBe(true);
  });

  it("hiç kalıcı ayar yokken (undefined seed) de varsayılan dolar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilot-sandbox-"));
    const fallback = join(dir, ".sandbox");

    const seeded = await ensureSandboxRootDefault(undefined, {}, fallback);

    expect(seeded).toEqual({ sandboxRoot: fallback });
    expect((await stat(fallback)).isDirectory()).toBe(true);
  });

  it("DOLU kalıcı ayar ASLA ezilmez — seed aynen döner, dizin açılmaz", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilot-sandbox-"));
    const fallback = join(dir, ".sandbox");
    const persisted = { sandboxRoot: "/srv/kalici-sandbox", autoStart: true };

    const seeded = await ensureSandboxRootDefault(persisted, {}, fallback);

    expect(seeded).toBe(persisted); // dokunulmadı (aynı referans)
    await expect(stat(fallback)).rejects.toThrow(); // varsayılan dizin açılmadı
  });

  it("PILOT_SANDBOX_ROOT env'i doluysa da dokunulmaz (env seed'i zaten taşır)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilot-sandbox-"));
    const fallback = join(dir, ".sandbox");

    const seeded = await ensureSandboxRootDefault(
      { sandboxRoot: "" },
      { PILOT_SANDBOX_ROOT: "/srv/env-sandbox" },
      fallback,
    );

    expect(seeded).toEqual({ sandboxRoot: "" }); // seed aynen — env yolunu config katmanı uygular
    await expect(stat(fallback)).rejects.toThrow();
  });

  it("mkdir hatası fail-soft: seed yine dolar, boot kırılmaz", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilot-sandbox-"));
    const file = join(dir, "engel");
    await writeFile(file, "dosya", "utf8");
    const fallback = join(file, ".sandbox"); // bir DOSYANIN altı: mkdir kesin başarısız

    const seeded = await ensureSandboxRootDefault(undefined, {}, fallback);

    expect(seeded).toEqual({ sandboxRoot: fallback }); // uyarıyla da olsa seed doldu
  });

  it("varsayılan yol maestro kökünün altındaki .sandbox'tır (.pilot-settings.json'un yanı)", () => {
    expect(defaultSandboxRootPath().endsWith("/.sandbox")).toBe(true);
  });
});
