import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../src/deps.js";
import {
  CONFIDENTIAL_GROUP,
  UNLABELLED_CLASS,
  effectiveClass,
  mayRead,
  visibleKnowledge,
} from "../src/knowledge-policy.js";
import type { Page } from "../src/read-models.js";
import { MAX_PAGE_SIZE, visibleProjects } from "../src/routes/paging.js";
import { decodeCursor, encodeCursor, paginate } from "../src/stores/read-memory.js";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    token: "t",
    userId: "kisi@ugurbank.local",
    username: "kisi",
    groups: [],
    roles: [],
    delegated: false,
    issuedAt: "2026-08-09T09:00:00.000Z",
    expiresAt: "2026-08-09T17:00:00.000Z",
    ...overrides,
  };
}

/**
 * M18/M63 fail-closed classification. These are unit tests rather than route
 * tests on purpose: the rule has to hold for every caller of the policy, not
 * just for the one endpoint that happens to use it today.
 */
describe("knowledge classification", () => {
  it("treats an unlabelled document as the strictest class", () => {
    expect(UNLABELLED_CLASS).toBe("gizli");
    expect(effectiveClass(undefined)).toBe("gizli");
    expect(effectiveClass(null)).toBe("gizli");
    expect(effectiveClass("")).toBe("gizli");
    // A class nobody recognises is not a reason to assume the common one.
    expect(effectiveClass("herkese-acik")).toBe("gizli");
  });

  it("passes a recognised class through", () => {
    expect(effectiveClass("acik")).toBe("acik");
    expect(effectiveClass("dahili")).toBe("dahili");
    expect(effectiveClass("gizli")).toBe("gizli");
  });

  it("does not treat a session as a clearance", () => {
    expect(mayRead(session(), "dahili")).toBe(true);
    expect(mayRead(session(), "gizli")).toBe(false);
  });

  it("grants gizli by group or by an auditing role", () => {
    expect(mayRead(session({ groups: [CONFIDENTIAL_GROUP] }), "gizli")).toBe(true);
    expect(mayRead(session({ roles: ["admin"] }), "gizli")).toBe(true);
    expect(mayRead(session({ roles: ["internal-audit"] }), "gizli")).toBe(true);
    // A tech lead runs the delivery flow; that is not a data clearance.
    expect(mayRead(session({ roles: ["tech-lead"] }), "gizli")).toBe(false);
  });

  it("counts what it withheld instead of shortening the list silently", () => {
    const docs = [{ dataClass: "dahili" }, { dataClass: "gizli" }, { dataClass: undefined }];

    const result = visibleKnowledge(docs, session());

    expect(result.visible).toHaveLength(1);
    expect(result.withheld).toBe(2);
  });
});

describe("project scoping", () => {
  it("returns null for a role that sees every project", () => {
    expect(visibleProjects(session({ roles: ["admin"] }))).toBeNull();
    expect(visibleProjects(session({ roles: ["tech-lead"] }))).toBeNull();
  });

  it("derives project keys from the directory groups", () => {
    const scope = visibleProjects(session({ groups: ["maestro-ugurpay", "maestro-ugurweb"] }));
    expect(scope).toEqual(["UGURPAY", "UGURWEB"]);
  });

  /** A stray directory group must never widen access. */
  it("ignores groups that are not project groups", () => {
    expect(visibleProjects(session({ groups: ["tech-leads", "domain-users", "maestro-"] }))).toEqual([]);
  });

  it("gives a roleless, groupless account access to nothing", () => {
    expect(visibleProjects(session())).toEqual([]);
  });
});

describe("cursor paging", () => {
  const rows = Array.from({ length: 10 }, (_, index) => index);

  it("walks the whole list exactly once", () => {
    const seen: number[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 10; guard += 1) {
      const page: Page<number> = paginate(rows, { limit: 3, cursor }, "fp");
      seen.push(...page.items);
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual(rows);
  });

  it("ends with a null cursor rather than an empty final page", () => {
    const page = paginate(rows, { limit: 20, cursor: null }, "fp");
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBeNull();
  });

  /**
   * The bug this exists to pin: fingerprints contain colons
   * (`journal:<runId>:<actor>`), and splitting on the last one parsed the
   * offset out of the fingerprint's middle, so every cursor looked foreign and
   * every "next page" silently served page one again.
   */
  it("round-trips an offset through a fingerprint containing colons", () => {
    const fingerprint = "journal:run-UGURPAY-501:ai";
    expect(decodeCursor(encodeCursor(6, fingerprint), fingerprint)).toBe(6);
  });

  it("refuses a cursor minted for a different query", () => {
    const cursor = encodeCursor(6, "runs:ugurpay");
    // Restarting is the safe answer: continuing would page through one list at
    // an offset that meant something in another.
    expect(decodeCursor(cursor, "runs:ugurweb")).toBe(0);
  });

  it("ignores a cursor that is not one of ours", () => {
    expect(decodeCursor("bu-bir-cursor-degil", "fp")).toBe(0);
    expect(decodeCursor(encodeCursor(-5, "fp"), "fp")).toBe(0);
  });

  it("keeps the page ceiling in one place", () => {
    expect(MAX_PAGE_SIZE).toBe(200);
  });
});
