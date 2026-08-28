import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditChain } from "@maestro/audit";
import {
  bootPilot,
  type AnalysisTemplateOverlay,
  type ListeningRule,
  type PilotDocTemplate,
  type PilotSettings,
  type VariantModelReader,
} from "@maestro/pilot";
import { createDb } from "@maestro/db";
import { postgresChainLock, PrismaAuditStore } from "../stores/audit.js";
import { PrismaDocTemplateStore } from "../stores/doc-template.js";
import { PrismaTemplateStore } from "../stores/template.js";
import { prismaTransactionRunner } from "../stores/sql.js";
import { llmCallRecorder } from "../stores/llm-call-log.js";
import { PrismaVariantModelReader } from "../stores/variant-model-reader.js";
import { fail, install, isEntrypoint } from "./lifecycle.js";

/**
 * The LIVE pilot launcher — the one process that boots the pilot DB-FIRST.
 *
 * `apps/pilot/src/main.ts` is the standalone, DB-free entry: it boots the pilot
 * with no `variantReader`, so it falls back to the bootstrap `PILOT_MODEL` (env)
 * with a loud warning. That is the right behaviour for an offline/dev pilot with
 * no database, but it is NOT what an admin who set a model in Studio expects the
 * live pilot to run.
 *
 * This launcher closes that gap. It lives in the composition root (`apps/deploy`),
 * the one app that may talk to Postgres, and hands the pilot a
 * `PrismaVariantModelReader` over the real `VariantVersion` table. With the
 * reader wired, `bootPilot` resolves each role's model from its variant's active
 * version (the DB — what Studio wrote) and the env-fallback warning is not
 * emitted. The pilot package stays DB-free: it only ever sees the
 * `VariantModelReader` port, never `@maestro/db`.
 *
 * `DATABASE_URL` is required here on purpose. This binary's whole reason to
 * exist is the DB-first path; a deployment that has no database should run the
 * standalone `main.ts` (env fallback) instead, so booting this one without a URL
 * is a configuration error we fail closed on (M6) rather than silently degrade.
 */

/**
 * Build the pilot's variant-model reader from the environment.
 *
 * Extracted from `main` so the DB-first-vs-fail decision is unit-testable
 * without a live Postgres: pass an env map and assert on the outcome. Returns
 * the reader when a `DATABASE_URL` is present; throws (fail-closed) when it is
 * not, because this launcher exists specifically to run DB-first — an absent
 * URL means the operator picked the wrong entrypoint.
 *
 * `createDb` is injectable so a test proves the wiring (which delegate the
 * reader is built over) without opening a connection; the real caller passes the
 * real `createDb`, whose construction is lazy (no query until first use).
 */
export interface PilotDbWiring {
  variantReader: VariantModelReader;
  /**
   * The pilot's audit chain over the REAL `AuditLog` table (M33), with the
   * cross-process advisory lock — the same chain the BFF writes. Wiring it here
   * closes the worst persistence gap: without it the pilot's trail lived in an
   * `InMemoryAuditStore` and every restart erased the regulator's history.
   */
  audit: AuditChain;
  /**
   * Fire-and-forget writer landing every completed LLM call in the `LlmCall`
   * table, so the Studio cost/PII screens report the pilot's REAL spend. A DB
   * hiccup is logged and swallowed — reporting must never fail a run.
   */
  onLlmCall: (log: import("@maestro/contracts").LlmCallLog) => void;
  /**
   * Read the pilot's boot seeds from the DB: the listening rules and the
   * ENABLED "öğren" notes. Without this, a pilot restart silently forgot both
   * until someone re-saved them in Studio (the mirror is push-only).
   */
  loadSeeds: () => Promise<{
    listening: ListeningRule[];
    guidance: { title: string; content: string; variantId?: string }[];
  }>;
  /**
   * Lazy loader for the ACTIVE corporate Word template: the NEWEST
   * `DocTemplateVersion` row (highest version — the store is append-only), as
   * the scan metadata + raw bytes `renderDocx` patches. Null when no template
   * was ever uploaded; a read error is logged and answered as null too, so the
   * pilot falls back to the built-in layout instead of failing a run.
   */
  docTemplate: () => Promise<PilotDocTemplate | null>;
  /**
   * Lazy loader for the ACTIVE Studio ANALYSIS template
   * (`AnalysisTemplateVersion` — newest version, the store is append-only),
   * reduced to the SAFE overlay shape the pilot applies onto the engine
   * template: per section only `key`, `title`, `aiInstruction`. Called by the
   * pilot PER RUN, so a Studio publish is live restart-free. No template yet or
   * a read error → null (logged), and the corporate default serves — a
   * template read must never fail an analysis.
   */
  analysisTemplateOverlay: () => Promise<AnalysisTemplateOverlay | null>;
}

