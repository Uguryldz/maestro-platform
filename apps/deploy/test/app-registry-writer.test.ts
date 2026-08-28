import type { AppRegistration } from "@maestro/bff";
import { describe, expect, it } from "vitest";
import {
  PrismaAppRegistryWriter,
  type ApplicationUpsertDelegate,
  type ApplicationWriteRow,
} from "../src/stores/app-registry-writer.js";

/**
 * The Postgres-backed app-registry writer (M100), offline.
 *
 * The delegate is a Map keyed by `appId` — the `Application` table with its
 * `appId` primary key. The properties under test: registering creates a row
 * stamped `createdVia: "onboarding"` with the two owner/repo halves the wizard
 * split, and re-registering the same appId UPDATES the mutable columns without
 * re-stamping `createdVia` or the policy flag another subsystem owns.
 */

type StoredRow = ApplicationWriteRow & { maestroYamlPresent: boolean };

function fakeDelegate(): {
  delegate: ApplicationUpsertDelegate;
  rows: Map<string, StoredRow>;
} {
  const rows = new Map<string, StoredRow>();
  const delegate: ApplicationUpsertDelegate = {
    upsert: (args) => {
      const existing = rows.get(args.where.appId);
      rows.set(
        args.where.appId,
        existing === undefined ? args.create : { ...existing, ...args.update },
      );
      return Promise.resolve(rows.get(args.where.appId));
    },
  };
  return { delegate, rows };
}

function registration(over: Partial<AppRegistration> = {}): AppRegistration {
  return {
    appId: "Uguryldz/maestro-pilot",
    displayName: "Uguryldz/maestro-pilot",
    adoProject: "Uguryldz",
    adoRepo: "maestro-pilot",
    platform: "linux-node",
    ...over,
  };
}

describe("PrismaAppRegistryWriter", () => {
  it("registers a new application as an onboarding row", async () => {
    const { delegate, rows } = fakeDelegate();
    const writer = new PrismaAppRegistryWriter(delegate);

    await writer.register(registration());

    const row = rows.get("Uguryldz/maestro-pilot");
    expect(row).toEqual({
      appId: "Uguryldz/maestro-pilot",
      displayName: "Uguryldz/maestro-pilot",
      adoProject: "Uguryldz",
      adoRepo: "maestro-pilot",
      platform: "linux-node",
      maestroYamlPresent: false,
      createdVia: "onboarding",
    });
  });

  it("upserts on re-register: corrects mutable columns, keeps createdVia and the policy flag", async () => {
    const { delegate, rows } = fakeDelegate();
    const writer = new PrismaAppRegistryWriter(delegate);

    await writer.register(registration());
    // A later observation flipped the policy flag; the wizard must not undo it.
    rows.set("Uguryldz/maestro-pilot", {
      ...rows.get("Uguryldz/maestro-pilot")!,
      maestroYamlPresent: true,
    });

    await writer.register(registration({ displayName: "Renamed", platform: "linux-java" }));

    const row = rows.get("Uguryldz/maestro-pilot");
    expect(row?.displayName).toBe("Renamed");
    expect(row?.platform).toBe("linux-java");
    // Neither the provenance nor another subsystem's flag was overwritten.
    expect(row?.createdVia).toBe("onboarding");
    expect(row?.maestroYamlPresent).toBe(true);
  });
});
