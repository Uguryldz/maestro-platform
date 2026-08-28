import type { Db } from "./client.js";

/**
 * Clears RUNTIME + demo data so the platform shows only real work, while
 * keeping everything an operator needs to keep working: logins, parameter
 * definitions and their versions, and uploaded document templates.
 *
 * This is the counterpart to the demo seed (`seed-demo.ts`, which writes the
 * 16 tables below). A prod deployment that was seeded with the demo fixture —
 * or a dev box that accumulated real+fake runs — becomes clean without a full
 * database drop, so the admin account and template/param configuration survive.
 *
 * KEEPS (never touched here):
 *   - User            (the admin login and any real accounts)
 *   - Param           (parameter DEFINITIONS — platform config)
 *   - DocTemplateVersion / DocTemplateOutputRow (uploaded corporate templates)
 *   - Session         (live logins — a reset must not sign the operator running
 *                      it out mid-reset; a session is runtime, but it is the
 *                      operator's OWN runtime, and losing it here is a footgun)
 *   - KillSwitch      (the emergency brake, M58 — clearing it would RELEASE the
 *                      brake as a side effect of a routine reset, the exact
 *                      silent release the durable table exists to prevent)
 *
 * CLEARS (order respects foreign keys — children before parents):
 */
const CLEAR_ORDER = [
  // children / leaf tables first
  "StepEvent",
  "Gate",
  "EvidencePackageRow",
  "LlmCall",
  "PublishState",
  "IdempotencyKey",
  "StrikeCounter",
  "RepoCard",
  "VariantVersion",
  "ParamVersion", // demo writes fake param VALUES; definitions in Param stay
  // then the parents
  "WorkflowRun",
  "RoutingRule",
  "JiraProjectBinding",
  "Application",
  "Variant",
  "SubscriptionAccount",
  "KnowledgeDoc",
] as const;

/**
 * Append-only tables (M30/M33): a DB trigger REFUSES both DELETE and TRUNCATE
 * on these, because a bank's journal and audit chain must be tamper-evident —
 * you cannot quietly erase them, by design. The demo seed nonetheless writes
 * fake rows here, so a reset must be able to clear them — but ONLY through an
 * explicit, logged bypass (`--purge-audit`), never as a side effect of a
 * routine reset. AnalysisTemplateVersion is append-only AND kept, so it is
 * never purged at all.
 */
const APPEND_ONLY_CLEARABLE = ["JournalEntry", "AuditLog"] as const;

/**
 * A minimal structural view of the client: one `$executeRawUnsafe` and the
 * table names. Taken by shape so the package's tests can pass a fake and this
 * file never needs the generated Prisma types at compile time.
 */
export interface ResetDb {
  $executeRawUnsafe(query: string): Promise<number>;
}

/**
 * TRUNCATE the runtime/demo tables in one statement so foreign keys never trip
 * mid-way. `RESTART IDENTITY` resets the autoincrement sequences (audit seq,
 * StepEvent id) so a cleaned platform starts numbering from 1 again; `CASCADE`
 * is a belt-and-braces guard, though CLEAR_ORDER already covers every child.
 *
 * Returns a per-table map (all counted as cleared) for the CLI to print. The
 * count is the table list, not row counts — TRUNCATE does not report rows, and
 * issuing 19 `SELECT count(*)` first would be a lie the instant rows change.
 */
export interface ResetOptions {
  /**
   * Also clear the append-only journal + audit tables (M30/M33). Requires
   * momentarily disabling their tamper-evidence triggers, so it is opt-in and
   * meant only for wiping DEMO data — never a routine operation on real audit
   * history. When false (default) those tables are left untouched.
   */
  purgeAudit?: boolean;
}

export async function resetRuntimeData(
  db: ResetDb,
  options: ResetOptions = {},
): Promise<Record<string, number>> {
  // Without --purge-audit the append-only tables must survive. But a plain
  // `TRUNCATE ... CASCADE` on WorkflowRun would cascade INTO JournalEntry and
  // trip its guard, so the routine reset lists every child explicitly (no
  // CASCADE) and never names an append-only table — the FK graph is satisfied
  // by CLEAR_ORDER alone.
  const tables = [...CLEAR_ORDER];
  const cleared: Record<string, number> = {};

  if (options.purgeAudit) {
    // The demo seed wrote fake journal/audit rows too. Clearing them means
    // suspending the tamper-evidence trigger for THIS session only — a
    // deliberate, opt-in bypass, restored in `finally` even on failure. The
    // append-only tables go LAST (after their WorkflowRun parent is gone).
    await db.$executeRawUnsafe(`SET session_replication_role = 'replica';`);
    try {
      const all = [...tables, ...APPEND_ONLY_CLEARABLE];
      const quoted = all.map((t) => `"${t}"`).join(", ");
      await db.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`);
      for (const t of all) cleared[t] = 1;
    } finally {
      await db.$executeRawUnsafe(`SET session_replication_role = 'origin';`);
    }
    return cleared;
  }

  const quoted = tables.map((t) => `"${t}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY;`);
  for (const t of tables) cleared[t] = 1;
  return cleared;
}

export { CLEAR_ORDER as RESET_TABLES, APPEND_ONLY_CLEARABLE as RESET_AUDIT_TABLES };

// Re-exported for the real client, which satisfies ResetDb structurally.
export type ResetableDb = Db & ResetDb;