// ---------------------------------------------------------------- settings file
//
// PILOT SETTINGS PERSISTENCE. The `Param` table is a CATALOG: its keys are the
// seeded `DEFAULT_PARAM_DEFINITIONS`, writes go through `writeParamVersion`
// (four-eyes on guarded params) and `packages/db` is frozen — so an ad-hoc
// "pilot.settings" key does not belong there. Instead the UI-edited settings
// live in a small JSON file at the maestro repo root (git-ignored territory,
// same place `.env` lives): written on every successful `/api/settings` update,
// read as the boot seed. Losing the file only means falling back to env
// defaults — never a boot failure.

/** `.pilot-settings.json` at the maestro repo root (next to `maestro/.env`). */
export function pilotSettingsFilePath(): string {
  return fileURLToPath(new URL("../../../../.pilot-settings.json", import.meta.url));
}

const SETTINGS_KEYS: readonly (keyof PilotSettings)[] = [
  "approverGroup",
  "model",
  "commandPollMs",
  "discoveryPollMs",
  "dataClass",
  "operatorAccount",
  "sandboxRoot",
  "reviewStatusName",
  "autoMerge",
  "autoStart",
];

/**
 * Read the persisted settings seed. Only KNOWN keys survive (a stale file from
 * an older/newer pilot cannot smuggle junk into the seed); a missing or
 * unparsable file is `undefined` — the pilot then seeds from env defaults, and
 * the pilot's own seed validation guards the values themselves.
 */
export async function loadPilotSettingsFile(
  path: string = pilotSettingsFilePath(),
): Promise<Partial<PilotSettings> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined; // no file yet — first boot, env defaults
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of SETTINGS_KEYS) {
      if (key in record) out[key] = record[key];
    }
    return out as Partial<PilotSettings>;
  } catch (error) {
    console.warn(`[pilot] ${path} okunamadı (bozuk JSON) — env varsayılanlarıyla açılıyor: ${String(error)}`);
    return undefined;
  }
}

/**
 * Persist the settings snapshot (called after every successful UI update).
 * Write-then-rename so a crash mid-write can never leave a half-file behind.
 * Best-effort by contract: a failure is logged, never thrown — the in-memory
 * store already holds the new values.
 */
