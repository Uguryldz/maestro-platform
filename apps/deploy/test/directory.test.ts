import type { DirectoryReader } from "@maestro/workflows";
import { describe, expect, it } from "vitest";
import {
  firstAvailableDirectory,
  PrismaDirectoryReader,
  type DirectoryUserDelegate,
  type DirectoryUserRow,
} from "../src/stores/directory.js";
import { PrismaPublishState, type PublishStateDelegate, type PublishStateRow } from "../src/stores/publish-state.js";

const USERS: DirectoryUserRow[] = [
  { email: "ayse.kaya@ugurbank.local", groupsJson: ["product-owners"], active: true },
  { email: "mert.demir@ugurbank.local", groupsJson: ["tech-leads", "developers"], active: true },
  { email: "deniz.yalcin@ugurbank.local", groupsJson: ["qa"], active: true },
  { email: "ayrilan@ugurbank.local", groupsJson: ["tech-leads"], active: false },
  { email: "bozuk@ugurbank.local", groupsJson: "not-an-array", active: true },
];

function fakeUsers(rows: DirectoryUserRow[] = USERS): DirectoryUserDelegate {
  return { findMany: ({ where }) => Promise.resolve(rows.filter((row) => row.active === where.active)) };
}

describe("PrismaDirectoryReader", () => {
  it("resolves a group to its members' addresses", async () => {
    const reader = new PrismaDirectoryReader(fakeUsers());
    expect(await reader.membersOf("tech-leads")).toEqual(["mert.demir@ugurbank.local"]);
  });

  it("returns every member of a group, sorted", async () => {
    const reader = new PrismaDirectoryReader(
      fakeUsers([
        { email: "zeynep@bank", groupsJson: ["qa"], active: true },
        { email: "ali@bank", groupsJson: ["qa"], active: true },
      ]),
    );
    expect(await reader.membersOf("qa")).toEqual(["ali@bank", "zeynep@bank"]);
  });

  /**
   * A departed approver's row is kept — their name is on closed gates — but
   * they must not be sent a reminder for a gate they can no longer close.
   */
  it("excludes deactivated users", async () => {
    const reader = new PrismaDirectoryReader(fakeUsers());
    expect(await reader.membersOf("tech-leads")).not.toContain("ayrilan@ugurbank.local");
  });

  it("treats a malformed groups column as no membership, never as a match", async () => {
    const reader = new PrismaDirectoryReader(fakeUsers());
    expect(await reader.membersOf("not-an-array")).toEqual([]);
    for (const group of ["product-owners", "qa"]) {
      expect(await reader.membersOf(group)).not.toContain("bozuk@ugurbank.local");
    }
  });

  /**
   * An empty group is a real, reportable state — "nobody holds this gate" —
   * and the notifier is what decides about it. What would be wrong is
   * inventing an address, which this never does.
   */
  it("reports an unknown group as empty rather than inventing an address", async () => {
    const reader = new PrismaDirectoryReader(fakeUsers());
    expect(await reader.membersOf("no-such-group")).toEqual([]);
  });
});

describe("firstAvailableDirectory", () => {
  const ldapsLike = (members: string[]): DirectoryReader => ({
    membersOf: () => Promise.resolve(members),
    groupForRole: (role) => Promise.resolve(role),
  });

  /** A reader whose every lookup fails, for the outage cases below. */
  const broken = (message: string): DirectoryReader => ({
    membersOf: () => Promise.reject(new Error(message)),
    groupForRole: (role) => Promise.resolve(role),
  });

  it("prefers the first reader that answers", async () => {
    const chained = firstAvailableDirectory([ldapsLike(["ldaps@bank"]), ldapsLike(["local@bank"])]);
    expect(await chained.membersOf("tech-leads")).toEqual(["ldaps@bank"]);
  });

  it("falls through to the next reader when the first knows nothing", async () => {
    const chained = firstAvailableDirectory([ldapsLike([]), ldapsLike(["local@bank"])]);
    expect(await chained.membersOf("tech-leads")).toEqual(["local@bank"]);
  });

  /**
   * A directory that is DOWN must not silently empty a distribution list. An
   * LDAPS outage that ended the chain would read exactly like a correctly
   * empty group, and the gate would go unescalated.
   */
  it("keeps asking after a reader fails, so an outage does not empty a group", async () => {
    const chained = firstAvailableDirectory([broken("ldaps down"), ldapsLike(["local@bank"])]);
    expect(await chained.membersOf("tech-leads")).toEqual(["local@bank"]);
  });

  it("throws only when every reader failed", async () => {
    const chained = firstAvailableDirectory([broken("down"), broken("down")]);
    await expect(chained.membersOf("tech-leads")).rejects.toBeInstanceOf(AggregateError);
  });

  it("reports an empty group as empty when the readers were healthy", async () => {
    const chained = firstAvailableDirectory([ldapsLike([]), ldapsLike([])]);
    expect(await chained.membersOf("tech-leads")).toEqual([]);
  });

  it("refuses to build a chain with no readers", () => {
    expect(() => firstAvailableDirectory([])).toThrow(/at least one/);
  });
});

/**
 * The publisher's receipt memory. Without it a republish adds a SECOND Jira
 * comment instead of editing the first — every time.
 */
describe("PrismaPublishState", () => {
  function fakeState(): { delegate: PublishStateDelegate; rows: Map<string, PublishStateRow> } {
    const rows = new Map<string, PublishStateRow>();
    return {
      rows,
      delegate: {
        findUnique: ({ where }) => Promise.resolve(rows.get(where.key) ?? null),
        upsert: ({ where, create, update }) => {
          const existing = rows.get(where.key);
          rows.set(where.key, existing === undefined
            ? { key: create.key, value: create.value }
            : { key: where.key, value: update.value });
          return Promise.resolve(undefined);
        },
      },
    };
  }

  it("remembers what it published", async () => {
    const state = fakeState();
    const store = new PrismaPublishState(state.delegate);
    await store.set("analysis:run-1", JSON.stringify({ commentId: "c1", hash: "abc" }));
    expect(await store.get("analysis:run-1")).toBe('{"commentId":"c1","hash":"abc"}');
  });

  /**
   * `null` — not an error — is right for exactly this store: "I have never
   * published this document" is the normal first-publish case, and throwing
   * would make every document's first publish a failure.
   */
  it("reports a never-published document as null", async () => {
    const state = fakeState();
    expect(await new PrismaPublishState(state.delegate).get("analysis:run-9")).toBeNull();
  });

  it("overwrites on republish so the receipt tracks the latest publish", async () => {
    const state = fakeState();
    const store = new PrismaPublishState(state.delegate);
    await store.set("analysis:run-1", "first");
    await store.set("analysis:run-1", "second");
    expect(await store.get("analysis:run-1")).toBe("second");
    expect(state.rows.size).toBe(1);
  });
});
