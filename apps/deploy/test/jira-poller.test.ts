import { describe, expect, it } from "vitest";
import { canReadComments } from "../src/jira-poller.js";

/**
 * Which drivers can read a comment thread.
 *
 * The composition root used to hand the poller `ports.work as unknown as
 * { listComments(...) }` — a cast TypeScript accepts and the runtime does not.
 * `listComments` exists ONLY on the Jira Cloud driver: the Data Center work
 * port has no such method, and Azure DevOps has no work port at all.
 *
 * The consequence is the one a bank feels first. `/approve` written on the
 * ticket is the documented way to pass a gate; with no comment reader it is
 * never seen, so the gate waits forever and the run looks stuck for no reason
 * anybody can point at. The per-ticket catch made it worse, not better: the
 * error was logged once per ticket per interval and never explained.
 */
describe("canReadComments", () => {
  it("accepts a driver that really offers the reader", () => {
    expect(canReadComments({ listComments: () => Promise.resolve([]) })).toBe(true);
  });

  /**
   * Shaped like the real Data Center work port: everything the workflow needs
   * — ticket, comment WRITING, transition — and no comment READING.
   */
  it("rejects a work driver that cannot read comments — the DC case", () => {
    const dcWorkPort = {
      getTicket: () => Promise.resolve({}),
      addComment: () => Promise.resolve({ commentId: "1" }),
      updateComment: () => Promise.resolve(),
      transition: () => Promise.resolve(),
    };

    expect(canReadComments(dcWorkPort)).toBe(false);
  });

  /**
   * A property that merely EXISTS is what the old cast effectively assumed;
   * calling a non-function throws the very error this check exists to prevent.
   */
  it("rejects a driver whose listComments is not callable", () => {
    expect(canReadComments({ listComments: true })).toBe(false);
  });

  it("rejects nothing at all rather than throwing on it", () => {
    expect(canReadComments(null)).toBe(false);
    expect(canReadComments(undefined)).toBe(false);
  });
});