export async function persistPilotSettingsFile(
  settings: PilotSettings,
  path: string = pilotSettingsFilePath(),
): Promise<void> {
  try {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch (error) {
    console.warn(`[pilot] ayarlar dosyaya yazılamadı (${path}) — bellekte güncel: ${String(error)}`);
  }
}

// ---------------------------------------------------------------- sandbox kökü
//
// KALICI SANDBOX HAZIRLIĞI ("hiç kapanmayan worker" paketi). Pilot tarafı zaten
// kalıcı kök + `<root>/<ticketKey>` izole alt dizin davranışına sahip — ama kök
// BOŞ kaldığında her run atılan-kullanılan `mkdtemp` alanına düşer ve restart'ta
// hiçbir iz kalmaz. Burada, yalnız hiç kimse bir kök seçmemişken (ne UI'da
// kaydedilmiş ayar ne PILOT_SANDBOX_ROOT env'i) makul bir varsayılan seçilir:
// `<maestro kökü>/.sandbox` (git-ignore bölgesi, `.env` ile aynı yer). Dolu bir
// değer ASLA ezilmez — bu yalnız boş→varsayılan doldurmasıdır.

/** `<maestro kökü>/.sandbox` — kalıcı sandbox'ın varsayılan kökü. */
export function defaultSandboxRootPath(): string {
  return join(dirname(pilotSettingsFilePath()), ".sandbox");
}

/**
 * Seed'deki `sandboxRoot` boşsa VE `PILOT_SANDBOX_ROOT` da boşsa varsayılan kökü
 * seed'e koyar ve dizini `mkdir -p` ile oluşturur. Aksi halde seed'e DOKUNMAZ
 * (dolu ayar/env her zaman kazanır). mkdir hatası fail-soft'tur: uyarı düşer,
 * seed yine doldurulur — boot asla bozulmaz (workspace zaten run başında kendi
 * alt dizinini `mkdir -p` ile açar).
 */
export async function ensureSandboxRootDefault(
  persisted: Partial<PilotSettings> | undefined,
  env: Record<string, string | undefined>,
  fallbackRoot: string = defaultSandboxRootPath(),
): Promise<Partial<PilotSettings> | undefined> {
  const persistedRoot = typeof persisted?.sandboxRoot === "string" ? persisted.sandboxRoot.trim() : "";
  const envRoot = env["PILOT_SANDBOX_ROOT"]?.trim() ?? "";
  if (persistedRoot !== "" || envRoot !== "") return persisted; // dolu değer asla ezilmez
  try {
    await mkdir(fallbackRoot, { recursive: true });
  } catch (error) {
    console.warn(`[pilot] varsayılan sandbox kökü oluşturulamadı (${fallbackRoot}): ${String(error)}`);
  }
  return { ...(persisted ?? {}), sandboxRoot: fallbackRoot };
}

// `assigned` (migration 0020) belongs here or the seed silently DROPS every
// "bota atanan her ticket" rule on a pilot restart — the rule would still be in
// the database and on the Studio screen while the engine behaved as if it did
// not exist, which is the worst shape a configuration bug can take.
const MATCH_KINDS = new Set(["status", "issuetype", "assigned"]);
const FLOW_TYPES = new Set(["analiz", "duzeltme", "gelistirme"]);

/** Build ALL of the pilot's DB-backed wiring from one client (one URL, one pool). */
export function pilotWiringFromEnv(
  env: Record<string, string | undefined>,
  makeDb: typeof createDb = createDb,
): PilotDbWiring {
  const url = env["DATABASE_URL"]?.trim();
  if (url === undefined || url === "") {
    throw new Error(
      "DATABASE_URL is required for the DB-first pilot launcher — " +
        "run apps/pilot (main.ts) for the standalone env-fallback pilot instead.",
    );
  }
  const db = makeDb(url);
  return {
    variantReader: new PrismaVariantModelReader(db.variantVersion),
    audit: new AuditChain({
      store: new PrismaAuditStore(db.auditLog),
      lock: postgresChainLock(prismaTransactionRunner(db)),
    }),
    // Shared with the worker (`stores/llm-call-log.ts`). Two hand-written
    // copies of this insert is how the two paths end up recording different
    // columns and the cost screen disagrees with itself.
    onLlmCall: llmCallRecorder(db.llmCall),
    loadSeeds: async () => {
      const [rules, notes] = await Promise.all([
        db.listeningRule.findMany({ orderBy: { priority: "asc" } }),
        db.analysisGuidance.findMany({ where: { enabled: true }, orderBy: { updatedAt: "asc" } }),
      ]);
      return {
        // Defensive: the DB stores matchKind/flowType as free VarChar; only
        // rows the pilot's classifier understands are seeded.
        listening: rules
          .filter((r) => MATCH_KINDS.has(r.matchKind) && FLOW_TYPES.has(r.flowType))
          .map((r) => ({
            projectKey: r.projectKey,
            assigneeAccountId: r.assigneeAccountId,
            matchKind: r.matchKind as ListeningRule["matchKind"],
            matchValue: r.matchValue,
            flowType: r.flowType as ListeningRule["flowType"],
            priority: r.priority,
            enabled: r.enabled,
            // Faz 3 (akış→ajan): the rule's agent-variant mapping rides into the
            // pilot's seed, so a restart keeps running the flow with the agent
            // an admin bound in Studio. DB NULL = "default agent" = absent.
            ...(typeof r.analystVariantId === "string" && r.analystVariantId.trim() !== ""
              ? { analystVariantId: r.analystVariantId }
              : {}),
            ...(typeof r.engineerVariantId === "string" && r.engineerVariantId.trim() !== ""
              ? { engineerVariantId: r.engineerVariantId }
              : {}),
          })),
        // Ajan-hedefli not (variantId dolu) restart'ta da hedefiyle birlikte
        // yüklenir; NULL = global not, alan hiç konmaz (pilot şekli).
        guidance: notes.map((n) => ({
          title: n.title,
          content: n.content,
          ...(typeof n.variantId === "string" && n.variantId.trim() !== ""
            ? { variantId: n.variantId }
            : {}),
        })),
      };
    },
    docTemplate: async () => {
      try {
        const store = new PrismaDocTemplateStore(db.docTemplateVersion, db.docTemplateOutputRow);
        // Active = the NEWEST version: the store is append-only, so the highest
        // version is what an admin last published in Studio.
        const record = await store.latest();
        if (record === null) return null;
        return {
          file: {
            fileName: record.fileName,
            version: record.version,
            uploadedAt: record.uploadedAt,
            uploadedBy: record.uploadedBy,
            sizeBytes: record.sizeBytes,
            styles: [...record.styles],
            placeholders: record.placeholders.map((p) => ({ ...p })),
          },
          bytes: Uint8Array.from(record.content),
        };
      } catch (error) {
        // Fail-soft: a template read must never fail a document, let alone a
        // run — the pilot renders the built-in layout instead.
        console.warn(`[pilot] kurumsal Word şablonu DB'den okunamadı (yerleşik düzen kullanılacak): ${String(error)}`);
        return null;
      }
    },
    analysisTemplateOverlay: async () => {
      try {
        // The same append-only store the BFF composes: active = newest version
        // (what an admin last published in Studio's template designer).
        const store = new PrismaTemplateStore(db.analysisTemplateVersion, db.jiraProjectBinding, db.workflowRun);
        const record = await store.latest();
        if (record === null) return null;
        return {
          sections: record.sections.map((s) => ({
            key: s.key,
            title: s.title,
            aiInstruction: s.aiInstruction,
          })),
        };
      } catch (error) {
        // Fail-soft: the engine's default template serves — a Studio-template
        // read must never fail an analysis, let alone a run.
        console.warn(`[pilot] Studio analiz şablonu DB'den okunamadı (varsayılan şablon kullanılacak): ${String(error)}`);
        return null;
      }
    },
  };
}

/** Kept for callers/tests that only need the reader; delegates to the wiring. */
export function variantReaderFromEnv(
  env: Record<string, string | undefined>,
  makeDb: typeof createDb = createDb,
): VariantModelReader {
  return pilotWiringFromEnv(env, makeDb).variantReader;
}

async function main(): Promise<void> {
  const { variantReader, audit, onLlmCall, loadSeeds, docTemplate, analysisTemplateOverlay } =
    pilotWiringFromEnv(process.env);
  // Boot seeds from the DB (Faz 1): rules + enabled notes survive a restart.
  const seeds = await loadSeeds();
  // The UI-edited settings, persisted as a JSON file at the maestro root (the
  // Param table is a locked catalog — see the note above the file helpers).
  // Seeded here so a restart keeps what the operator saved in the panel.
  // Kalıcı sandbox hazırlığı: kimse bir kök seçmediyse `<maestro kökü>/.sandbox`
  // varsayılanı seed'e girer ve dizin açılır; dolu ayar/env'e dokunulmaz.
  const persistedSettings = await ensureSandboxRootDefault(await loadPilotSettingsFile(), process.env);

  const stage = await bootPilot({
    startDiscovery: true,
    variantReader,
    audit,
    onLlmCall,
    listening: seeds.listening,
    guidance: seeds.guidance,
    ...(persistedSettings === undefined ? {} : { settings: persistedSettings }),
    onSettingsChanged: (settings) => {
      void persistPilotSettingsFile(settings);
    },
    docTemplate,
    analysisTemplateOverlay,
  });
  process.stdout.write(
    [
      "",
      "  Maestro pilot hazır (DB-first) — model varyanttan (Studio), Jira GERÇEK, ADO sahte.",
      "",
      `  ▶ Tarayıcıdan aç:   ${stage.uiUrl}`,
      `    canlı Jira:       ${stage.jiraSite}`,
      `    sahte Azure DevOps: ${stage.adoUrl}`,
      "",
      "  Onaylar GERÇEK Jira'ya /approve yorumu yazılarak verilir. Durdurmak için Ctrl-C.",
      "",
    ].join("\n"),
  );

  install(() => stage.close());
}

if (isEntrypoint(import.meta.url)) {
  main().catch(fail);
}
