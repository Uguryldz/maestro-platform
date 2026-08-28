import { beforeEach, describe, expect, it } from "vitest";
import { CapabilityNotSupportedError } from "@maestro/ports";
import type { StoragePort } from "@maestro/ports";
import { InvalidKeyError, ObjectLockNotConfiguredError, ObjectNotFoundError } from "../src/errors.js";
import { evidenceKey, evidenceTicketPrefix, parseEvidenceKey } from "../src/keys.js";
import { createPgBlobStorage } from "../src/pg.js";
import { createS3Storage } from "../src/s3.js";
import { FakePg } from "./fakes/fake-pg.js";
import { FakeS3 } from "./fakes/fake-s3.js";

const CLOCK = () => new Date("2026-08-08T09:00:00.000Z");
const KEY_PREFIX = "tenant-a/";

interface Deployment {
  /** Physical keys the backend holds, prefix included. */
  storedKeys(): string[];
  /**
   * Another driver instance over the SAME backend. `objectLock` mirrors the
   * deployment configuration, so a redeploy that drops it can be simulated.
   */
  driver(objectLock?: boolean): StoragePort;
}

interface Harness {
  name: string;
  presign: "supported" | "unsupported";
  deploy(): Deployment;
}

const LOCK_CONFIG = { mode: "COMPLIANCE" as const, years: 10 };

const S3_BASE = {
  endpoint: "https://s3.corp.local",
  bucket: "maestro",
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "secret",
  keyPrefix: KEY_PREFIX,
};

function s3Harness(addressing: "path" | "virtual-host"): Harness {
  return {
    name: `s3-compat (${addressing}-style)`,
    presign: "supported",
    deploy() {
      const fake = new FakeS3({ bucket: "maestro", pageSize: 2 });
      return {
        storedKeys: () => [...fake.objects.keys()].sort(),
        driver: (objectLock) =>
          createS3Storage(
            {
              ...S3_BASE,
              addressing,
              ...(objectLock === true ? { objectLock: LOCK_CONFIG } : {}),
            },
            { fetch: fake.fetch, now: CLOCK },
          ),
      };
    },
  };
}

/**
 * Driver invariance (masterplan §4): every case below runs unchanged against
 * the s3-compat driver in both addressing modes and against pg-blob. Anything
 * a caller can observe must be identical whichever driver is deployed.
 */
const HARNESSES: Harness[] = [
  s3Harness("path"),
  s3Harness("virtual-host"),
  {
    name: "pg-blob",
    presign: "unsupported",
    deploy() {
      const fake = new FakePg();
      return {
        storedKeys: () => [...fake.rows.keys()].sort(),
        driver: (objectLock) =>
          createPgBlobStorage(
            {
              keyPrefix: KEY_PREFIX,
              ...(objectLock === true ? { objectLock: LOCK_CONFIG } : {}),
            },
            { sql: fake, now: CLOCK },
          ),
      };
    },
  },
];

const BINARY = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0]);
const TEXT = new TextEncoder().encode("kanıt paketi — evidence ✅");

