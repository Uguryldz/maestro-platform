import { describe, expect, it } from "vitest";
import { CapabilityNotSupportedError } from "@maestro/ports";
import type { SqlExecutor } from "../src/deps.js";
import { ObjectLockedError, StorageConfigError } from "../src/errors.js";
import { createPgBlobStorage, pgBlobTableDdl, PgBlobStorage, PgBlobStorageOptions } from "../src/pg.js";
import { FakePg } from "./fakes/fake-pg.js";

const CLOCK = () => new Date("2026-08-08T09:00:00.000Z");
const LOCK = { mode: "COMPLIANCE" as const, years: 10 };

function build(overrides: Record<string, unknown> = {}) {
  const fake = new FakePg();
  const port = new PgBlobStorage(PgBlobStorageOptions.parse(overrides), { sql: fake, now: CLOCK });
  return { fake, port };
}

describe("presign is not supported", () => {
  it("rejects with CapabilityNotSupportedError naming the port and capability", async () => {
    const { port } = build();
    await expect(port.presign("a.json", 60)).rejects.toBeInstanceOf(CapabilityNotSupportedError);
    await expect(port.presign("a.json", 60)).rejects.toThrow(/StoragePort.*presign/);
  });
});

describe("SQL surface", () => {
  it("upserts on the key so a repeated put overwrites rather than duplicates", async () => {
    const { fake, port } = build();
    await port.put("a.json", new Uint8Array([1]), { contentType: "application/json" });
    await port.put("a.json", new Uint8Array([2]));
    expect(fake.rows.size).toBe(1);
    expect(fake.statements.find((s) => s.startsWith("INSERT"))).toContain(
      "ON CONFLICT (key) DO UPDATE",
    );
  });

  it("uses bound parameters only — no value is interpolated into the SQL text", async () => {
    const { fake, port } = build();
    await port.put("a.json", new Uint8Array([1]));
    await port.get("a.json");
    await port.list("a");
    await port.delete("a.json");
    for (const statement of fake.statements) {
      expect(statement).not.toContain("a.json");
      expect(statement).toMatch(/\$\d/);
    }
  });

  it("keeps created_at while refreshing updated_at on overwrite", async () => {
    const fake = new FakePg();
    let instant = new Date("2026-08-08T09:00:00.000Z");
    const port = new PgBlobStorage(PgBlobStorageOptions.parse({}), { sql: fake, now: () => instant });
    await port.put("a.json", new Uint8Array([1]));
    instant = new Date("2026-08-09T09:00:00.000Z");
    await port.put("a.json", new Uint8Array([2]));
    const row = fake.rows.get("a.json");
    expect(row?.created_at).toBe("2026-08-08T09:00:00.000Z");
    expect(row?.updated_at).toBe("2026-08-09T09:00:00.000Z");
  });

  it("stores the retention tags alongside the blob (M56)", async () => {
    const { fake, port } = build({ retentionClass: "archive" });
    await port.put("a.json", new Uint8Array([1]));
    expect(JSON.parse(fake.rows.get("a.json")?.tags ?? "{}")).toEqual({
      "maestro-class": "archive",
      "maestro-retention-years": "10",
      "maestro-archive-after-days": "90",
    });
  });

  it("escapes LIKE wildcards so a literal % or _ prefix stays literal", async () => {
    const { fake, port } = build();
    await port.put("a%b/1.txt", new Uint8Array([1]));
    await port.put("axb/1.txt", new Uint8Array([1]));
    expect(await port.list("a%b/")).toEqual(["a%b/1.txt"]);
    const listStatement = fake.statements.find((s) => s.includes("LIKE"));
    expect(listStatement).toContain("ORDER BY key ASC");
  });

  it("binds bytea as a node Buffer, which is the only form node-postgres stores intact", async () => {
    const { fake, port } = build();
    await port.put("a.bin", new Uint8Array([72, 105]));
    expect(Buffer.isBuffer(fake.rows.get("a.bin")?.data)).toBe(true);
    expect(await port.get("a.bin")).toEqual(new Uint8Array([72, 105]));
  });

  it("surfaces database failures instead of returning an empty result", async () => {
    const failing: SqlExecutor = { query: () => Promise.reject(new Error("connection reset")) };
    const port = new PgBlobStorage(PgBlobStorageOptions.parse({}), { sql: failing, now: CLOCK });
    await expect(port.get("a.json")).rejects.toThrow(/connection reset/);
  });
});

