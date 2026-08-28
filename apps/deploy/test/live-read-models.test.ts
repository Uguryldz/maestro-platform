import { createDb, type Db } from "@maestro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaAppRegistry, PrismaGateBoard, PrismaJournalReader } from "../src/stores/read-journal.js";
import {
  PrismaCostReader,
  PrismaEvidenceReader,
  PrismaKnowledgeIndex,
  PrismaQuotaReader,
} from "../src/stores/read-catalog.js";
import { postgresProbe, ProbeHealthReader } from "../src/stores/read-health.js";
import { PrismaRunCatalog } from "../src/stores/read-runs.js";
import { PrismaSandboxReader } from "../src/stores/read-sandbox.js";
import { AuditChain } from "@maestro/audit";
import { postgresChainLock, PrismaAuditStore } from "../src/stores/audit.js";
import { prismaTransactionRunner } from "../src/stores/sql.js";

/**
 * The read models against a REAL Postgres.
 *
 * The offline suite proves the paging and scoping logic against fakes. This
 * proves the half a fake cannot: that the structural delegate interfaces in
 * `read-*.ts` actually BIND to the generated Prisma client. Every one of them
 * is a hand-written description of a method the client is assumed to have —
 * `groupBy` with a `_sum`, a nested `run` relation filter, `mode:
 * "insensitive"` — and a description that has drifted from the client
 * typechecks perfectly and fails at the first call.
 *
 * Opt-in, exactly like `live-stores.test.ts`, so the wave gate stays offline:
 *
 *   docker run -d --rm -p 55438:5432 -e POSTGRES_PASSWORD=x \
 *     -e POSTGRES_USER=maestro -e POSTGRES_DB=maestro --name pg postgres:18-alpine
 *   TEST_DATABASE_URL=postgresql://maestro:x@localhost:55438/maestro \
 *     pnpm -F @maestro/deploy test
 */
const url = process.env["TEST_DATABASE_URL"];
const live = url === undefined ? describe.skip : describe;

