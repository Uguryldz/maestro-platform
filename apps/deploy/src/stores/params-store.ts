import type { ParamStore, PendingParamChange } from "@maestro/bff";
import type { ParamChange, ParamDefinition } from "@maestro/contracts";
import { GLOBAL_SCOPE_REF } from "@maestro/db";

/**
 * The Postgres-backed `ParamStore` (M71).
 *
 * The composition root passed `new InMemoryParamStore()` — with no definitions
 * at all — so every operational setting the installer seeded into `Param` and
 * `ParamVersion` was invisible to the BFF. The params screen showed an empty
 * definition list, and the settings, notify and routing screens could not read
 * the ladder, the channel routing or the data-class policy that were sitting in
 * the database the whole time. Worse, a restart silently reset whatever an
 * operator had changed, because the values only ever lived in the process.
 *
 * Reading the tables is the honest fix. The definitions are code-owned and
 * seeded (`DEFAULT_PARAM_DEFINITIONS`), the versions are the audit's
 * counterpart, and neither has a compiled-in fallback here: a parameter with no
 * row means the installer's seed never ran, and that is something an operator
 * must be told rather than have papered over.
 *
 * The delegates are structural, like every other store in this directory: the
 * BFF must not depend on a generated client.
 */

/** `""` in the column is the global scope; `null` is how the BFF spells it. */
function toScopeRef(stored: string): string | null {
  return stored === GLOBAL_SCOPE_REF ? null : stored;
}

function fromScopeRef(scopeRef: string | null): string {
  return scopeRef ?? GLOBAL_SCOPE_REF;
}

export interface ParamRow {
  key: string;
  scope: string;
  type: string;
  guarded: boolean;
  defJson: unknown;
}

export interface ParamDefinitionDelegate {
  findMany(args: { orderBy: { key: "asc" } }): Promise<ParamRow[]>;
}

export interface ParamVersionRow {
  key: string;
  scopeRef: string;
  version: number;
  valueJson: unknown;
  changedBy: string;
  approvedBy: string | null;
  at: Date;
}

export interface ParamVersionReadDelegate {
  findMany(args: {
    orderBy: [{ key: "asc" }, { scopeRef: "asc" }, { version: "asc" }];
  }): Promise<ParamVersionRow[]>;
}

/**
 * How a four-eyes version is APPLIED (the approved write).
 *
 * A proposal is not a version: it has no approver yet, and the database's own
 * CHECK refuses a guarded version without one (migration 0002). So an open
 * proposal cannot live in `ParamVersion` — it lives in `PendingParamChange`
 * (migration 0013, `PendingDelegate` below), durable across restarts. This
 * delegate writes the FINAL version once a second human has approved it.
 */
export interface ParamApplyDelegate {
  create(args: {
    data: {
      key: string;
      scopeRef: string;
      version: number;
      valueJson: object;
      guarded: boolean;
      changedBy: string;
      approvedBy: string | null;
      at: Date;
    };
  }): Promise<unknown>;
}

/** One open proposal row, as `PendingParamChange` stores it (scopeRef "" = global). */
export interface PendingRow {
  key: string;
  scopeRef: string;
  valueJson: unknown;
  proposedBy: string;
  at: Date;
}

/**
 * The `PendingParamChange` table (migration 0013). A proposal is a value with
 * no approver, which `ParamVersion`'s CHECK refuses — so the open queue is its
 * own table, keyed `(key, scopeRef)` for at most one open proposal per slot.
 */
export interface PendingDelegate {
  findMany(args: { orderBy: { key: "asc" } }): Promise<PendingRow[]>;
  upsert(args: {
    where: { key_scopeRef: { key: string; scopeRef: string } };
    create: { key: string; scopeRef: string; valueJson: object; proposedBy: string; at: Date };
    update: { valueJson: object; proposedBy: string; at: Date };
  }): Promise<unknown>;
  deleteMany(args: { where: { key: string; scopeRef: string } }): Promise<unknown>;
}

export class PrismaParamStore implements ParamStore {
  constructor(
    private readonly defs: ParamDefinitionDelegate,
    private readonly versions: ParamVersionReadDelegate & ParamApplyDelegate,
    /**
     * The durable open-proposal queue (migration 0013). Replaces the former
     * process-local Map so an open four-eyes proposal — a guarded parameter
     * change or an onboarding binding — survives a BFF restart.
     */
    private readonly proposals: PendingDelegate,
  ) {}

