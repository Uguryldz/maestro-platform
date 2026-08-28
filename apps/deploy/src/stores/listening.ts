import {
  parseStatusMap,
  type FlowType,
  type ListeningRuleRecord,
  type ListeningStore,
  type MatchKind,
  type StatusMap,
} from "@maestro/bff";
import { DB_NULL, type DbNull } from "@maestro/db";

/**
 * The Postgres-backed `ListeningStore` ("dinleme kuralları" surface).
 *
 * A listening rule is platform configuration an admin edits from Studio, so it
 * must survive a restart the same way connections and parameters do. This reads
 * and writes the `ListeningRule` table (migration 0011).
 *
 * The delegate is structural, like every other store here: `apps/bff` must not
 * depend on the generated client, and this file compiles before
 * `prisma generate` has run. The DB's CHECK constraints (matchKind/flowType
 * domains) are the source of truth; the narrowing casts below are honest because
 * the Zod validator on the write path is the only producer.
 */

/** One `ListeningRule` row, as read/written. */
export interface ListeningRuleRow {
  ruleId: string;
  projectKey: string;
  assigneeAccountId: string;
  matchKind: string;
  matchValue: string;
  flowType: string;
  priority: number;
  enabled: boolean;
  /**
   * Faz 3 (akış→ajan): the agent variant this rule's flow runs under, per side.
   * NULL = the platform default agent — exactly the pre-mapping behaviour.
   */
  analystVariantId: string | null;
  engineerVariantId: string | null;
  /**
   * The optional Jira status map, as the jsonb column holds it (migration 0018).
   * `unknown` rather than the parsed type on purpose: this is the DB's word, not
   * the platform's, and the column can hold anything an operator's psql session
   * put there. It is validated on the way out, never trusted on the way in.
   * NULL = comment-only mode.
   */
  statusMapJson?: unknown;
}

/**
 * We mean SQL NULL, not the JSON value null.
 *
 * Comment-only mode is the ABSENCE of a map. `parseStatusMap` would read either
 * one back as `null`, so both would work from inside the platform — but only
 * SQL NULL keeps `statusMapJson IS NULL` honest for anyone querying this table
 * from psql, which is how the operator actually inspects it.
 *
 * `DB_NULL` comes from `@maestro/db` and IS Prisma's own value. An earlier
 * revision of this file invented a look-alike sentinel to avoid importing the
 * client here — it type-checked, it passed every test against the fake
 * delegate, and it wrote the literal object `{"_tag":"DbNull"}` into the column
 * on the live database. The driver's own value is the only one the driver
 * honours.
 */
/**
 * What this store WRITES, which is not what it reads.
 *
 * Reading, `statusMapJson` is `unknown` — the column may hold whatever an
 * operator's psql session put there, and the parse on the way out is what makes
 * it safe. Writing, `unknown` is exactly wrong: Prisma's generated input type
 * accepts `InputJsonValue | NullableJsonNullValueInput`, and `unknown` widens
 * past all of them, so a delegate typed for reading cannot satisfy the client's
 * `create`/`update`. That mismatch took `@maestro/demo-stack`'s typecheck down
 * the moment migration 0018 landed.
 *
 * Two types rather than one cast, because the asymmetry is real and worth
 * naming: what we accept FROM the database is broader than what we send TO it.
 */
type ListeningRuleWrite = Omit<ListeningRuleRow, "statusMapJson"> & {
  statusMapJson: StatusMap | DbNull;
};

export interface ListeningDelegate {
  findMany(args: {
    orderBy: [{ projectKey: "asc" }, { priority: "asc" }];
  }): Promise<ListeningRuleRow[]>;
  findUnique(args: { where: { ruleId: string } }): Promise<ListeningRuleRow | null>;
  upsert(args: {
    where: { ruleId: string };
    create: ListeningRuleWrite;
    update: Omit<ListeningRuleWrite, "ruleId">;
  }): Promise<unknown>;
  delete(args: { where: { ruleId: string } }): Promise<ListeningRuleRow>;
}

export class PrismaListeningStore implements ListeningStore {
  /**
   * `onWarn` reports a status map that failed to parse. Injectable, and
   * defaulted rather than required, because the degradation must be VISIBLE:
   * a rule whose map was silently dropped looks to an operator like Maestro
   * ignoring the board they configured, with nothing anywhere saying why.
   */
  constructor(
    private readonly rules: ListeningDelegate,
    private readonly onWarn: (message: string) => void = (message) => console.warn(message),
  ) {}

