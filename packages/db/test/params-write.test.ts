import { describe, expect, it } from "vitest";
import {
  bootstrapParamVersionData,
  DEFAULT_PARAM_DEFINITIONS,
  DEMO_PARAM_VERSIONS,
  findParamDefinition,
  GuardedParamError,
  UnknownParamError,
  writeParamVersion,
  type ParamWriteDb,
} from "../src/index.js";

/** In-memory stand-in for the two delegates `writeParamVersion` touches. */
function fakeDb(guarded: Record<string, boolean>): {
  db: ParamWriteDb;
  created: Record<string, unknown>[];
} {
  const created: Record<string, unknown>[] = [];
  const db = {
    param: {
      findUnique: ({ where }: { where: { key: string } }) =>
        Promise.resolve(
          Object.hasOwn(guarded, where.key) ? { guarded: guarded[where.key] } : null,
        ),
    },
    paramVersion: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve(data);
      },
    },
  } as unknown as ParamWriteDb;
  return { db, created };
}

const at = new Date("2026-08-07T06:30:00.000Z");

describe("writeParamVersion (M71 four-eyes)", () => {
  it("refuses a guarded parameter with no approver", async () => {
    const { db, created } = fakeDb({ "merge.mode": true });
    await expect(
      writeParamVersion(db, {
        key: "merge.mode",
        version: 2,
        value: "auto_merge",
        changedBy: "ugur.yildiz@ugurbank.local",
        at,
      }),
    ).rejects.toThrow(GuardedParamError);
    expect(created).toEqual([]);
  });

  it("refuses an empty approver just as firmly as a missing one", async () => {
    const { db } = fakeDb({ "merge.mode": true });
    await expect(
      writeParamVersion(db, {
        key: "merge.mode",
        version: 2,
        value: "auto_merge",
        changedBy: "ugur.yildiz@ugurbank.local",
        approvedBy: "   ",
        at,
      }),
    ).rejects.toThrow(GuardedParamError);
  });

  it("refuses self-approval — four eyes means two people", async () => {
    const { db } = fakeDb({ "merge.mode": true });
    await expect(
      writeParamVersion(db, {
        key: "merge.mode",
        version: 2,
        value: "auto_merge",
        changedBy: "ugur.yildiz@ugurbank.local",
        approvedBy: "ugur.yildiz@ugurbank.local",
        at,
      }),
    ).rejects.toThrow(/approver may not be/);
  });

  it("allows self-approval when allowSelfApprove is set (master-admin exemption)", async () => {
    // The BFF authorises this by group membership; the store then waives the
    // "approver ≠ author" rule so a single master admin can approve their own
    // guarded change. approvedBy is still required (the CHECK/audit need it).
    const { db, created } = fakeDb({ "merge.mode": true });
    const result = await writeParamVersion(db, {
      key: "merge.mode",
      version: 2,
      value: "auto_merge",
      changedBy: "ugur.yildiz@ugurbank.local",
      approvedBy: "ugur.yildiz@ugurbank.local",
      at,
      allowSelfApprove: true,
    });
    expect(result).toMatchObject({ key: "merge.mode", version: 2, guarded: true });
    expect(created[0]).toMatchObject({
      guarded: true,
      changedBy: "ugur.yildiz@ugurbank.local",
      approvedBy: "ugur.yildiz@ugurbank.local",
    });
  });

  it("still requires approvedBy even with allowSelfApprove (CHECK needs it)", async () => {
    const { db } = fakeDb({ "merge.mode": true });
    await expect(
      writeParamVersion(db, {
        key: "merge.mode",
        version: 2,
        value: "auto_merge",
        changedBy: "ugur.yildiz@ugurbank.local",
        approvedBy: null,
        at,
        allowSelfApprove: true,
      }),
    ).rejects.toThrow(GuardedParamError);
  });

  it("writes a guarded version with a second approver, copying `guarded`", async () => {
    const { db, created } = fakeDb({ "merge.mode": true });
    const result = await writeParamVersion(db, {
      key: "merge.mode",
      version: 2,
      value: "auto_merge",
      changedBy: "ugur.yildiz@ugurbank.local",
      approvedBy: "mert.demir@ugurbank.local",
      at,
    });
    expect(result).toEqual({ key: "merge.mode", scopeRef: "", version: 2, guarded: true });
    expect(created[0]).toMatchObject({ guarded: true, approvedBy: "mert.demir@ugurbank.local" });
  });

  it("takes `guarded` from the definition, never from the caller", async () => {
    const { db, created } = fakeDb({ "lang.output": false });
    await writeParamVersion(db, {
      key: "lang.output",
      scopeRef: "UGURPAY",
      version: 2,
      value: "en",
      changedBy: "ugur.yildiz@ugurbank.local",
      at,
    });
    expect(created[0]).toMatchObject({ guarded: false, approvedBy: null, scopeRef: "UGURPAY" });
  });

  it("refuses a version of a parameter nobody defined (M14 fail-closed)", async () => {
    const { db, created } = fakeDb({});
    await expect(
      writeParamVersion(db, {
        key: "gates.made_up",
        version: 1,
        value: 1,
        changedBy: "ugur.yildiz@ugurbank.local",
        at,
      }),
    ).rejects.toThrow(UnknownParamError);
    expect(created).toEqual([]);
  });
});