live("read models against a live database", () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb(url as string);
    await reset(db);
    await seed(db);
  });

  afterAll(async () => {
    // Leave the database as this suite found it. `live-stores.test.ts` shares
    // it and its own reset cannot delete a run while one of this suite's
    // journal entries still references it (onDelete: Restrict) — so a suite
    // that only cleaned up on the way IN would break whichever file ran next.
    await reset(db);
    await db.$disconnect();
  });

  describe("RunCatalog", () => {
    it("lists runs newest-first with consumption joined from the call log", async () => {
      const catalog = new PrismaRunCatalog(db.workflowRun, db.llmCall);

      // Scoped to this suite's two projects: `live-stores.test.ts` shares the
      // database, and asserting over "every row in the table" would make this
      // test depend on which files ran before it.
      const page = await catalog.list({
        limit: 10,
        cursor: null,
        appId: null,
        projectKeys: ["LIVEPAY", "LIVEWEB"],
        archived: "all",
      });

      expect(page.items.map((item) => item.ticketKey)).toEqual([
        "LIVEPAY-3",
        "LIVEPAY-2",
        "LIVEWEB-1",
      ]);
      const withCost = page.items.find((item) => item.ticketKey === "LIVEPAY-2");
      expect(withCost?.costUsd).toBeCloseTo(0.5, 6);
      expect(withCost?.tokensIn).toBe(1000);
    });

    it("keeps another project's runs out of a scoped page", async () => {
      const catalog = new PrismaRunCatalog(db.workflowRun, db.llmCall);

      const page = await catalog.list({
        limit: 10,
        cursor: null,
        appId: null,
        projectKeys: ["LIVEPAY"],
        archived: "all",
      });

      expect(page.items.map((item) => item.ticketKey)).toEqual(["LIVEPAY-3", "LIVEPAY-2"]);
    });

    it("pages through the scoped set without repeating or skipping a row", async () => {
      const catalog = new PrismaRunCatalog(db.workflowRun, db.llmCall);
      const seen: string[] = [];
      let cursor: string | null = null;

      for (let guard = 0; guard < 5; guard += 1) {
        const page: Awaited<ReturnType<typeof catalog.list>> = await catalog.list({
          limit: 1,
          cursor,
          appId: null,
          projectKeys: ["LIVEPAY", "LIVEWEB"],
        archived: "all",
        });
        seen.push(...page.items.map((item) => item.ticketKey));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }

      expect(seen).toEqual(["LIVEPAY-3", "LIVEPAY-2", "LIVEWEB-1"]);
    });

    it("narrows by appId", async () => {
      const catalog = new PrismaRunCatalog(db.workflowRun, db.llmCall);

      const page = await catalog.list({
        limit: 10,
        cursor: null,
        appId: "live-web",
        projectKeys: null,
        archived: "all",
      });

      expect(page.items.map((item) => item.ticketKey)).toEqual(["LIVEWEB-1"]);
    });

    it("reads the fan-out parent back out of the stored match", async () => {
      const catalog = new PrismaRunCatalog(db.workflowRun, db.llmCall);

      const record = await catalog.get("LIVEPAY-3");

      expect(record?.parentTicketKey).toBe("LIVEPAY-2");
    });
  });

  describe("JournalReader", () => {
    it("reads a run's entries in sequence order", async () => {
      const reader = new PrismaJournalReader(db.journalEntry);

      const page = await reader.list("live-run-2", { limit: 10, cursor: null, actor: null });

      expect(page.items.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    });

    it("filters by actor", async () => {
      const reader = new PrismaJournalReader(db.journalEntry);

      const page = await reader.list("live-run-2", { limit: 10, cursor: null, actor: "human" });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.actor).toBe("human");
    });

    it("reports no summary rather than inventing one", async () => {
      const reader = new PrismaJournalReader(db.journalEntry);
      expect(await reader.summary("live-run-2")).toBeNull();
    });
  });

  describe("GateBoard", () => {
    it("lists only OPEN gates, oldest first", async () => {
      const board = new PrismaGateBoard(db.gate);

      const page = await board.listOpen({
        limit: 10,
        cursor: null,
        ownerGroup: null,
        projectKeys: ["LIVEPAY", "LIVEWEB"],
      });

      // The closed gate on LIVEPAY-3 must not appear.
      expect(page.items.map((gate) => gate.step)).toEqual(["4"]);
      expect(page.items[0]?.ticketKey).toBe("LIVEPAY-2");
    });

    it("scopes gates through the run's project", async () => {
      const board = new PrismaGateBoard(db.gate);

      const page = await board.listOpen({
        limit: 10,
        cursor: null,
        ownerGroup: null,
        projectKeys: ["LIVEWEB"],
      });

      expect(page.items).toEqual([]);
    });

    it("filters by owning group", async () => {
      const board = new PrismaGateBoard(db.gate);

      const scope = ["LIVEPAY", "LIVEWEB"];
      const mine = await board.listOpen({
        limit: 10,
        cursor: null,
        ownerGroup: "product-owners",
        projectKeys: scope,
      });
      const theirs = await board.listOpen({
        limit: 10,
        cursor: null,
        ownerGroup: "someone-else",
        projectKeys: scope,
      });

      expect(mine.items).toHaveLength(1);
      expect(theirs.items).toEqual([]);
    });
  });

  describe("AppRegistry", () => {
    it("reads an application and its newest repo card", async () => {
      const registry = new PrismaAppRegistry(db.application, db.repoCard);

      const app = await registry.get("live-pay");
      const card = await registry.repoCard("live-pay");

      expect(app?.displayName).toBe("Live Pay");
      // Two versions exist; the card is the newest.
      expect(card?.version).toBe(2);
      expect(card?.modules).toHaveLength(1);
    });

    it("returns null for an app that has no card, rather than an empty card", async () => {
      const registry = new PrismaAppRegistry(db.application, db.repoCard);
      expect(await registry.repoCard("live-web")).toBeNull();
    });

    it("lists applications alphabetically", async () => {
      const registry = new PrismaAppRegistry(db.application, db.repoCard);

      // The registry is deliberately unscoped, so a shared database may hold
      // another suite's apps. The property under test is the ORDER, asserted
      // over the whole page, plus that this suite's rows are in it.
      const page = await registry.list({ limit: 50, cursor: null });
      const ids = page.items.map((app) => app.appId);

      expect(ids).toEqual([...ids].sort());
      expect(ids).toContain("live-pay");
      expect(ids).toContain("live-web");
    });
  });

  describe("KnowledgeIndex", () => {
    it("finds a document by title, case-insensitively", async () => {
      const index = new PrismaKnowledgeIndex(db.knowledgeDoc);

      const page = await index.search({ limit: 10, cursor: null, text: "BDDK", appId: null });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.title).toBe("bddk-uyum.md");
    });

    it("classifies an unlabelled document as gizli (M18)", async () => {
      const index = new PrismaKnowledgeIndex(db.knowledgeDoc);

      const page = await index.search({ limit: 10, cursor: null, text: "bddk", appId: null });

      expect(page.items[0]?.dataClass).toBe("gizli");
    });
  });

  describe("QuotaReader / CostReader / EvidenceReader", () => {
    it("reads the subscription pool with its windows", async () => {
      const quota = new PrismaQuotaReader(db.subscriptionAccount);

      const accounts = await quota.accounts();

      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.accountId).toBe("live-sub-1");
      expect(accounts[0]?.windows).toHaveLength(1);
    });

    it("reads a run's calls, newest first, keeping a subscription call's null usd", async () => {
      const cost = new PrismaCostReader(db.llmCall);

      const page = await cost.calls({ limit: 10, cursor: null, runId: "live-run-2" });

      expect(page.items).toHaveLength(2);
      expect(page.items[0]?.usd).toBeNull();
      expect(page.items[1]?.usd).toBeCloseTo(0.5, 6);
    });

    it("reads the evidence manifest, and null before one is built", async () => {
      const evidence = new PrismaEvidenceReader(db.evidencePackageRow);

      const manifest = await evidence.get("live-run-2");

      expect(manifest?.ticketKey).toBe("LIVEPAY-2");
      expect(await evidence.get("live-run-1")).toBeNull();
    });
  });

  describe("SandboxReader", () => {
    /**
     * Proves the delegate binds to the real client: `action: { in: [...] }` and
     * `orderBy: { seq: "desc" }` are hand-written descriptions of the generated
     * client's `findMany`, and a description that has drifted typechecks and
     * fails at the first call. Appended through `AuditChain` because the table
     * is a hash chain — a bare `createMany` would need valid `prevHash`/`hash`.
     */
    it("folds SANDBOX_CREATE/DESTROY events into workspace state", async () => {
      const chain = new AuditChain({
        store: new PrismaAuditStore(db.auditLog),
        lock: postgresChainLock(prismaTransactionRunner(db)),
      });

      // One workspace still open, one already destroyed. Ticket keys are unique
      // to this suite so a shared audit log's other rows do not interfere.
      await chain.append({
        actor: "maestro-runner",
        action: "SANDBOX_CREATE",
        subject: "LIVEBOX-1 · live-runner-a",
        meta: { ticketKey: "LIVEBOX-1", runner: "live-runner-a" },
      });
      await chain.append({
        actor: "maestro-runner",
        action: "SANDBOX_CREATE",
        subject: "LIVEBOX-2 · live-runner-b",
        meta: { ticketKey: "LIVEBOX-2", runner: "live-runner-b" },
      });
      await chain.append({
        actor: "maestro-runner",
        action: "SANDBOX_DESTROY",
        subject: "LIVEBOX-2 · live-runner-b",
        meta: { ticketKey: "LIVEBOX-2", runner: "live-runner-b" },
      });

      const reader = new PrismaSandboxReader(db.auditLog);
      const page = await reader.sandboxes({ limit: 50, cursor: null });
      const mine = page.items.filter((box) => box.ticketKey.startsWith("LIVEBOX-"));

      const byKey = new Map(mine.map((box) => [box.ticketKey, box]));
      expect(byKey.get("LIVEBOX-1")?.state).toBe("active");
      expect(byKey.get("LIVEBOX-2")?.state).toBe("resumable");
      expect(byKey.get("LIVEBOX-1")?.runnerId).toBe("live-runner-a");
    });
  });

  describe("HealthReader", () => {
    it("reports a reachable database healthy", async () => {
      const reader = new ProbeHealthReader([postgresProbe(db)]);

      const [service] = await reader.services();

      expect(service?.service).toBe("postgres");
      expect(service?.state).toBe("healthy");
    });
  });
});

