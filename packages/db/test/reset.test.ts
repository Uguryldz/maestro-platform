import { describe, expect, it } from "vitest";
import { RESET_AUDIT_TABLES, RESET_TABLES, resetRuntimeData, type ResetDb } from "../src/reset.js";

class FakeResetDb implements ResetDb {
  queries: string[] = [];
  $executeRawUnsafe(query: string): Promise<number> {
    this.queries.push(query);
    return Promise.resolve(0);
  }
}

describe("resetRuntimeData", () => {
  it("truncates every runtime/demo table in one FK-safe statement", async () => {
    const db = new FakeResetDb();
    const cleared = await resetRuntimeData(db);

    expect(db.queries).toHaveLength(1);
    const sql = db.queries[0]!;
    expect(sql).toMatch(/^TRUNCATE TABLE /);
    expect(sql).toContain("RESTART IDENTITY");
    // routine reset must NOT cascade — a cascade would reach the append-only
    // JournalEntry and trip its guard.
    expect(sql).not.toContain("CASCADE");
    for (const table of RESET_TABLES) {
      expect(sql, `must clear ${table}`).toContain(`"${table}"`);
    }
    expect(Object.keys(cleared).sort()).toEqual([...RESET_TABLES].sort());
  });

  it("leaves the append-only journal/audit alone by default", async () => {
    const db = new FakeResetDb();
    const cleared = await resetRuntimeData(db);
    // default reset issues exactly one TRUNCATE and touches no audit table
    expect(db.queries).toHaveLength(1);
    for (const t of RESET_AUDIT_TABLES) {
      expect(cleared).not.toHaveProperty(t);
      expect(db.queries[0]!).not.toContain(`"${t}"`);
    }
    // the append-only tables are NEVER in the routine clear list
    for (const t of RESET_AUDIT_TABLES) {
      expect(RESET_TABLES as readonly string[]).not.toContain(t);
    }
  });

  it("purges journal/audit only via explicit opt-in, restoring the trigger guard", async () => {
    const db = new FakeResetDb();
    const cleared = await resetRuntimeData(db, { purgeAudit: true });
    // it must suspend user triggers, truncate (incl. audit tables), then restore
    const suspend = db.queries.findIndex((q) => q.includes("'replica'"));
    const restore = db.queries.findIndex((q) => q.includes("'origin'"));
    const auditTrunc = db.queries.findIndex((q) => q.includes('"AuditLog"'));
    expect(suspend).toBeGreaterThanOrEqual(0);
    expect(suspend).toBeLessThan(auditTrunc);
    expect(auditTrunc).toBeLessThan(restore);
    for (const t of RESET_AUDIT_TABLES) expect(cleared).toHaveProperty(t);
  });

  it("NEVER clears the tables an operator needs to keep working", async () => {
    // Logins, parameter DEFINITIONS, analysis + doc templates must survive a
    // reset — otherwise the admin is locked out and the platform is unconfigured.
    // Session and KillSwitch join the kept set (Dalga E): a routine reset must
    // not sign the operator out or, worse, RELEASE the emergency brake (M58).
    const kept = [
      "User",
      "Param",
      "AnalysisTemplateVersion",
      "DocTemplateVersion",
      "DocTemplateOutputRow",
      "Session",
      "KillSwitch",
    ];
    for (const table of kept) {
      expect(RESET_TABLES as readonly string[], `${table} must be KEPT`).not.toContain(table);
    }
  });

  it("orders children before parents so foreign keys never trip", () => {
    const idx = (t: string) => (RESET_TABLES as readonly string[]).indexOf(t);
    // WorkflowRun is the parent of these; it must be truncated AFTER them
    // (TRUNCATE CASCADE is a guard, but the order documents the real graph).
    expect(idx("JournalEntry")).toBeLessThan(idx("WorkflowRun"));
    expect(idx("StepEvent")).toBeLessThan(idx("WorkflowRun"));
    expect(idx("RoutingRule")).toBeLessThan(idx("JiraProjectBinding"));
    expect(idx("RepoCard")).toBeLessThan(idx("Application"));
    expect(idx("VariantVersion")).toBeLessThan(idx("Variant"));
  });
});