  /**
   * The definitions, as the params screen and `putParam`'s type check read
   * them. An unparseable `defJson` throws rather than yielding a definition
   * with no `descriptionKey`: the screen would render a blank row, and
   * `putParam` would accept any value for a parameter whose type it lost.
   */
  async definitions(): Promise<readonly ParamDefinition[]> {
    const rows = await this.defs.findMany({ orderBy: { key: "asc" } });
    return rows.map((row) => {
      const extra = asRecord(row.defJson, row.key);
      const enumValues = extra["enumValues"];
      const descriptionKey = extra["descriptionKey"];
      if (typeof descriptionKey !== "string" || descriptionKey.length === 0) {
        throw new Error(
          `parameter ${row.key} has no descriptionKey — the screen would render a blank row (M104)`,
        );
      }
      return {
        key: row.key,
        scope: row.scope,
        type: row.type,
        guarded: row.guarded,
        ...(Array.isArray(enumValues) ? { enumValues: enumValues as string[] } : {}),
        descriptionKey,
        defaultValue: extra["defaultValue"],
      } as ParamDefinition;
    });
  }

  async values(): Promise<readonly ParamChange[]> {
    const rows = await this.versions.findMany({
      orderBy: [{ key: "asc" }, { scopeRef: "asc" }, { version: "asc" }],
    });
    return rows.map((row) => ({
      key: row.key,
      scopeRef: toScopeRef(row.scopeRef),
      value: row.valueJson,
      version: row.version,
      changedBy: row.changedBy,
      approvedBy: row.approvedBy,
      at: row.at.toISOString(),
    }));
  }

  async pending(): Promise<readonly PendingParamChange[]> {
    const rows = await this.proposals.findMany({ orderBy: { key: "asc" } });
    return rows.map((row) => ({
      key: row.key,
      scopeRef: toScopeRef(row.scopeRef),
      value: row.valueJson,
      proposedBy: row.proposedBy,
      at: row.at.toISOString(),
    }));
  }

  async putPending(change: PendingParamChange): Promise<void> {
    const scopeRef = fromScopeRef(change.scopeRef);
    const at = new Date(change.at);
    const value = change.value as object;
    await this.proposals.upsert({
      where: { key_scopeRef: { key: change.key, scopeRef } },
      create: { key: change.key, scopeRef, valueJson: value, proposedBy: change.proposedBy, at },
      update: { valueJson: value, proposedBy: change.proposedBy, at },
    });
  }

  async clearPending(key: string, scopeRef: string | null): Promise<void> {
    await this.proposals.deleteMany({ where: { key, scopeRef: fromScopeRef(scopeRef) } });
  }

  /**
   * Insert the new version.
   *
   * `guarded` is read from the definition rather than taken from the caller —
   * a caller that could pass `false` for a guarded key would turn the
   * database's four-eyes CHECK into decoration. The insert then either
   * satisfies that constraint or is refused by Postgres, which is the point of
   * having it there rather than only here.
   */
  // `_options.allowSelfApprove` is accepted for interface parity with the
  // ParamStore port. This store writes the version row directly (it does not go
  // through `writeParamVersion`, so the "approver ≠ author" application check
  // never runs here); the only DB guard is the `approvedBy IS NOT NULL` CHECK,
  // which a master-admin self-approval satisfies by recording itself as
  // approver. The flag therefore needs no branch here — the BFF already decided.
  async apply(change: ParamChange, _options?: { allowSelfApprove?: boolean }): Promise<void> {
    const definitions = await this.defs.findMany({ orderBy: { key: "asc" } });
    const definition = definitions.find((row) => row.key === change.key);
    if (definition === undefined) {
      throw new Error(`no parameter definition for ${change.key}`);
    }

    await this.versions.create({
      data: {
        key: change.key,
        scopeRef: fromScopeRef(change.scopeRef),
        version: change.version,
        valueJson: asJson(change.value, change.key),
        guarded: definition.guarded,
        changedBy: change.changedBy,
        approvedBy: change.approvedBy,
        at: new Date(change.at),
      },
    });
  }
}

function asRecord(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`parameter ${key} has an unusable definition column`);
  }
  return value as Record<string, unknown>;
}

/**
 * A parameter value on its way into a JSON column.
 *
 * `undefined` is refused rather than passed through: Prisma writes it as SQL
 * `NULL`, and a parameter that reads back as `null` is indistinguishable from
 * one deliberately set to null — while the caller believed they saved a value.
 */
function asJson(value: unknown, key: string): object {
  if (value === undefined) {
    throw new Error(`parameter ${key}: cannot store undefined — it would read back as null`);
  }
  return value as object;
}
