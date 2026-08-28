import { describe, expect, it } from "vitest";
import {
  assertCatalog,
  BFF_MESSAGE_KEYS,
  COMMAND_DIAGNOSIS_KEYS,
  defaultCatalog,
  MissingCatalogKeysError,
  missingKeys,
  REQUESTED_MESSAGE_KEYS,
  REQUIRED_MESSAGE_KEYS,
  stepTitleKey,
} from "../src/messages.js";
import { harness, PENDING_CATALOG_TEXT, testCatalog } from "./helpers.js";

describe("message catalog (M104)", () => {
  it("resolves every key except the ones still awaiting a catalog edit", () => {
    const outstanding = missingKeys(defaultCatalog, "tr");
    expect(outstanding.sort()).toEqual([...REQUESTED_MESSAGE_KEYS].sort());
  });

  it("resolves the same set in English", () => {
    expect(missingKeys(defaultCatalog, "en").sort()).toEqual([...REQUESTED_MESSAGE_KEYS].sort());
  });

  // The original five have shipped. Every key still outstanding must have its
  // wording staged in the test catalog and written up in RAPOR, so a request
  // cannot be forgotten by being invisible.
  it("stages wording for every outstanding catalog request", () => {
    for (const key of REQUESTED_MESSAGE_KEYS) {
      expect(Object.keys(PENDING_CATALOG_TEXT)).toContain(key);
      expect(missingKeys(testCatalog, "tr", [key])).toEqual([]);
    }
  });

  /**
   * The exemption is narrow ON PURPOSE: only keys named in
   * `REQUESTED_MESSAGE_KEYS` may be missing at boot. Anything else must still
   * stop the service (M6), which is what keeps the escape hatch from becoming a
   * way to ship unrenderable text.
   */
  it("exempts only the requested keys from the boot gate", () => {
    expect(() => assertCatalog(defaultCatalog, "tr")).not.toThrow();

    const alsoMissingOne: typeof defaultCatalog = {
      t: (locale, key, params) => {
        if (key === BFF_MESSAGE_KEYS.commandNoRun) throw new Error(`missing ${key}`);
        return defaultCatalog.t(locale, key, params);
      },
    };
    expect(() => assertCatalog(alsoMissingOne, "tr")).toThrow(MissingCatalogKeysError);
  });

  it("covers the driver's command diagnosis keys", () => {
    expect(missingKeys(defaultCatalog, "tr", COMMAND_DIAGNOSIS_KEYS)).toEqual([]);
  });

  it("covers every step title the gate replies quote", () => {
    expect(missingKeys(defaultCatalog, "tr", [stepTitleKey("5"), stepTitleKey("12")])).toEqual([]);
  });

  it("lists all required keys, including the message set and the step titles", () => {
    for (const key of Object.values(BFF_MESSAGE_KEYS)) {
      expect(REQUIRED_MESSAGE_KEYS).toContain(key);
    }
    expect(REQUIRED_MESSAGE_KEYS).toContain(stepTitleKey("4"));
  });

  // Deliberately broken catalog, not the shipped one: the guarantee under test
  // is "a missing key stops the boot", which must hold no matter how complete
  // the real catalog happens to be.
  it("refuses to start when a key cannot be rendered (M6 fail-closed)", () => {
    const broken: typeof defaultCatalog = {
      t: (locale, key, params) => {
        if (key === BFF_MESSAGE_KEYS.commandAccepted) throw new Error(`missing ${key}`);
        return defaultCatalog.t(locale, key, params);
      },
    };
    expect(() => assertCatalog(broken, "tr")).toThrow(MissingCatalogKeysError);
  });

  it("starts once every key resolves", () => {
    expect(() => assertCatalog(testCatalog, "tr")).not.toThrow();
  });

  it("refuses to build a server whose catalog is incomplete", async () => {
    const broken: typeof defaultCatalog = {
      t: (locale, key, params) => {
        if (key === BFF_MESSAGE_KEYS.commandNoRun) throw new Error(`missing ${key}`);
        return defaultCatalog.t(locale, key, params);
      },
    };
    await expect(harness({ deps: { messages: broken } })).rejects.toThrow(MissingCatalogKeysError);
  });

  it("boots on the shipped catalog now that every key is present", () => {
    expect(() => assertCatalog(defaultCatalog, "tr")).not.toThrow();
    expect(() => assertCatalog(defaultCatalog, "en")).not.toThrow();
  });
});