describe.each(HARNESSES)("StoragePort contract: $name", (harness) => {
  let port: StoragePort;
  let backend: Deployment;

  beforeEach(() => {
    backend = harness.deploy();
    port = backend.driver();
  });

  it("round-trips binary bytes unchanged", async () => {
    await port.put("evidence/blob.bin", BINARY);
    expect(await port.get("evidence/blob.bin")).toEqual(BINARY);
  });

  it("round-trips utf-8 payloads unchanged", async () => {
    await port.put("evidence/report.json", TEXT, { contentType: "application/json" });
    expect(new TextDecoder().decode(await port.get("evidence/report.json"))).toBe(
      "kanıt paketi — evidence ✅",
    );
  });

  it("overwrites an existing key", async () => {
    await port.put("a/b.txt", new Uint8Array([1]));
    await port.put("a/b.txt", new Uint8Array([2, 2]));
    expect(await port.get("a/b.txt")).toEqual(new Uint8Array([2, 2]));
  });

  it("raises ObjectNotFoundError for a missing key", async () => {
    await expect(port.get("a/missing.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("lists keys under a prefix, sorted, excluding everything else", async () => {
    for (const key of ["p/3.txt", "p/1.txt", "p/2.txt", "q/1.txt"]) {
      await port.put(key, new Uint8Array([1]));
    }
    expect(await port.list("p/")).toEqual(["p/1.txt", "p/2.txt", "p/3.txt"]);
    expect(await port.list("q/")).toEqual(["q/1.txt"]);
  });

  it("lists every key for the empty prefix", async () => {
    await port.put("p/1.txt", new Uint8Array([1]));
    await port.put("q/1.txt", new Uint8Array([1]));
    expect(await port.list("")).toEqual(["p/1.txt", "q/1.txt"]);
  });

  it("returns an empty list for a prefix with no matches", async () => {
    await port.put("p/1.txt", new Uint8Array([1]));
    expect(await port.list("nothing/")).toEqual([]);
  });

  it("keeps the configured key prefix invisible to callers", async () => {
    await port.put("p/1.txt", new Uint8Array([1]));
    expect(backend.storedKeys()).toEqual([`${KEY_PREFIX}p/1.txt`]);
    expect(await port.list("p/")).toEqual(["p/1.txt"]);
  });

  it("deletes a key", async () => {
    await port.put("a/b.txt", new Uint8Array([1]));
    await port.delete("a/b.txt");
    await expect(port.get("a/b.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
    expect(backend.storedKeys()).toEqual([]);
  });

  it("treats deleting an absent key as a no-op", async () => {
    await expect(port.delete("a/never-written.txt")).resolves.toBeUndefined();
  });

  it.each([
    ["empty", ""],
    ["absolute", "/a/b.txt"],
    ["trailing separator", "a/b/"],
    ["empty segment", "a//b.txt"],
    ["parent traversal", "a/../../etc/passwd"],
    ["current directory", "a/./b.txt"],
    ["backslash", "a\\b.txt"],
    ["control character", "a/\u0007b.txt"],
  ])("rejects an unsafe key (%s) and writes nothing", async (_label, key) => {
    await expect(port.put(key, new Uint8Array([1]))).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(port.get(key)).rejects.toBeInstanceOf(InvalidKeyError);
    expect(backend.storedKeys()).toEqual([]);
  });

  it("counts the tenant prefix against the key length limit", async () => {
    const key = "a".repeat(1025 - KEY_PREFIX.length);
    await expect(port.put(key, BINARY)).rejects.toBeInstanceOf(InvalidKeyError);
    expect(backend.storedKeys()).toEqual([]);
  });

  it("stores and lists an evidence package under the M56 key scheme", async () => {
    const key = evidenceKey({
      ticketKey: "UGURPAY-4312",
      runId: "run-01H8ZQ",
      fileName: "analysis.json",
      createdAt: "2026-08-08T09:00:00.000Z",
    });
    await port.put(key, TEXT, { contentType: "application/json" });
    expect(await port.list(evidenceTicketPrefix("UGURPAY-4312", 2026))).toEqual([key]);
  });

  /**
   * The evidence packager (M34) names files from the contract, and the analysis
   * output is Turkish (M59): `test-report (junit) — özet.xml` is an ordinary
   * name, not an attack. It must survive put → list → get on either driver.
   */
  it("stores an evidence file whose name is Turkish and parenthesised", async () => {
    const fileName = "test-report (junit) — özet %100.xml";
    const key = evidenceKey({
      ticketKey: "UGURPAY-4312",
      runId: "run-01H8ZQXYZ",
      fileName,
      createdAt: "2026-08-08T09:00:00.000Z",
    });
    await port.put(key, TEXT, { contentType: "application/xml" });
    expect(await port.get(key)).toEqual(TEXT);
    expect(await port.list(evidenceTicketPrefix("UGURPAY-4312", 2026))).toEqual([key]);
    expect(parseEvidenceKey(key)?.fileName).toBe(fileName);
  });

  describe("Object Lock (M57)", () => {
    it("refuses a locked put when the driver has no lock configuration", async () => {
      await expect(
        port.put("evidence/locked.json", TEXT, { objectLock: true }),
      ).rejects.toBeInstanceOf(ObjectLockNotConfiguredError);
      expect(backend.storedKeys()).toEqual([]);
    });

    it("accepts a locked put when the driver is lock-configured", async () => {
      const locked = backend.driver(true);
      await locked.put("evidence/locked.json", TEXT, { objectLock: true });
      expect(await locked.get("evidence/locked.json")).toEqual(TEXT);
    });

    /**
     * The protection belongs to the stored object, not to the line of config
     * that created it: a driver redeployed without `objectLock` must still be
     * unable to overwrite or delete a retained evidence package.
     */
    it("keeps a retained object protected when the lock configuration is removed", async () => {
      await backend.driver(true).put("evidence/locked.json", TEXT, { objectLock: true });
      const unconfigured = backend.driver();
      await expect(unconfigured.put("evidence/locked.json", BINARY)).rejects.toThrow();
      await expect(unconfigured.delete("evidence/locked.json")).rejects.toThrow();
      expect(await port.get("evidence/locked.json")).toEqual(TEXT);
      expect(backend.storedKeys()).toEqual([`${KEY_PREFIX}evidence/locked.json`]);
    });
  });

  describe("presign", () => {
    it(`declares presign as ${harness.presign}`, async () => {
      const result = port.presign("a/b.txt", 60);
      if (harness.presign === "supported") {
        await expect(result).resolves.toMatch(/^https?:\/\//);
      } else {
        await expect(result).rejects.toBeInstanceOf(CapabilityNotSupportedError);
      }
    });
  });
});
