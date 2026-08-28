import { TicketSnapshot } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  adfToCommandLines,
  adfToPlainText,
  cloudDescriptionText,
  cloudUserIdOf,
  codeBlock,
  doc,
  inlineCode,
  JiraResponseError,
  mapCloudIssueToSnapshot,
  paragraph,
  text,
  type AdfNode,
} from "../../src/index.js";
import { fixture } from "../helpers.js";

const ACCOUNT_ID = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";

function recordedIssue(): Record<string, unknown> {
  return structuredClone(fixture("cloud/issue-get")) as Record<string, unknown>;
}

describe("mapCloudIssueToSnapshot", () => {
  it("maps the recorded Cloud issue to a contract-valid snapshot", () => {
    const snapshot = mapCloudIssueToSnapshot(fixture("cloud/issue-get"));

    expect(TicketSnapshot.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.key).toBe("OPS-6");
    expect(snapshot.projectKey).toBe("OPS");
    expect(snapshot.issueType).toBe("Görev");
    expect(snapshot.summary).toBe("(Örnek) Ödeme Onayı");
    expect(snapshot.reporter).toBe(ACCOUNT_ID);
    expect(snapshot.assignee).toBeNull();
    expect(snapshot.components).toEqual([]);
    expect(snapshot.labels).toEqual([]);
    expect(snapshot.parentKey).toBe("OPS-2");
  });

  it("flattens the ADF description to plain text with the Turkish text intact", () => {
    const snapshot = mapCloudIssueToSnapshot(fixture("cloud/issue-get"));
    expect(snapshot.description).toBe(
      "İşlem başarılı olduğunda kullanıcıya e-posta ile makbuz gönderen bir ödeme onayı özelliği uygulayın.",
    );
  });

  it("normalises the Cloud +0300 offsets to the contract form", () => {
    const snapshot = mapCloudIssueToSnapshot(fixture("cloud/issue-get"));
    expect(snapshot.createdAt).toBe("2026-08-10T14:35:21.403+03:00");
    expect(snapshot.updatedAt).toBe("2026-08-10T14:35:23.040+03:00");
  });

  it("tolerates a missing components field (team-managed projects)", () => {
    const issue = recordedIssue();
    delete (issue["fields"] as Record<string, unknown>)["components"];
    expect(mapCloudIssueToSnapshot(issue).components).toEqual([]);
  });

  it("maps a null description to an empty string", () => {
    const issue = recordedIssue();
    (issue["fields"] as Record<string, unknown>)["description"] = null;
    expect(mapCloudIssueToSnapshot(issue).description).toBe("");
  });

  it("fails loudly on a payload without fields", () => {
    expect(() => mapCloudIssueToSnapshot({ key: "OPS-6" })).toThrowError(JiraResponseError);
    expect(() => mapCloudIssueToSnapshot("nope")).toThrowError(JiraResponseError);
  });

  it("reports the offending field when the contract rejects the mapping", () => {
    const issue = recordedIssue();
    (issue["fields"] as Record<string, unknown>)["summary"] = "";
    expect(() => mapCloudIssueToSnapshot(issue)).toThrowError(/summary/);
  });
});

describe("cloudUserIdOf", () => {
  it("prefers the accountId, falls back to the e-mail, never the displayName", () => {
    expect(cloudUserIdOf({ accountId: ACCOUNT_ID, emailAddress: "x@y.z", displayName: "Uğur Yıldız" })).toBe(ACCOUNT_ID);
    expect(cloudUserIdOf({ emailAddress: "x@y.z", displayName: "Uğur Yıldız" })).toBe("x@y.z");
    expect(cloudUserIdOf({ displayName: "Uğur Yıldız" })).toBeNull();
    expect(cloudUserIdOf(null)).toBeNull();
  });
});

describe("adfToPlainText", () => {
  it("joins top-level blocks with a blank line", () => {
    expect(adfToPlainText(doc(paragraph("bir"), paragraph("iki")))).toBe("bir\n\niki");
  });

  it("keeps hard breaks as line breaks inside a paragraph", () => {
    const document = doc({
      type: "paragraph",
      content: [text("üst"), { type: "hardBreak" } as unknown as AdfNode, text("alt")],
    });
    expect(adfToPlainText(document)).toBe("üst\nalt");
  });

  it("replaces unknown leaf nodes with a placeholder instead of dropping them", () => {
    const mention = { type: "mention", attrs: { id: "abc" } } as unknown as AdfNode;
    const document = doc({ type: "paragraph", content: [text("/approve "), mention] });
    expect(adfToPlainText(document)).toBe("/approve ￼");
  });

  it("tags only plain top-level paragraph text as command-capable", () => {
    const lines = adfToCommandLines(
      doc(paragraph("/approve"), codeBlock("/reject örnek"), paragraph([inlineCode("/status")])),
    );
    expect(lines).toEqual([
      { text: "/approve", commandCapable: true },
      { text: "/reject örnek", commandCapable: false }, // visible, but never a command
      { text: "/status", commandCapable: false },
    ]);
  });

  it("flattens the recorded comment body including the code-marked run", () => {
    const comments = fixture("cloud/comments-list") as { comments: { body: unknown }[] };
    const flat = cloudDescriptionText(comments.comments[0]!.body);
    expect(flat).toContain("Maestro bağlantı testi");
    expect(flat).toContain("/approve · /reject <sebep> · /status");
  });
});
