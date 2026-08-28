import { describe, expect, it } from "vitest";
import { PortRegistry } from "@maestro/ports";
import type { StoragePort } from "@maestro/ports";
import { StorageConfigError } from "../src/errors.js";
import {
  PG_BLOB_DRIVER,
  registerStorageDrivers,
  S3_DRIVER,
  STORAGE_PORT,
} from "../src/registry.js";
import { FakePg } from "./fakes/fake-pg.js";
import { FakeS3 } from "./fakes/fake-s3.js";

const S3_CONFIG = {
  endpoint: "https://s3.corp.local",
  bucket: "maestro",
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "secret",
};

function registry(): PortRegistry {
  const reg = new PortRegistry();
  registerStorageDrivers(reg);
  return reg;
}

describe("registerStorageDrivers (M44)", () => {
  it("registers both drivers under StoragePort", () => {
    expect(registry().drivers(STORAGE_PORT).sort()).toEqual([PG_BLOB_DRIVER, S3_DRIVER]);
  });

  it("resolves a working s3-compat driver from configuration", async () => {
    const fake = new FakeS3({ bucket: "maestro" });
    const port = registry().resolve<StoragePort>(STORAGE_PORT, S3_DRIVER)({
      ...S3_CONFIG,
      fetch: fake.fetch,
      now: () => new Date("2026-08-08T09:00:00.000Z"),
    });
    await port.put("a.json", new Uint8Array([7]));
    expect(await port.get("a.json")).toEqual(new Uint8Array([7]));
  });

  it("resolves a working pg-blob driver from configuration", async () => {
    const fake = new FakePg();
    const port = registry().resolve<StoragePort>(STORAGE_PORT, PG_BLOB_DRIVER)({ sql: fake });
    await port.put("a.json", new Uint8Array([7]));
    expect(await port.get("a.json")).toEqual(new Uint8Array([7]));
  });

  it("refuses an s3 configuration without an injected fetch", () => {
    const factory = registry().resolve<StoragePort>(STORAGE_PORT, S3_DRIVER);
    expect(() => factory(S3_CONFIG)).toThrow(StorageConfigError);
  });

  it("refuses a pg-blob configuration without an injected SqlExecutor", () => {
    const factory = registry().resolve<StoragePort>(STORAGE_PORT, PG_BLOB_DRIVER);
    expect(() => factory({})).toThrow(/SqlExecutor/);
    expect(() => factory({ sql: "not-an-executor" })).toThrow(/SqlExecutor/);
  });

  it("refuses a non-object configuration", () => {
    const factory = registry().resolve<StoragePort>(STORAGE_PORT, S3_DRIVER);
    expect(() => factory(null)).toThrow(StorageConfigError);
    expect(() => factory("s3://bucket")).toThrow(StorageConfigError);
  });

  it("does not let the injected collaborators leak into option validation", () => {
    const fake = new FakeS3({ bucket: "maestro" });
    const factory = registry().resolve<StoragePort>(STORAGE_PORT, S3_DRIVER);
    expect(() => factory({ ...S3_CONFIG, fetch: fake.fetch })).not.toThrow();
  });

  it("fails loudly when an unknown driver is requested", () => {
    expect(() => registry().resolve(STORAGE_PORT, "azure-blob")).toThrow(/no driver "azure-blob"/);
  });
});
