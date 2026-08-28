import { TicketSnapshot } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { ISSUE_FIELDS, JiraResponseError, mapIssueToSnapshot, normalizeJiraDateTime, userIdOf } from "../src/index.js";
import { fixture } from "./helpers.js";

describe("issue mapping", () => {
  it("maps a recorded DC issue into a contract-valid TicketSnapshot", () => {
    const snapshot = mapIssueToSnapshot(fixture("issue-get"));

    // The adapter output must survive the frozen contract, not just look right.
    expect(() => TicketSnapshot.parse(snapshot)).not.toThrow();
    expect(snapshot).toMatchObject({
      key: "UGURPAY-501",
      projectKey: "UGURPAY",
      issueType: "Story",
      reporter: "ayse.kaya",
      assignee: "mert.demir",
      components: ["auth-service", "web-frontend"],
      labels: ["maestro", "guvenlik"],
      parentKey: "UGURPAY-490",
    });
    expect(snapshot.createdAt).toBe("2026-07-31T09:14:02.000+03:00");
    expect(snapshot.updatedAt).toBe("2026-08-08T13:12:33.000+03:00");
    expect(snapshot.description).toContain("6 haneli kod");
  });

  it("maps the issue embedded in a webhook envelope too", () => {
    const payload = fixture("webhook-issue-created") as { issue: unknown };
    const snapshot = mapIssueToSnapshot(payload.issue);

    expect(snapshot.assignee).toBeNull();
    expect(snapshot.parentKey).toBeNull();
    expect(snapshot.components).toEqual([]);
    expect(TicketSnapshot.parse(snapshot).labels).toEqual(["maestro"]);
  });

  it("reports which field is missing instead of dying inside zod", () => {
    const broken = { key: "UGURPAY-1", fields: { created: "2026-01-01T00:00:00.000+0300", updated: "2026-01-01T00:00:00.000+0300" } };
    const error = (() => {
      try {
        mapIssueToSnapshot(broken);
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(JiraResponseError);
    expect((error as JiraResponseError).issues.join(" ")).toMatch(/issueType|summary|reporter/);
  });

  it("rejects payloads that are not issues at all", () => {
    expect(() => mapIssueToSnapshot(null)).toThrow(JiraResponseError);
    expect(() => mapIssueToSnapshot({ key: "UGURPAY-1" })).toThrow(/missing fields object/);
  });

  it("falls back through the DC identity fields", () => {
    expect(userIdOf({ name: "mert.demir", key: "JIRAUSER1" })).toBe("mert.demir");
    expect(userIdOf({ key: "JIRAUSER1" })).toBe("JIRAUSER1");
    expect(userIdOf({ displayName: "Mert Demir" })).toBe("Mert Demir");
    expect(userIdOf(null)).toBeNull();
  });

  it("normalises DC offsets and epoch millis", () => {
    expect(normalizeJiraDateTime("2026-08-08T13:12:33.000+0300", "t")).toBe("2026-08-08T13:12:33.000+03:00");
    expect(normalizeJiraDateTime("2026-08-08T10:12:33.000Z", "t")).toBe("2026-08-08T10:12:33.000Z");
    expect(normalizeJiraDateTime(1786183953000, "t")).toBe("2026-08-08T10:12:33.000Z");
    expect(() => normalizeJiraDateTime("dün", "t")).toThrow(JiraResponseError);
    expect(() => normalizeJiraDateTime(undefined, "t")).toThrow(JiraResponseError);
  });

  it("requests only stock fields — no custom field dependency (M98)", () => {
    expect(ISSUE_FIELDS.split(",")).toContain("components");
    expect(ISSUE_FIELDS).not.toContain("customfield");
  });
});
