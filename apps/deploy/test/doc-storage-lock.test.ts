import {
  BinaryDocPublisher,
  BinaryDocPublishConfig,
  InMemoryPublishState,
  type Translate,
} from "@maestro/publish";
import type { PublishRequest } from "@maestro/contracts";
import type { StoragePort } from "@maestro/ports";
import { createPgBlobStorage, ObjectLockNotConfiguredError } from "@maestro/storage";
import { describe, expect, it } from "vitest";
import { bootPlatform } from "../src/boot.js";
import { objectLockConfig } from "../src/object-lock.js";
import { loadDeployEnv } from "../src/env.js";
import { DEV_ENV } from "./fixtures.js";

/**
 * The bug this file exists for.
 *
 * Two real tickets (OPS-42, OPS-49) ran the analysis line end to end — intake,
 * repo discovery, analysis, both human gates, step 13, `done` — and attached
 * ZERO files. The journal named the reason: the `docx` target asked its sink
 * for an Object-Lock put, the composed `pg-blob` driver carried no `objectLock`
 * configuration, and it refused rather than storing an unprotected record
 * (M57 fail-closed). Every layer behaved as designed; the composition root had
 * simply never supplied the retention.
 *
 * The existing `packages/publish` tests could not catch it: they hand the
 * publisher a FAKE sink that accepts any put. So the proof has to live here,
 * where the real publisher meets the real driver built from the real config.
 */

const RUN_ID = "run-20260816-0001";
const TICKET = "OPS-49";
const REQ: PublishRequest = { runId: RUN_ID, doc: "analysis", targets: ["docx"], locale: "tr" };

const MARKDOWN = [
  "<!-- maestro:doc kind=analysis version=analysis-template@1.4.0 -->",
  "# Analiz",
  "",
  "## Kapsam",
  "Ödeme servisine yeni bir uç nokta eklenecek.",
  "",
  "## Etki",
  "Mevcut sözleşmeler değişmiyor.",
].join("\n");

/** The catalogue is not under test here; echo the key back. */
const translate: Translate = (_locale, key) => key;

/** Captures what the driver writes, standing in for the `storage_blob` table. */
function recordingSql() {
  const rows: { key: string; objectLock: boolean; retainUntil: string | null; bytes: number }[] = [];
  return {
    rows,
    query: (sql: string, params: readonly unknown[] = []) => {
      if (sql.startsWith("INSERT")) {
        rows.push({
          key: String(params[0]),
          bytes: (params[1] as Buffer).byteLength,
          objectLock: params[4] === true,
          retainUntil: params[5] === null ? null : String(params[5]),
        });
      }
      return Promise.resolve([]);
    },
  };
}

function buildPublisher(sink: StoragePort) {
  return new BinaryDocPublisher("docx", BinaryDocPublishConfig.parse({}), {
    sink,
    state: new InMemoryPublishState(),
    runContext: () => Promise.resolve({ ticketKey: TICKET, runId: RUN_ID } as never),
    translate,
    now: () => new Date("2026-08-16T10:00:00.000Z"),
  });
}

describe("analysis document reaches storage (M56/M57)", () => {
  it("stores a real .docx under retention through the composed driver", async () => {
    const sql = recordingSql();
    const env = loadDeployEnv({ ...DEV_ENV });
    // Exactly what `buildStorageSink` composes for a worker.
    const sink = createPgBlobStorage(
      { table: "storage_blob", objectLock: objectLockConfig(env, env.profile) },
      { sql: sql as never },
    );

    const receipt = await buildPublisher(sink).publish(REQ, MARKDOWN);

    // A row was written, and it is a real Word file: "PK" zip magic, not an
    // empty placeholder that only looks like success.
    expect(sql.rows).toHaveLength(1);
    const row = sql.rows[0];
    expect(row?.key).toContain(TICKET);
    expect(row?.bytes ?? 0).toBeGreaterThan(1000);
    expect(receipt.ref).toContain(".docx");

    // And it is WORM: this is the assertion that was false before the fix,
    // because the put never happened at all.
    expect(row?.objectLock).toBe(true);
    const years =
      new Date(String(row?.retainUntil)).getUTCFullYear() - new Date("2026-08-16").getUTCFullYear();
    expect(years).toBe(10); // M56: kanıt paketi saklama 10 yıl.
  });

  /**
   * The sink the `docx` target actually receives.
   *
   * `registerPublishDrivers` hands `BinaryDocPublisher` the `deps.sink` that
   * `bootPlatform` built — NOT the registry's `storage` port. The two are wired
   * on separate lines and only the registry's one was noticed at first, so this
   * asserts against the publish sink specifically: it is the object that was
   * unconfigured on the live deployment, and a fix applied only to the registry
   * would leave the attachment broken while looking correct.
   */
  it("gives the docx target a sink that is itself lock-configured", async () => {
    const sql = recordingSql();
    const { deployment } = await bootPlatform({
      source: { ...DEV_ENV },
      sql: sql as never,
      quiet: true,
      // The two run-scoped collaborators a worker owns; without them the
      // publisher refuses before it ever reaches the sink, which would hide
      // the fact under test behind an unrelated error.
      publishRunDeps: {
        runContext: () => Promise.resolve({ ticketKey: TICKET, runId: RUN_ID } as never),
        state: new InMemoryPublishState(),
      },
    });

    // Publish through the REAL composed port, the way the delivery step does.
    const publish = deployment.ports.publish;
    await publish.publish(
      { runId: RUN_ID, doc: "analysis", targets: ["docx"], locale: "tr" },
      MARKDOWN,
    );

    const stored = sql.rows.filter((r) => r.key.endsWith(".docx"));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.objectLock, "the publish sink must carry retention").toBe(true);
    expect(stored[0]?.bytes ?? 0).toBeGreaterThan(1000);
  });

  it("still refuses the document when no retention is configured (M57)", async () => {
    const sql = recordingSql();
    // The pre-fix composition, kept as a test so the failure mode stays visible.
    const sink = createPgBlobStorage({ table: "storage_blob" }, { sql: sql as never });

    await expect(buildPublisher(sink).publish(REQ, MARKDOWN)).rejects.toThrow(
      ObjectLockNotConfiguredError,
    );
    // Nothing was written: no unprotected copy of a record the evidence
    // package would claim is immutable.
    expect(sql.rows).toHaveLength(0);
  });
});