  async list(): Promise<readonly ListeningRuleRecord[]> {
    const rows = await this.rules.findMany({
      orderBy: [{ projectKey: "asc" }, { priority: "asc" }],
    });
    return rows.map((row) => this.toRecord(row));
  }

  async get(ruleId: string): Promise<ListeningRuleRecord | null> {
    const row = await this.rules.findUnique({ where: { ruleId } });
    return row === null ? null : this.toRecord(row);
  }

  async put(record: ListeningRuleRecord): Promise<void> {
    const row = toRow(record);
    const { ruleId: _ruleId, ...update } = row;
    await this.rules.upsert({ where: { ruleId: record.ruleId }, create: row, update });
  }

  async remove(ruleId: string): Promise<boolean> {
    // `delete` throws when the row is absent; a concurrent delete becomes the
    // "not found" the contract wants rather than an unhandled Prisma error.
    try {
      await this.rules.delete({ where: { ruleId } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A row as the platform sees it. The status map is the only field that can be
   * WRONG in the database rather than merely absent — it is free-shaped jsonb —
   * so it is parsed fail-safe: a map that does not validate degrades to `null`
   * (comment-only mode) and the rest of the rule is returned intact. Throwing
   * here would let one hand-edited row take the whole rule list down, and with
   * it discovery for every project.
   */
  private toRecord(row: ListeningRuleRow): ListeningRuleRecord {
    // The DbNull sentinel is an INSTRUCTION to the driver, never a stored value:
    // Postgres answers a cleared column with SQL NULL, so this branch is dead
    // against the real client. It is not dead against an in-memory fake, which
    // hands back exactly what it was given — and there the sentinel would parse
    // as a malformed map and warn about a rule nobody mis-edited. A warning that
    // fires on the healthy path teaches an operator to ignore warnings.
    // Postgres answers a cleared column with SQL NULL, so `DB_NULL` never comes
    // back from the real driver — this branch exists for an in-memory fake,
    // which returns whatever it was handed. Without it the sentinel would parse
    // as a malformed map and warn about a rule nobody mis-edited, and a warning
    // that fires on the healthy path teaches an operator to ignore warnings.
    const stored = row.statusMapJson === DB_NULL ? null : row.statusMapJson;
    const statusMap = parseStatusMap(stored, (reason) => {
      this.onWarn(
        `[maestro] listening rule ${row.ruleId}: statusMapJson ignored (${reason}) — ` +
          "the rule falls back to comment-only mode",
      );
    });
    return { ...toRecordBase(row), statusMap };
  }
}

function toRecordBase(row: ListeningRuleRow): Omit<ListeningRuleRecord, "statusMap"> {
  return {
    ruleId: row.ruleId,
    projectKey: row.projectKey,
    assigneeAccountId: row.assigneeAccountId,
    matchKind: row.matchKind as MatchKind,
    matchValue: row.matchValue,
    flowType: row.flowType as FlowType,
    priority: row.priority,
    enabled: row.enabled,
    // Faz 3 agent mapping — NULL stays null ("default agent"), never dropped,
    // so a rule read back carries exactly the mapping Studio saved.
    analystVariantId: row.analystVariantId,
    engineerVariantId: row.engineerVariantId,
  };
}

function toRow(record: ListeningRuleRecord): ListeningRuleWrite {
  return {
    ruleId: record.ruleId,
    projectKey: record.projectKey,
    assigneeAccountId: record.assigneeAccountId,
    matchKind: record.matchKind,
    matchValue: record.matchValue,
    flowType: record.flowType,
    priority: record.priority,
    enabled: record.enabled,
    // The record's absent-or-null both mean "default agent"; the column stores
    // that one way (NULL), so undefined is normalised here.
    analystVariantId: record.analystVariantId ?? null,
    engineerVariantId: record.engineerVariantId ?? null,
    // Absent and null both mean comment-only mode, and the column stores that
    // one way (NULL). Re-validated on the way in even though the route's Zod
    // already checked it: `put` is a store method, and a store that trusts its
    // caller to have validated is a store that will one day persist a shape the
    // read path then has to defend against forever.
    // `DB_NULL` and not `null`: see its declaration — Prisma refuses a bare
    // null here, and SQL NULL is the shape the read path and psql both expect.
    statusMapJson: parseStatusMap(record.statusMap ?? null) ?? DB_NULL,
  };
}
