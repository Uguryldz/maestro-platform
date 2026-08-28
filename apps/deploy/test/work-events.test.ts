import { describe, expect, it } from "vitest";
import { jiraWorkEventReader } from "../src/work-events.js";

/**
 * The `WorkEventReader` the composition root injects.
 *
 * It is the ONLY place the platform learns a ticket's status: the frozen
 * `TicketSnapshot` carries none, so a listening rule keyed on status can only
 * be answered from the delivery. Getting the extraction wrong would silently
 * send tickets down the wrong flow — a rule that never matches falls back to
 * the deployment default rather than erroring — so it is pinned here.
 */

function issue(fields: Record<string, unknown>): unknown {
  return {
    webhookEvent: "jira:issue_created",
    timestamp: Date.parse("2026-08-09T06:00:00.000Z"),
    issue: { key: "UGURPAY-1", fields },
  };
}

describe("jiraWorkEventReader", () => {
  it("reads status, issue type and assignee out of a Jira delivery", () => {
    const event = jiraWorkEventReader().read(
      issue({
        labels: ["ai-ready"],
        status: { name: "Yapılacak" },
        issuetype: { name: "Hata" },
        assignee: { accountId: "712020:bot" },
      }),
    );

    expect(event).toMatchObject({
      kind: "issue",
      ticketKey: "UGURPAY-1",
      labels: ["ai-ready"],
      status: "Yapılacak",
      issueType: "Hata",
      assignee: "712020:bot",
    });
  });

  it("prefers accountId over the DC name fields (Jira Cloud has only accountId)", () => {
    const event = jiraWorkEventReader().read(
      issue({ assignee: { accountId: "712020:bot", name: "legacy", emailAddress: "bot@corp" } }),
    );
    expect(event.assignee).toBe("712020:bot");
  });

  it("falls back to the DC name when there is no accountId", () => {
    const event = jiraWorkEventReader().read(issue({ assignee: { name: "uyildiz" } }));
    expect(event.assignee).toBe("uyildiz");
  });

  it("leaves fields ABSENT when the payload omits them", () => {
    // Absent must not become "" — an empty string could match a rule whose
    // matchValue is empty, classifying every ticket that simply lacked a status.
    const event = jiraWorkEventReader().read(issue({ labels: [] }));
    expect(event.status).toBeUndefined();
    expect(event.issueType).toBeUndefined();
    expect(event.assignee).toBeUndefined();
  });

  it("treats an unassigned ticket and a whitespace-only name as unassigned", () => {
    expect(jiraWorkEventReader().read(issue({ assignee: null })).assignee).toBeUndefined();
    expect(jiraWorkEventReader().read(issue({ assignee: { accountId: "   " } })).assignee).toBeUndefined();
  });

  it("ignores a status object that carries no usable name", () => {
    expect(jiraWorkEventReader().read(issue({ status: { name: "  " } })).status).toBeUndefined();
    expect(jiraWorkEventReader().read(issue({ status: "Yapılacak" })).status).toBeUndefined();
  });

  it("trims the names it reads", () => {
    const event = jiraWorkEventReader().read(issue({ status: { name: " Yapılacak " } }));
    expect(event.status).toBe("Yapılacak");
  });

  it("still reads labels, the behaviour it had before flow selection", () => {
    expect(jiraWorkEventReader().read(issue({ labels: ["ai-ready", "x"] })).labels).toEqual(["ai-ready", "x"]);
    expect(jiraWorkEventReader().read(issue({})).labels).toBeUndefined();
  });
});