describe("Object Lock emulation (M57)", () => {
  it("records the retention deadline on a locked put", async () => {
    const { fake, port } = build({ objectLock: LOCK });
    await port.put("evidence/a.json", new Uint8Array([1]), { objectLock: true });
    const row = fake.rows.get("evidence/a.json");
    expect(row?.object_lock).toBe(true);
    expect(row?.retain_until).toBe("2036-08-08T09:00:00.000Z");
  });

  it("refuses to overwrite an object still under retention", async () => {
    const { port } = build({ objectLock: LOCK });
    await port.put("evidence/a.json", new Uint8Array([1]), { objectLock: true });
    await expect(port.put("evidence/a.json", new Uint8Array([2]))).rejects.toBeInstanceOf(
      ObjectLockedError,
    );
  });

  it("refuses to delete an object still under retention", async () => {
    const { fake, port } = build({ objectLock: LOCK });
    await port.put("evidence/a.json", new Uint8Array([1]), { objectLock: true });
    await expect(port.delete("evidence/a.json")).rejects.toBeInstanceOf(ObjectLockedError);
    expect(fake.rows.has("evidence/a.json")).toBe(true);
  });

  it("allows a write once the retention has expired", async () => {
    const fake = new FakePg();
    let instant = new Date("2026-08-08T09:00:00.000Z");
    const port = new PgBlobStorage(PgBlobStorageOptions.parse({ objectLock: { mode: "COMPLIANCE", years: 1 } }), {
      sql: fake,
      now: () => instant,
    });
    await port.put("evidence/a.json", new Uint8Array([1]), { objectLock: true });
    instant = new Date("2027-08-09T09:00:00.000Z");
    await port.put("evidence/a.json", new Uint8Array([2]));
    expect(fake.rows.get("evidence/a.json")?.data).toEqual(Buffer.from([2]));
  });

  it("keeps enforcing a retention after the lock configuration is removed", async () => {
    const fake = new FakePg();
    const locked = new PgBlobStorage(PgBlobStorageOptions.parse({ objectLock: LOCK }), {
      sql: fake,
      now: CLOCK,
    });
    await locked.put("evidence/a.json", new Uint8Array([1]), { objectLock: true });
    // Same table, driver redeployed without any objectLock configuration.
    const unconfigured = new PgBlobStorage(PgBlobStorageOptions.parse({}), {
      sql: fake,
      now: CLOCK,
    });
    await expect(unconfigured.delete("evidence/a.json")).rejects.toBeInstanceOf(ObjectLockedError);
    await expect(unconfigured.put("evidence/a.json", new Uint8Array([2]))).rejects.toBeInstanceOf(
      ObjectLockedError,
    );
    const row = fake.rows.get("evidence/a.json");
    expect(row?.object_lock).toBe(true);
    expect(row?.data).toEqual(Buffer.from([1]));
  });

  it("never clears the WORM columns on a later unlocked write", async () => {
    const fake = new FakePg();
    let instant = new Date("2026-08-08T09:00:00.000Z");
    const port = new PgBlobStorage(
      PgBlobStorageOptions.parse({ objectLock: { mode: "COMPLIANCE", years: 1 } }),
      { sql: fake, now: () => instant },
    );
    await port.put("evidence/a.json", new Uint8Array([1]), { objectLock: true });
    instant = new Date("2027-08-09T09:00:00.000Z");
    await port.put("evidence/a.json", new Uint8Array([2]));
    const row = fake.rows.get("evidence/a.json");
    expect(row?.object_lock).toBe(true);
    expect(row?.retain_until).toBe("2027-08-08T09:00:00.000Z");
  });

  it("leaves unlocked objects freely writable", async () => {
    const { port } = build({ objectLock: LOCK });
    await port.put("draft.json", new Uint8Array([1]));
    await expect(port.put("draft.json", new Uint8Array([2]))).resolves.toBeUndefined();
  });
});

describe("configuration validation", () => {
  it("rejects a table name that is not a plain identifier", () => {
    expect(() =>
      createPgBlobStorage({ table: 'blob"; DROP TABLE users; --' }, { sql: new FakePg() }),
    ).toThrow(StorageConfigError);
  });

  it("accepts a schema-qualified table", () => {
    const fake = new FakePg("maestro.storage_blob");
    const port = createPgBlobStorage({ table: "maestro.storage_blob" }, { sql: fake, now: CLOCK });
    return expect(port.put("a.json", new Uint8Array([1]))).resolves.toBeUndefined();
  });

  /**
   * Regression, offline mirror of `apps/deploy/test/live-storage-blob.test.ts`.
   *
   * `tags` and the three instants are bound as STRINGS. An adapter that binds
   * parameters as text — Prisma's `$queryRawUnsafe`, the executor the worker
   * composes — makes Postgres reject the insert with 42804 ("is of type jsonb
   * but expression is of type text") unless the statement says what it means.
   * The in-memory fake cannot catch this: it stores whatever it is handed, so
   * this asserts on the SQL TEXT the driver emits.
   */
  it("declares the jsonb and timestamptz parameter types, so a text-binding adapter works", async () => {
    const { fake, port } = build({ objectLock: LOCK });
    await port.put("a.json", new Uint8Array([1]), { objectLock: true });
    const insert = fake.statements.find((s) => s.startsWith("INSERT INTO"));
    expect(insert).toBeDefined();
    expect(insert).toContain("$4::jsonb");
    expect(insert).toContain("$6::timestamptz");
    expect(insert).toContain("$7::timestamptz");
  });

  it("emits DDL matching the columns the driver reads and writes", () => {
    const ddl = pgBlobTableDdl();
    for (const column of [
      "key text PRIMARY KEY",
      "data bytea",
      "content_type text",
      "tags jsonb",
      "object_lock boolean",
      "retain_until timestamptz",
      "created_at timestamptz",
      "updated_at timestamptz",
    ]) {
      expect(ddl).toContain(column);
    }
  });

  it("indexes the key for the prefix scan `list` performs", () => {
    // A plain btree PK cannot serve LIKE 'prefix%' outside the C collation.
    expect(pgBlobTableDdl()).toContain("text_pattern_ops");
  });

  it("rejects a misspelled option instead of silently ignoring it", () => {
    expect(() => createPgBlobStorage({ keyPrefixx: "tenant-a/" }, { sql: new FakePg() })).toThrow(
      StorageConfigError,
    );
  });

  it("refuses to emit DDL for an unvalidated table name", () => {
    expect(() => pgBlobTableDdl("blob; DROP TABLE users")).toThrow();
  });
});
