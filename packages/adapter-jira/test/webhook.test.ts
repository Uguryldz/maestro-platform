import { CommandEnvelope } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  commandFromWebhook,
  JIRA_SIGNATURE_HEADER,
  JiraResponseError,
  JiraWebhookVerificationError,
  parseWebhookEvent,
  signWebhookBody,
  verifyWebhookSignature,
} from "../src/index.js";
import { fixture } from "./helpers.js";

const SECRET = "webhook-shared-secret";

describe("webhook signature verification", () => {
  const rawBody = JSON.stringify(fixture("webhook-comment-created"));
  const signature = signWebhookBody(rawBody, SECRET);

  it("names the header the BFF must read the signature from", () => {
    expect(JIRA_SIGNATURE_HEADER).toBe("x-hub-signature");
  });

  it("accepts a correct HMAC-SHA256 over the raw body", () => {
    expect(() => verifyWebhookSignature(rawBody, signature, SECRET)).not.toThrow();
  });

  it("accepts the digest with or without the sha256= prefix and in any case", () => {
    const hex = signature.slice("sha256=".length);
    expect(() => verifyWebhookSignature(rawBody, hex, SECRET)).not.toThrow();
    expect(() => verifyWebhookSignature(rawBody, `SHA256=${hex.toUpperCase()}`, SECRET)).not.toThrow();
  });

  it("verifies over bytes, so a re-serialised body fails", () => {
    const reserialised = JSON.stringify(JSON.parse(rawBody), null, 2);
    expect(() => verifyWebhookSignature(reserialised, signature, SECRET)).toThrow(JiraWebhookVerificationError);
  });

  it("fails closed on a tampered body, wrong secret, missing or malformed header", () => {
    const reasons = [
      [() => verifyWebhookSignature(`${rawBody} `, signature, SECRET), "mismatch"],
      [() => verifyWebhookSignature(rawBody, signWebhookBody(rawBody, "other"), SECRET), "mismatch"],
      [() => verifyWebhookSignature(rawBody, null, SECRET), "missing_signature"],
      [() => verifyWebhookSignature(rawBody, "   ", SECRET), "missing_signature"],
      [() => verifyWebhookSignature(rawBody, "sha256=not-hex", SECRET), "malformed_signature"],
      [() => verifyWebhookSignature(rawBody, signature, ""), "missing_secret"],
    ] as const;

    for (const [run, reason] of reasons) {
      expect(run).toThrow(JiraWebhookVerificationError);
      expect(run).toThrow(new RegExp(reason));
    }
  });

  it("verifies Buffer bodies identically (raw bytes off the socket)", () => {
    expect(() => verifyWebhookSignature(Buffer.from(rawBody, "utf8"), signature, SECRET)).not.toThrow();
  });
});

describe("webhook event classification", () => {
  it("classifies a comment event", () => {
    const event = parseWebhookEvent(fixture("webhook-comment-created"));
    expect(event).toMatchObject({
      kind: "comment",
      event: "comment_created",
      ticketKey: "UGURPAY-501",
      author: "mert.demir",
      commentId: "45201",
      at: "2026-08-08T13:12:33.000+03:00",
    });
  });

  it("classifies an issue-created event", () => {
    expect(parseWebhookEvent(fixture("webhook-issue-created"))).toMatchObject({
      kind: "issue",
      event: "jira:issue_created",
      ticketKey: "UGURPAY-501",
    });
  });

  it("passes unrelated events through as 'other' (single global webhook — M102)", () => {
    expect(parseWebhookEvent({ webhookEvent: "jira:worklog_updated" })).toEqual({
      kind: "other",
      event: "jira:worklog_updated",
    });
  });

  it("refuses payloads that are not objects", () => {
    expect(() => parseWebhookEvent("nope")).toThrow(JiraResponseError);
  });

  it("refuses a comment event without an identifiable author", () => {
    expect(() =>
      parseWebhookEvent({
        webhookEvent: "comment_created",
        issue: { key: "UGURPAY-1" },
        comment: { id: "1", body: "/approve", created: "2026-08-08T13:12:33.000+0300", author: {} },
      }),
    ).toThrow(/author/);
  });
});

describe("command extraction from webhooks", () => {
  it("produces a contract-valid CommandEnvelope", () => {
    const { envelope, invalid } = commandFromWebhook(fixture("webhook-comment-created"));
    expect(invalid).toBeNull();
    expect(envelope).not.toBeNull();
    expect(CommandEnvelope.parse(envelope)).toEqual({
      ticketKey: "UGURPAY-501",
      author: "mert.demir",
      at: "2026-08-08T13:12:33.000+03:00",
      command: { name: "approve" },
    });
  });

  it("returns no envelope for non-comment events", () => {
    expect(commandFromWebhook(fixture("webhook-issue-created"))).toEqual({ envelope: null, invalid: null });
  });

  it("reports a malformed command without an envelope", () => {
    const payload = fixture("webhook-comment-created") as { comment: { body: string } };
    payload.comment.body = "/reject";
    const result = commandFromWebhook(payload);

    expect(result.envelope).toBeNull();
    expect(result.invalid).toMatchObject({ command: "reject", messageKey: "command.reject_needs_reason" });
  });

  // K-2: "Edit All Comments" is a routine lead permission in DC. Honouring an
  // edit would let a non-member approve a gate under the original author's
  // name — the SoD matrix (M32) would never see it.
  it("ignores a comment_updated event even when it carries a command", () => {
    const payload = fixture("webhook-comment-created") as {
      webhookEvent: string;
      comment: { updateAuthor: { name: string }; updated: string };
    };
    payload.webhookEvent = "comment_updated";
    payload.comment.updateAuthor = { name: "kotu.niyetli" };
    payload.comment.updated = "2026-08-08T14:40:00.000+0300";

    expect(parseWebhookEvent(payload)).toMatchObject({ kind: "comment", edited: true, author: "mert.demir" });
    expect(commandFromWebhook(payload)).toEqual({ envelope: null, invalid: null });
  });

  it("ignores a created delivery whose comment has already been edited", () => {
    const payload = fixture("webhook-comment-created") as { comment: { updated: string } };
    payload.comment.updated = "2026-08-08T14:40:00.000+0300";

    expect(parseWebhookEvent(payload)).toMatchObject({ edited: true });
    expect(commandFromWebhook(payload)).toEqual({ envelope: null, invalid: null });
  });

  it("marks an untouched comment as not edited", () => {
    expect(parseWebhookEvent(fixture("webhook-comment-created"))).toMatchObject({ edited: false });
  });

  it("does not approve when the /approve line carries extra text (K-1)", () => {
    const payload = fixture("webhook-comment-created") as { comment: { body: string } };
    payload.comment.body = "/approve etmiyorum, reddediyorum";
    const result = commandFromWebhook(payload);

    expect(result.envelope).toBeNull();
    expect(result.invalid).toMatchObject({ command: "approve", messageKey: "command.takes_no_argument" });
  });
});
