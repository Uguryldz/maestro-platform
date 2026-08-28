import { describe, expect, it } from "vitest";
import { seedDemo } from "../src/index.js";

interface CreateManyCall {
  table: string;
  count: number;
  skipDuplicates: boolean;
}

const TABLES = [
  "user",
  "application",
  "repoCard",
  "jiraProjectBinding",
  "routingRule",
  "workflowRun",
  "stepEvent",
  "journalEntry",
  "auditLog",
  "paramVersion",
  "llmCall",
  "variant",
  "variantVersion",
  "subscriptionAccount",
  "knowledgeDoc",
  "evidencePackageRow",
] as const;

/** A fake client that records the calls and the transaction boundary. */
function fakeDb(): { db: Parameters<typeof seedDemo>[0]; calls: CreateManyCall[]; transactions: number } {
  const calls: CreateManyCall[] = [];
  const state = { transactions: 0 };

  const delegate = (table: string) => ({
    createMany: (args: { data: unknown[]; skipDuplicates?: boolean }) => {
      calls.push({ table, count: args.data.length, skipDuplicates: args.skipDuplicates === true });
      return Promise.resolve({ count: args.data.length });
    },
  });

  const delegates = Object.fromEntries(TABLES.map((table) => [table, delegate(table)]));

  const db = {
    ...delegates,
    $transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      state.transactions += 1;
      return fn(delegates);
    },
  } as unknown as Parameters<typeof seedDemo>[0];

  return {
    db,
    calls,
    get transactions() {
      return state.transactions;
    },
  };
}

describe("seedDemo", () => {
  it("writes every table inside one transaction, in foreign-key order", async () => {
    const fake = fakeDb();
    const counts = await seedDemo(fake.db);

    expect(fake.transactions).toBe(1);
    expect(counts["runs"]).toBe(22);
    expect(counts["applications"]).toBe(5);

    const order = fake.calls.map((call) => call.table);
    expect(new Set(order).size).toBe(TABLES.length);
    expect(order.indexOf("application")).toBeLessThan(order.indexOf("repoCard"));
    expect(order.indexOf("application")).toBeLessThan(order.indexOf("workflowRun"));
    expect(order.indexOf("jiraProjectBinding")).toBeLessThan(order.indexOf("routingRule"));
    expect(order.indexOf("workflowRun")).toBeLessThan(order.indexOf("stepEvent"));
    expect(order.indexOf("workflowRun")).toBeLessThan(order.indexOf("journalEntry"));
    expect(order.indexOf("workflowRun")).toBeLessThan(order.indexOf("evidencePackageRow"));
    expect(order.indexOf("variant")).toBeLessThan(order.indexOf("variantVersion"));
  });

  it("never skips duplicates on the append-only tables (M30/M33)", async () => {
    const fake = fakeDb();
    await seedDemo(fake.db);

    const appendOnlyTables = new Set(["auditLog", "journalEntry"]);
    for (const call of fake.calls) {
      expect(call.skipDuplicates, call.table).toBe(!appendOnlyTables.has(call.table));
    }
  });

  it("propagates a failure instead of half-seeding", async () => {
    const fake = fakeDb();
    const failing = {
      ...(fake.db as unknown as Record<string, unknown>),
      $transaction: () => Promise.reject(new Error("duplicate key value violates unique constraint")),
    } as unknown as Parameters<typeof seedDemo>[0];

    await expect(seedDemo(failing)).rejects.toThrow(/duplicate key/);
  });
});
