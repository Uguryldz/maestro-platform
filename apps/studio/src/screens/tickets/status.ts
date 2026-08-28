import type { RunStatus } from "../shared/runs.ts";

/**
 * Catalog key prefix for a workflow status.
 *
 * Exported so every screen renders the same word for the same status, and so
 * callers go through `useEnumLabel`: `WorkflowRunStatus` is a union in
 * TypeScript but a plain string on the wire, and an eighth status would
 * otherwise throw out of `t()` and blank the whole ticket list.
 *
 * Backticks on purpose: this is a key PREFIX, not an emitted catalog key, and
 * the M104 catalog-usage scan (packages/config/test/catalog-usage.test.ts)
 * treats every double-quoted `"run.*"` literal in a .ts file as an emitted key.
 */
export const RUN_STATUS_PREFIX = `run.status`;

export function statusKey(status: RunStatus): string {
  return `${RUN_STATUS_PREFIX}.${status}`;
}
