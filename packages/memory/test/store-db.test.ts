import { describe, expect, it, vi } from "vitest";
import { SeqTakenError } from "../src/errors.js";
import { appendJournal } from "../src/journal.js";
import { journalStoreFromDb, type JournalDelegate } from "../src/store-db.js";
import { fixedClock, RUN_ID, testMasker } from "./fakes/support.js";

interface FakeRow {
  runId: string;
  seq: number;
  at: Date;
  actor: "ai" | "human" | "system";
  kind: "intake" | "gate" | "engineering";
  title: string;
  detail: string;
  costJson: unknown;
}

/**
 * A stand-in for the Prisma delegate. The cast is the test's own: production
 * code takes the real `AppendOnlyDb["journalEntry"]` type, which is what makes
 * `update`/`delete` unreachable in the first place.
 */
function fakeDelegate(behaviour: {
  rows?: FakeRow[];
  maxSeq?: number | null;
  createError?: unknown;
}): {
  delegate: JournalDelegate;
  create: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  aggregate: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => {
    if (behaviour.createError !== undefined) throw behaviour.createError;
    return {};
  });
  const findMany = vi.fn(async () => behaviour.rows ?? []);
  const aggregate = vi.fn(async () => ({ _max: { seq: behaviour.maxSeq ?? null } }));
  return {
    delegate: { create, findMany, aggregate } as unknown as JournalDelegate,
    create,
    findMany,
    aggregate,
  };
}

const AT = "2026-08-08T10:00:00+03:00";

describe("journalStoreFromDb", () => {
  it("reads the head of the journal with one aggregate", async () => {
    const fake = fakeDelegate({ maxSeq: 7 });
    const store = journalStoreFromDb(fake.delegate);
    expect(await store.maxSeq(RUN_ID)).toBe(7);
    expect(fake.aggregate).toHaveBeenCalledWith({
      where: { runId: RUN_ID },
      _max: { seq: true },
    });
  });

  it("reports an empty run as null, not as zero", async () => {
    const store = journalStoreFromDb(fakeDelegate({ maxSeq: null }).delegate);
    expect(await store.maxSeq(RUN_ID)).toBeNull();
  });

  it("writes the columns the schema declares", async () => {
    const fake = fakeDelegate({});
    const masker = testMasker();
    const entry = masker.seal(
      { runId: RUN_ID, seq: 4, at: AT, actor: "ai", kind: "engineering", cost: { usd: null } },
      masker.prepare({ title: "patch applied", detail: "3 files" }),
    );
    await journalStoreFromDb(fake.delegate).insert(entry);

    expect(fake.create).toHaveBeenCalledTimes(1);
    const data = (fake.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.runId).toBe(RUN_ID);
    expect(data.seq).toBe(4);
    expect(data.at).toBeInstanceOf(Date);
    expect((data.at as Date).toISOString()).toBe(new Date(AT).toISOString());
    expect(data.title).toBe("patch applied");
    expect(data.costJson).toEqual({ usd: null });
  });

  it("omits costJson when the entry has no cost", async () => {
    const fake = fakeDelegate({});
    const masker = testMasker();
    const entry = masker.seal(
      { runId: RUN_ID, seq: 0, at: AT, actor: "ai", kind: "intake" },
      masker.prepare({ title: "read", detail: "" }),
    );
    await journalStoreFromDb(fake.delegate).insert(entry);
    const data = (fake.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect("costJson" in data).toBe(false);
  });

  it("turns a unique violation into a retryable SeqTakenError", async () => {
    const masker = testMasker();
    const entry = masker.seal(
      { runId: RUN_ID, seq: 1, at: AT, actor: "ai", kind: "intake" },
      masker.prepare({ title: "read", detail: "" }),
    );
    for (const code of ["P2002", "23505"]) {
      const store = journalStoreFromDb(fakeDelegate({ createError: { code } }).delegate);
      await expect(store.insert(entry)).rejects.toBeInstanceOf(SeqTakenError);
    }
  });

  it("lets every other database failure through untouched", async () => {
    const masker = testMasker();
    const entry = masker.seal(
      { runId: RUN_ID, seq: 1, at: AT, actor: "ai", kind: "intake" },
      masker.prepare({ title: "read", detail: "" }),
    );
    const store = journalStoreFromDb(
      fakeDelegate({ createError: new Error("connection terminated") }).delegate,
    );
    await expect(store.insert(entry)).rejects.toThrow("connection terminated");
  });

  it("maps rows back to the contract shape in seq order", async () => {
    const fake = fakeDelegate({
      rows: [
        {
          runId: RUN_ID,
          seq: 2,
          at: new Date(AT),
          actor: "ai",
          kind: "engineering",
          title: "patch",
          detail: "",
          costJson: { usd: 0.12, model: "haiku" },
        },
      ],
    });
    const entries = await journalStoreFromDb(fake.delegate).list(RUN_ID, 2);
    expect(fake.findMany).toHaveBeenCalledWith({
      where: { runId: RUN_ID, seq: { gte: 2 } },
      orderBy: { seq: "asc" },
    });
    expect(entries[0]?.at).toBe(new Date(AT).toISOString());
    expect(entries[0]?.cost).toEqual({ usd: 0.12, model: "haiku" });
  });

  it("lists a whole run when no lower bound is given", async () => {
    const fake = fakeDelegate({ rows: [] });
    await journalStoreFromDb(fake.delegate).list(RUN_ID);
    expect(fake.findMany).toHaveBeenCalledWith({
      where: { runId: RUN_ID },
      orderBy: { seq: "asc" },
    });
  });

  it("cannot reach a mutating method even when handed a wider client (D-13)", async () => {
    // `AppendOnlyDelegate` is a structural type, so a full Prisma delegate is
    // assignable to it — the type stops the *store* from naming `update`, not
    // a caller from passing one. The store therefore takes a snapshot of the
    // three methods it may use and never touches the object again.
    const update = vi.fn();
    const deleteMany = vi.fn();
    const fake = fakeDelegate({});
    const wide = { ...(fake.delegate as object), update, deleteMany } as unknown as JournalDelegate;
    const store = journalStoreFromDb(wide);

    expect(Object.keys(store).sort()).toEqual(["insert", "list", "maxSeq"]);
    expect((store as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((store as unknown as Record<string, unknown>).delete).toBeUndefined();

    // Swapping a method in afterwards changes nothing for this store.
    (wide as unknown as Record<string, unknown>).create = deleteMany;
    const masker = testMasker();
    await store.insert(
      masker.seal(
        { runId: RUN_ID, seq: 0, at: AT, actor: "ai", kind: "intake" },
        masker.prepare({ title: "read", detail: "" }),
      ),
    );
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("drives appendJournal end to end over the delegate", async () => {
    const rows: FakeRow[] = [];
    let maxSeq: number | null = null;
    const delegate = {
      aggregate: async () => ({ _max: { seq: maxSeq } }),
      create: async ({ data }: { data: FakeRow }) => {
        if (rows.some((row) => row.seq === data.seq)) throw { code: "P2002" };
        rows.push(data);
        maxSeq = data.seq;
        return {};
      },
      findMany: async () => rows,
    } as unknown as JournalDelegate;

    const deps = {
      store: journalStoreFromDb(delegate),
      masker: testMasker(),
      clock: fixedClock(AT),
    };
    await appendJournal(deps, { runId: RUN_ID, actor: "ai", kind: "intake", title: "one" });
    await appendJournal(deps, { runId: RUN_ID, actor: "ai", kind: "gate", title: "two" });
    expect(rows.map((row) => row.seq)).toEqual([0, 1]);
  });
});