/** The fixture: two projects, three runs, and one of everything else. */
async function seed(db: Db): Promise<void> {
  await db.application.createMany({
    data: [
      {
        appId: "live-pay",
        displayName: "Live Pay",
        adoProject: "Core",
        adoRepo: "pay",
        platform: "linux-node",
        maestroYamlPresent: true,
        createdVia: "onboarding",
      },
      {
        appId: "live-web",
        displayName: "Live Web",
        adoProject: "Core",
        adoRepo: "web",
        platform: "linux-node",
        maestroYamlPresent: false,
        createdVia: "import",
      },
    ],
  });

  await db.repoCard.createMany({
    data: [1, 2].map((version) => ({
      appId: "live-pay",
      version,
      modulesJson: [{ name: "api", path: "src/api", summary: `v${version}` }],
      generatedFromSha: "a".repeat(40),
      updatedAt: new Date(`2026-0${version}-01T00:00:00.000Z`),
    })),
  });

  const run = (
    id: string,
    ticketKey: string,
    appId: string,
    updatedAt: string,
    matchJson: object,
  ) => ({
    id,
    ticketKey,
    appId,
    mode: "full_auto" as const,
    risk: "orta" as const,
    dataClass: "dahili" as const,
    step: "3",
    status: "running" as const,
    matchJson,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date(updatedAt),
  });

  await db.workflowRun.createMany({
    data: [
      run("live-run-1", "LIVEWEB-1", "live-web", "2026-02-01T00:00:00.000Z", {
        via: "rule",
        ruleId: "r1",
        appId: "live-web",
      }),
      run("live-run-2", "LIVEPAY-2", "live-pay", "2026-03-01T00:00:00.000Z", {
        via: "rule",
        ruleId: "r2",
        appId: "live-pay",
      }),
      run("live-run-3", "LIVEPAY-3", "live-pay", "2026-04-01T00:00:00.000Z", {
        via: "analysis_fanout",
        appId: "live-pay",
        parentTicketKey: "LIVEPAY-2",
      }),
    ],
  });

  await db.journalEntry.createMany({
    data: [
      { runId: "live-run-2", seq: 1, at: new Date("2026-03-01T01:00:00.000Z"), actor: "system", kind: "intake", title: "alindi", detail: "" },
      { runId: "live-run-2", seq: 2, at: new Date("2026-03-01T02:00:00.000Z"), actor: "ai", kind: "analysis", title: "analiz", detail: "" },
      { runId: "live-run-2", seq: 3, at: new Date("2026-03-01T03:00:00.000Z"), actor: "human", kind: "gate", title: "onay", detail: "" },
    ],
  });

  await db.gate.createMany({
    data: [
      {
        runId: "live-run-2",
        step: "4",
        ownerGroup: "product-owners",
        openedAt: new Date("2026-03-02T00:00:00.000Z"),
        firedStepIds: [],
        closedAt: null,
      },
      {
        runId: "live-run-3",
        step: "5",
        ownerGroup: "tech-leads",
        openedAt: new Date("2026-03-01T00:00:00.000Z"),
        firedStepIds: [],
        closedAt: new Date("2026-03-03T00:00:00.000Z"),
      },
    ],
  });

  await db.knowledgeDoc.create({
    data: {
      id: "bddk-uyum",
      kind: "policy",
      title: "bddk-uyum.md",
      version: 1,
      contentRef: "knowledge/bddk-uyum.md",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  await db.subscriptionAccount.create({
    data: {
      accountId: "live-sub-1",
      driver: "claude-sub",
      state: "ready",
      windowsJson: [{ kind: "five_hour", limit: 100, used: 10, resetsAt: "2026-08-10T12:00:00.000Z" }],
      lastUsedAt: null,
    },
  });

  await db.llmCall.createMany({
    data: [
      {
        at: new Date("2026-03-01T01:00:00.000Z"),
        runId: "live-run-2",
        role: "analyst",
        variantId: "v1",
        driver: "anthropic-direct",
        model: "claude-opus-5",
        tokensIn: 1000,
        tokensOut: 200,
        usd: "0.5",
        dataClass: "dahili",
      },
      {
        at: new Date("2026-03-01T02:00:00.000Z"),
        runId: "live-run-2",
        role: "engineer",
        variantId: "v1",
        driver: "claude-sub",
        model: "claude-opus-5",
        tokensIn: 0,
        tokensOut: 0,
        usd: null,
        dataClass: "dahili",
      },
    ],
  });

  await db.evidencePackageRow.create({
    data: {
      runId: "live-run-2",
      ticketKey: "LIVEPAY-2",
      createdAt: new Date("2026-03-05T00:00:00.000Z"),
      manifestJson: {
        runId: "live-run-2",
        ticketKey: "LIVEPAY-2",
        createdAt: "2026-03-05T00:00:00.000Z",
        templateVersion: "analysis@1.0.0",
        files: [{ name: "analysis.md", sha256: "b".repeat(64), bytes: 12, contentType: "text/markdown" }],
        approvals: [],
        retentionYears: 10,
        objectLock: false,
      },
      storageKey: "evidence/live-run-2.zip",
    },
  });
}

/**
 * Clean slate, in dependency order — and only for THIS suite's rows.
 *
 * Scoped by id prefix rather than emptying the tables. `live-stores.test.ts`
 * shares the database and vitest may run it concurrently, so a blanket
 * `deleteMany` would delete rows the other suite is still using — and, because
 * every relation is `onDelete: Restrict`, would simply fail against whatever
 * that suite had open. Each file owning its own rows is what lets both run in
 * either order, together or alone.
 */
const OWNED = { startsWith: "live-" };

async function reset(db: Db): Promise<void> {
  await db.gate.deleteMany({ where: { runId: OWNED } });
  await db.llmCall.deleteMany({ where: { runId: OWNED } });
  await db.evidencePackageRow.deleteMany({ where: { runId: OWNED } });
  await db.knowledgeDoc.deleteMany({ where: { id: "bddk-uyum" } });
  await db.subscriptionAccount.deleteMany({ where: { accountId: OWNED } });
  await clearJournal(db);
  await db.workflowRun.deleteMany({ where: { id: OWNED } });
  await db.repoCard.deleteMany({ where: { appId: OWNED } });
  await db.application.deleteMany({ where: { appId: OWNED } });
  await clearSandboxAudit(db);
}

/**
 * `AuditLog` is append-only (migration 0001), so this suite's sandbox events
 * are removed the same trigger-disabled way `clearJournal` clears the journal —
 * and only THIS suite's rows (`LIVEBOX-%` subjects), so a concurrent
 * `live-stores.test.ts` audit chain survives.
 */
async function clearSandboxAudit(db: Db): Promise<void> {
  await db.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_append_only"');
  try {
    await db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "subject" LIKE $1`, "LIVEBOX-%");
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER "AuditLog_append_only"');
  }
}

/**
 * `JournalEntry` is append-only for every client (migration 0002), so a plain
 * `deleteMany` is refused. Disabling the trigger for one statement is a
 * deliberate, test-only act on a throwaway database — the same exception
 * `live-stores.test.ts` makes for the audit log.
 */
async function clearJournal(db: Db): Promise<void> {
  await db.$executeRawUnsafe('ALTER TABLE "JournalEntry" DISABLE TRIGGER "JournalEntry_append_only"');
  try {
    // Only this suite's entries, and parameterised — same ownership rule as
    // `reset`, so a concurrent suite's journal survives.
    await db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "runId" LIKE $1`, "live-%");
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE "JournalEntry" ENABLE TRIGGER "JournalEntry_append_only"');
  }
}
