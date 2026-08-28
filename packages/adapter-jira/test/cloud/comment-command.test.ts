import { describe, expect, it } from "vitest";
import {
  codeBlock,
  commandFromCloudPayload,
  doc,
  heading,
  inlineCode,
  JiraArgumentError,
  JiraResponseError,
  link,
  paragraph,
  parseCommandFromComment,
  strong,
  text,
  type AdfDoc,
  type AdfNode,
} from "../../src/index.js";
import { fixture } from "../helpers.js";

const ACCOUNT_ID = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";
const CREATED = "2026-08-10T14:41:10.356+0300";

/** Cloud comment resource in the recorded shape (fixtures/cloud/comments-list.json). */
function comment(body: AdfDoc | string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "10000",
    author: { accountId: ACCOUNT_ID, displayName: "Uğur Yıldız", active: true },
    body: typeof body === "string" ? doc(paragraph(body)) : body,
    created: CREATED,
    updated: CREATED,
    ...overrides,
  };
}

describe("parseCommandFromComment", () => {
  it("does not read a command out of the recorded prose comment", () => {
    const recorded = (fixture("cloud/comments-list") as { comments: unknown[] }).comments[0];
    expect(parseCommandFromComment("OPS-6", recorded)).toEqual({ envelope: null, invalid: null });
  });

  it("parses a bare /approve into a CommandEnvelope", () => {
    const result = parseCommandFromComment("OPS-6", comment("/approve"));
    expect(result.invalid).toBeNull();
    expect(result.envelope).toEqual({
      ticketKey: "OPS-6",
      author: ACCOUNT_ID,
      at: "2026-08-10T14:41:10.356+03:00",
      command: { name: "approve" },
    });
  });

  it('rejects "/approve etmiyorum" — a bare command must be the whole comment (M105)', () => {
    const result = parseCommandFromComment("OPS-6", comment("/approve etmiyorum"));
    expect(result.envelope).toBeNull();
    expect(result.invalid?.messageKey).toBe("command.takes_no_argument");
  });

  it("rejects an /approve followed by a second paragraph", () => {
    const result = parseCommandFromComment("OPS-6", comment(doc(paragraph("/approve"), paragraph("ama emin değilim"))));
    expect(result.envelope).toBeNull();
    expect(result.invalid?.messageKey).toBe("command.takes_no_argument");
  });

  it("rejects an /approve followed by a hard break and more text", () => {
    const body = doc({
      type: "paragraph",
      content: [text("/approve"), { type: "hardBreak" } as unknown as AdfNode, text("ama onaylamıyorum")],
    });
    const result = parseCommandFromComment("OPS-6", comment(body));
    expect(result.envelope).toBeNull();
    expect(result.invalid?.messageKey).toBe("command.takes_no_argument");
  });

  it("never reads a command out of quoted, code or styled text (ADF M105)", () => {
    const none = { envelope: null, invalid: null };
    const quoted = { type: "blockquote", content: [paragraph("/approve")] } as unknown as AdfNode;
    expect(parseCommandFromComment("OPS-6", comment(doc(quoted)))).toEqual(none);
    expect(parseCommandFromComment("OPS-6", comment(doc(codeBlock("/approve"))))).toEqual(none);
    expect(parseCommandFromComment("OPS-6", comment(doc(paragraph([inlineCode("/approve")]))))).toEqual(none);
    expect(parseCommandFromComment("OPS-6", comment(doc(paragraph([link("/approve", "https://x.example")]))))).toEqual(none);
    expect(parseCommandFromComment("OPS-6", comment(doc(paragraph([strong("/approve")]))))).toEqual(none);
    expect(parseCommandFromComment("OPS-6", comment(doc(heading(2, "/approve"))))).toEqual(none);
  });

  it("still blocks a plain /approve trailed by quoted or code content", () => {
    const trailedByCode = parseCommandFromComment("OPS-6", comment(doc(paragraph("/approve"), codeBlock("kanıt"))));
    expect(trailedByCode.envelope).toBeNull();
    expect(trailedByCode.invalid?.messageKey).toBe("command.takes_no_argument");

    const quote = { type: "blockquote", content: [paragraph("önceki yorum")] } as unknown as AdfNode;
    const trailedByQuote = parseCommandFromComment("OPS-6", comment(doc(paragraph("/approve"), quote)));
    expect(trailedByQuote.envelope).toBeNull();
    expect(trailedByQuote.invalid?.messageKey).toBe("command.takes_no_argument");
  });

  it("does not honour an /approve riding with invisible content (a mention)", () => {
    const mention = { type: "mention", attrs: { id: "abc" } } as unknown as AdfNode;
    const result = parseCommandFromComment("OPS-6", comment(doc({ type: "paragraph", content: [text("/approve "), mention] })));
    expect(result.envelope).toBeNull();
    expect(result.invalid).toBeNull(); // the styled/mixed line is not command text at all
  });

  it("keeps the rest of the line for commands with arguments", () => {
    expect(parseCommandFromComment("OPS-6", comment("/reject kapsam belirsiz, PO onayı yok")).envelope?.command).toEqual({
      name: "reject",
      reason: "kapsam belirsiz, PO onayı yok",
    });
    expect(parseCommandFromComment("OPS-6", comment("/ai-assign odeme-servisi")).envelope?.command).toEqual({
      name: "ai-assign",
      appId: "odeme-servisi",
    });
    expect(parseCommandFromComment("OPS-6", comment("/mode-change ai-assist")).envelope?.command).toEqual({
      name: "mode-change",
      mode: "ai_assist",
    });
  });

  it("ignores an edited comment — created and updated disagree", () => {
    const edited = comment("/approve", { updated: "2026-08-10T15:00:00.000+0300" });
    expect(parseCommandFromComment("OPS-6", edited)).toEqual({ envelope: null, invalid: null });
  });

  it("fails loudly when the updated timestamp is missing — unprovably unedited", () => {
    // A poller that maps fields and drops `updated` must not reopen the
    // edited-comment hole: without the timestamp the command is unprovable.
    const stripped = comment("/approve");
    delete stripped["updated"];
    expect(() => parseCommandFromComment("OPS-6", stripped)).toThrowError(JiraResponseError);
    expect(() => parseCommandFromComment("OPS-6", stripped)).toThrowError(/updated/);
  });

  it("flags an unknown command instead of silently ignoring it", () => {
    const result = parseCommandFromComment("OPS-6", comment("/onayla"));
    expect(result.envelope).toBeNull();
    expect(result.invalid?.messageKey).toBe("command.unknown");
  });

  it("fails loudly when a command comment has no identifiable author", () => {
    const anonymous = comment("/approve", { author: { displayName: "Uğur Yıldız" } });
    expect(() => parseCommandFromComment("OPS-6", anonymous)).toThrowError(JiraResponseError);
  });

  it("rejects a malformed ticket key and a non-object comment", () => {
    expect(() => parseCommandFromComment("not-a-key", comment("/approve"))).toThrowError(JiraArgumentError);
    expect(() => parseCommandFromComment("OPS-6", "nope")).toThrowError(JiraResponseError);
  });
});

describe("commandFromCloudPayload", () => {
  it("accepts the poller envelope and the webhook-style envelope alike", () => {
    const poller = commandFromCloudPayload({ ticketKey: "OPS-6", comment: comment("/approve") });
    expect(poller.envelope?.command).toEqual({ name: "approve" });

    const webhookish = commandFromCloudPayload({ issue: { key: "OPS-6" }, comment: comment("/status") });
    expect(webhookish.envelope?.command).toEqual({ name: "status" });
  });

  it("carries no command when the payload has no comment", () => {
    expect(commandFromCloudPayload({ issue: { key: "OPS-6" } })).toEqual({ envelope: null, invalid: null });
  });

  it("fails loudly on a comment payload without any ticket key", () => {
    expect(() => commandFromCloudPayload({ comment: comment("/approve") })).toThrowError(JiraResponseError);
    expect(() => commandFromCloudPayload("nope")).toThrowError(JiraResponseError);
  });
});
