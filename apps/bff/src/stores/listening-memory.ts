import type { ListeningRuleRecord, ListeningStore } from "../listening-store.js";

/**
 * An in-memory `ListeningStore` for tests and a store-less deployment.
 *
 * Holds rules in a Map keyed by `ruleId`, ordered on read by (projectKey,
 * priority) so a screen renders a stable list. It reproduces the ONE database
 * invariant the routes depend on: the unique (projectKey, assigneeAccountId,
 * matchKind, matchValue) trigger. A `put` that would create a SECOND rule for an
 * existing trigger throws a `{ code: "P2002" }`-shaped error, exactly as Prisma
 * would, so the route's 409 mapping is exercised without a real Postgres.
 */
export class InMemoryListeningStore implements ListeningStore {
  private readonly rows = new Map<string, ListeningRuleRecord>();

  constructor(initial: readonly ListeningRuleRecord[] = []) {
    for (const row of initial) this.rows.set(row.ruleId, { ...row });
  }

  list(): Promise<readonly ListeningRuleRecord[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .sort((a, b) => a.projectKey.localeCompare(b.projectKey) || a.priority - b.priority)
        .map((row) => ({ ...row })),
    );
  }

  get(ruleId: string): Promise<ListeningRuleRecord | null> {
    const row = this.rows.get(ruleId);
    return Promise.resolve(row === undefined ? null : { ...row });
  }

  put(record: ListeningRuleRecord): Promise<void> {
    // Enforce the unique trigger across OTHER rows, mirroring the DB index.
    const clash = [...this.rows.values()].some(
      (r) =>
        r.ruleId !== record.ruleId &&
        r.projectKey === record.projectKey &&
        r.assigneeAccountId === record.assigneeAccountId &&
        r.matchKind === record.matchKind &&
        r.matchValue === record.matchValue,
    );
    if (clash) {
      return Promise.reject(Object.assign(new Error("unique constraint"), { code: "P2002" }));
    }
    this.rows.set(record.ruleId, { ...record });
    return Promise.resolve();
  }

  remove(ruleId: string): Promise<boolean> {
    return Promise.resolve(this.rows.delete(ruleId));
  }
}
