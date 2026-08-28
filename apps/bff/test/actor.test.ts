import { describe, expect, it } from "vitest";
import { toActorOrNull } from "../src/actor.js";

/**
 * Turning an outside login into an audit actor.
 *
 * Found live: `/approve` written on a Jira Cloud ticket by a person who IS in
 * the approver group was refused as `unknown_actor`. Cloud identifies people by
 * account id (`712020:7ee7a2ab-…`) and the frozen `HUMAN_ACTOR` pattern in
 * `packages/audit` allows no colon — so a real decision was discarded over the
 * shape of an id.
 */

const DOMAIN = "banka.local";

describe("toActorOrNull", () => {
  it("accepts a Jira Cloud account id", () => {
    const actor = toActorOrNull("712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1", DOMAIN);
    expect(actor).toBe("712020.7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1@banka.local");
  });

  it("keeps two account ids that differ only in the colon apart", () => {
    // Stripping the colon instead of replacing it would map these onto one
    // actor, and an audit trail that cannot tell two approvers apart is worse
    // than one that refuses both.
    const a = toActorOrNull("123:abc", DOMAIN);
    const b = toActorOrNull("123abc", DOMAIN);
    expect(a).not.toBe(b);
  });

  it("passes an already-qualified address through untouched", () => {
    expect(toActorOrNull("mert.demir@banka.local", DOMAIN)).toBe("mert.demir@banka.local");
  });

  it("qualifies a bare corporate login", () => {
    expect(toActorOrNull("mert.demir", DOMAIN)).toBe("mert.demir@banka.local");
  });

  it("returns null rather than throwing for input the trail cannot classify", () => {
    // A webhook route answers 202 on null; throwing would become a 500, and
    // Jira retries a 5xx forever.
    expect(toActorOrNull("", DOMAIN)).toBeNull();
    expect(toActorOrNull("   ", DOMAIN)).toBeNull();
    expect(toActorOrNull("@@@", DOMAIN)).toBeNull();
  });
});
