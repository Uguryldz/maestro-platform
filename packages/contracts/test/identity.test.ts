import { describe, expect, it } from "vitest";
import { GATES_BY_RISK } from "../src/workflow.js";
import {
  canDecideGate,
  GATE_OWNER_ROLE,
  hasRole,
  Role,
  ROLES,
  SessionRecord,
  SessionView,
} from "../src/identity.js";

const session = (over: Partial<SessionView> = {}): SessionView => ({
  userId: "ayse.kaya@bank",
  username: "ayse.kaya",
  groups: ["tech-leads"],
  roles: ["tech-lead"],
  delegated: false,
  issuedAt: "2026-08-09T10:00:00+03:00",
  expiresAt: "2026-08-09T18:00:00+03:00",
  ...over,
});

describe("the role set is closed (M8)", () => {
  it("refuses a role nobody defined", () => {
    // The spellings that were loose in the tree before this contract existed.
    for (const drifted of ["tech-leads", "tl", "yonetici", "stajyer", "TECH-LEAD", ""]) {
      expect(Role.safeParse(drifted).success).toBe(false);
    }
  });

  it("accepts exactly the six roles and no more", () => {
    expect([...ROLES]).toEqual(["admin", "tech-lead", "product-owner", "qa", "developer", "viewer"]);
    for (const role of ROLES) expect(Role.safeParse(role).success).toBe(true);
  });

  it("carries a directory role it has never heard of, verbatim", () => {
    const parsed = SessionRecord.safeParse({
      ...session(),
      token: "t".repeat(43),
      roles: ["tech-lead", "release-manager"],
    });
    // The bank's directory owns these names and may grant one this platform
    // does not model. Dropping it would make the person appear to hold fewer
    // roles than they were granted, with nothing recording the discard —
    // exactly the kind of silent difference an audit cannot reconstruct.
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.roles).toEqual(["tech-lead", "release-manager"]);
  });

  it("grants nothing for a role outside the union", () => {
    const outsider = session({ roles: ["release-manager", "wizard"] });
    // Carried, yes. Authoritative, no: every gate still refuses.
    for (const step of Object.keys(GATE_OWNER_ROLE)) {
      expect(canDecideGate(outsider, step)).toBe(false);
    }
    for (const role of ROLES) expect(hasRole(outsider, role)).toBe(false);
  });

  it("still rejects a role that is not a string at all", () => {
    const parsed = SessionRecord.safeParse({
      ...session(),
      token: "t".repeat(43),
      roles: ["tech-lead", 42],
    });
    // Open to unknown NAMES is not open to unknown SHAPES: a number here is a
    // mapping bug in the identity driver, not a role the directory granted.
    expect(parsed.success).toBe(false);
  });
});

describe("the session view never carries the credential", () => {
  it("omits the token even when one is supplied", () => {
    const parsed = SessionView.parse({ ...session(), token: "secret-token-value" });
    expect(parsed).not.toHaveProperty("token");
    expect(JSON.stringify(parsed)).not.toContain("secret-token-value");
  });

  it("still requires the fields a client renders from", () => {
    expect(SessionView.safeParse({ userId: "a@b", username: "a" }).success).toBe(false);
  });
});

describe("gate ownership agrees with the workflow's own gate set (M51)", () => {
  it("every approval gate a critical run opens has a named owning role", () => {
    for (const step of GATES_BY_RISK.kritik) {
      expect(GATE_OWNER_ROLE[step as keyof typeof GATE_OWNER_ROLE]).toBeDefined();
    }
  });

  it("names no owner for a step that is not a gate", () => {
    expect(GATE_OWNER_ROLE["13" as keyof typeof GATE_OWNER_ROLE]).toBeUndefined();
    expect(canDecideGate(session(), "13")).toBe(false);
  });
});

describe("canDecideGate", () => {
  it("lets the owning role decide its own gate", () => {
    expect(canDecideGate(session({ roles: ["tech-lead"] }), "5")).toBe(true);
    expect(canDecideGate(session({ roles: ["product-owner"] }), "4")).toBe(true);
    expect(canDecideGate(session({ roles: ["qa"] }), "11")).toBe(true);
  });

  it("refuses the wrong role — a PO does not close the Tech Lead gate", () => {
    expect(canDecideGate(session({ roles: ["product-owner"] }), "5")).toBe(false);
  });

  it("refuses an admin: administering the platform is not approval authority (M32)", () => {
    // An admin who could close any gate is one account approving its own work.
    expect(canDecideGate(session({ roles: ["admin"] }), "5")).toBe(false);
    expect(canDecideGate(session({ roles: ["admin"] }), "4")).toBe(false);
  });

  it("refuses a delegated session at every gate — approval is human-only (M101)", () => {
    for (const step of Object.keys(GATE_OWNER_ROLE)) {
      expect(canDecideGate(session({ roles: ["tech-lead", "qa", "product-owner"], delegated: true }), step)).toBe(false);
    }
  });

  it("refuses a session with no roles at all", () => {
    expect(canDecideGate(session({ roles: [] }), "5")).toBe(false);
  });
});

describe("hasRole", () => {
  it("is exact, not a prefix or case match", () => {
    expect(hasRole(session({ roles: ["tech-lead"] }), "tech-lead")).toBe(true);
    expect(hasRole(session({ roles: ["tech-lead"] }), "developer")).toBe(false);
    expect(hasRole(session({ roles: ["viewer"] }), "viewer")).toBe(true);
  });
});
