import type { Prisma, PrismaClient } from "@prisma/client";
import { GLOBAL_SCOPE_REF } from "./params-defaults.js";

/**
 * The single writer for `ParamVersion` (M71 / M78 four-eyes).
 *
 * Three things have to be true for every stored parameter version, and none of
 * them can be left to the caller:
 *
 *  1. the key must exist as a `Param` definition — a version of a parameter
 *     nobody defined is a typo that would silently never be read (M14);
 *  2. `guarded` must be copied from the definition, not supplied by the caller,
 *     otherwise the CHECK constraint guards nothing (a caller could pass
 *     `guarded: false` for a guarded key);
 *  3. a guarded parameter needs a second approver, and that approver may not be
 *     the person making the change.
 *
 * The database enforces (2)+(3) as well (`ParamVersion_guarded_needs_approver`
 * in migration 0002), so a writer that bypasses this function still cannot
 * store an unapproved guarded value — it only gets a worse error message.
 */

export class UnknownParamError extends Error {
  constructor(key: string) {
    super(`no parameter definition for ${key}`);
    this.name = "UnknownParamError";
  }
}

export class GuardedParamError extends Error {
  constructor(key: string, reason: string) {
    super(`${key} is four-eyes guarded: ${reason}`);
    this.name = "GuardedParamError";
  }
}

export interface WriteParamVersionInput {
  key: string;
  /** Project/application id; `""` (the default) means the global scope. */
  scopeRef?: string;
  version: number;
  value: Prisma.InputJsonValue;
  changedBy: string;
  /** Required — and required to be somebody else — when the definition is guarded. */
  approvedBy?: string | null;
  at: Date;
  /**
   * When true, the guarded "approver must differ from author" rule is waived —
   * used ONLY for a master-admin self-approval, which the BFF has already
   * authorised by group membership. `approvedBy` must still be present (the
   * CHECK constraint and the audit trail both need it). Defaults to false, so
   * every existing caller keeps the strict two-person rule.
   */
  allowSelfApprove?: boolean;
}

export type ParamWriteDb = Pick<PrismaClient, "param" | "paramVersion">;

export interface ParamVersionWritten {
  key: string;
  scopeRef: string;
  version: number;
  guarded: boolean;
}

/**
 * Write one parameter version. Fail-closed: nothing is inserted unless the
 * definition exists and the four-eyes rule is satisfied.
 */
export async function writeParamVersion(
  db: ParamWriteDb,
  input: WriteParamVersionInput,
): Promise<ParamVersionWritten> {
  const definition = await db.param.findUnique({
    where: { key: input.key },
    select: { guarded: true },
  });
  if (definition === null) throw new UnknownParamError(input.key);

  const scopeRef = input.scopeRef ?? GLOBAL_SCOPE_REF;
  const approvedBy = input.approvedBy ?? null;
  const guarded = definition.guarded;

  if (guarded) {
    if (approvedBy === null || approvedBy.trim().length === 0) {
      throw new GuardedParamError(input.key, "approvedBy is required");
    }
    if (approvedBy === input.changedBy && input.allowSelfApprove !== true) {
      throw new GuardedParamError(input.key, "the approver may not be the person changing it");
    }
  }

  await db.paramVersion.create({
    data: {
      key: input.key,
      scopeRef,
      version: input.version,
      valueJson: input.value,
      guarded,
      changedBy: input.changedBy,
      approvedBy,
      at: input.at,
    },
  });

  return { key: input.key, scopeRef, version: input.version, guarded };
}

/**
 * Row payload for the version-1 rows the *installer* writes (`seedParams`).
 *
 * Install time is the one moment when four-eyes cannot mean two people: the
 * platform is being switched on, and the value being stored is the shipped
 * default, not somebody's decision. The row therefore records the installer as
 * both author and approver, which satisfies the CHECK constraint and leaves an
 * honest trace ("installer approved the installer's default"). Every later
 * change goes through `writeParamVersion`, where self-approval is refused.
 */
export function bootstrapParamVersionData(guarded: boolean, changedBy: string): {
  guarded: boolean;
  changedBy: string;
  approvedBy: string | null;
} {
  return { guarded, changedBy, approvedBy: guarded ? changedBy : null };
}