describe("installer bootstrap rows", () => {
  it("approves a guarded default with the installer, and leaves the rest NULL", () => {
    expect(bootstrapParamVersionData(true, "installer")).toEqual({
      guarded: true,
      changedBy: "installer",
      approvedBy: "installer",
    });
    expect(bootstrapParamVersionData(false, "installer")).toEqual({
      guarded: false,
      changedBy: "installer",
      approvedBy: null,
    });
  });

  it("satisfies the database CHECK for every shipped definition", () => {
    for (const definition of DEFAULT_PARAM_DEFINITIONS) {
      const row = bootstrapParamVersionData(definition.guarded, "installer");
      expect(!row.guarded || row.approvedBy !== null, definition.key).toBe(true);
    }
  });
});

/** B-11: the audit trail said "gates.risk_tiers → v4"; the table had only v1. */
describe("demo parameter history (M71 versioning)", () => {
  it("gives the versions the mock's parameter screen shows", () => {
    const latest = (key: string, scopeRef = ""): number =>
      Math.max(
        1,
        ...DEMO_PARAM_VERSIONS.filter((v) => v.key === key && v.scopeRef === scopeRef).map(
          (v) => v.version,
        ),
      );
    expect(latest("gates.risk_tiers")).toBe(4);
    expect(latest("escalation.ladder")).toBe(3);
    expect(latest("coverage.ratchet")).toBe(2);
    expect(latest("trigger.mode", "UGURPAY")).toBe(2);
  });

  it("numbers versions contiguously above the installer's v1", () => {
    const byScope = new Map<string, number[]>();
    for (const version of DEMO_PARAM_VERSIONS) {
      const key = `${version.key}@${String(version.scopeRef)}`;
      byScope.set(key, [...(byScope.get(key) ?? []), version.version]);
    }
    for (const [key, versions] of byScope) {
      const sorted = [...versions].sort((a, b) => a - b);
      const first = sorted[0] ?? 0;
      expect(sorted, key).toEqual(sorted.map((_, index) => first + index));
    }
  });

  it("carries an approver on every guarded row, and none on the rest", () => {
    for (const version of DEMO_PARAM_VERSIONS) {
      const definition = findParamDefinition(version.key);
      expect(definition, version.key).toBeDefined();
      expect(version.guarded, version.key).toBe(definition?.guarded);
      if (version.guarded) {
        expect(version.approvedBy, version.key).not.toBeNull();
        expect(version.approvedBy, version.key).not.toBe(version.changedBy);
      } else {
        expect(version.approvedBy ?? null, version.key).toBeNull();
      }
    }
  });

  it("ends gates.risk_tiers back on the contract's GATES_BY_RISK, which the runs use", () => {
    const v4 = DEMO_PARAM_VERSIONS.find(
      (version) => version.key === "gates.risk_tiers" && version.version === 4,
    );
    expect(v4?.valueJson).toEqual({
      dusuk: ["5", "12"],
      orta: ["4", "5", "11", "12"],
      kritik: ["4", "5", "9", "11", "12"],
    });
  });
});
