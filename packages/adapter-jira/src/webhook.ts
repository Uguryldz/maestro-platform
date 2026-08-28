import { createHmac, timingSafeEqual } from "node:crypto";
import { CommandEnvelope, TicketKey } from "@maestro/contracts";
import { parseCommandBody, type CommandParseResult } from "./commands.js";
import { normalizeJiraDateTime } from "./datetime.js";
import { JiraResponseError, JiraWebhookVerificationError } from "./errors.js";
import { userIdOf } from "./mapping.js";

/**
 * Jira DC signs webhook deliveries with HMAC-SHA256 over the RAW request body
 * and sends the digest in `X-Hub-Signature: sha256=<hex>`. Verification MUST
 * run before the body is parsed — re-serialising JSON changes the bytes and
 * would break the signature.
 */
export const JIRA_SIGNATURE_HEADER = "x-hub-signature";

export type RawBody = string | Uint8Array;

/**
 * Fail-closed signature check: every failure path throws, none returns a
 * boolean that a caller could accidentally treat as truthy.
 */
export function verifyWebhookSignature(rawBody: RawBody, signatureHeader: string | null | undefined, secret: string): void {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new JiraWebhookVerificationError("missing_secret");
  }
  if (typeof signatureHeader !== "string" || signatureHeader.trim().length === 0) {
    throw new JiraWebhookVerificationError("missing_signature");
  }

  const provided = signatureHeader.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    throw new JiraWebhookVerificationError("malformed_signature");
  }

  const expected = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody))
    .digest("hex");

  // Both buffers are 64 hex chars by construction, so the length check above
  // is what keeps timingSafeEqual from throwing.
  if (!timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"))) {
    throw new JiraWebhookVerificationError("mismatch");
  }
}

/** Convenience for tests and for signing fixtures. */
export function signWebhookBody(rawBody: RawBody, secret: string): string {
  const digest = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody))
    .digest("hex");
  return `sha256=${digest}`;
}

export type JiraWebhookEvent =
  | {
      kind: "comment";
      event: string;
      ticketKey: TicketKey;
      /** `comment.author` — the person who WROTE the comment, never the editor. */
      author: string;
      at: string;
      body: string;
      commentId: string | null;
      /** True when the payload is an edit, or when created/updated disagree. */
      edited: boolean;
      issue: unknown;
    }
  | { kind: "issue"; event: string; ticketKey: TicketKey; issue: unknown }
  | { kind: "other"; event: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Classify a verified webhook payload. Unrecognised events are `other` — the
 * single global webhook (M102) delivers everything, and filtering happens
 * downstream against the JiraProjectBinding list.
 */
export function parseWebhookEvent(payload: unknown): JiraWebhookEvent {
  const envelope = record(payload);
  if (!envelope) throw new JiraResponseError("webhook payload", ["payload is not an object"]);
  const event = typeof envelope["webhookEvent"] === "string" ? envelope["webhookEvent"] : "";
  const issue = record(envelope["issue"]);
  const issueKey = typeof issue?.["key"] === "string" ? TicketKey.safeParse(issue["key"]) : null;

  const comment = record(envelope["comment"]);
  if (comment && (event === "comment_created" || event === "comment_updated")) {
    if (!issueKey?.success) throw new JiraResponseError("webhook comment event", ["missing or malformed issue key"]);
    const author = userIdOf(comment["author"]);
    if (!author) throw new JiraResponseError("webhook comment event", ["comment has no identifiable author"]);
    return {
      kind: "comment",
      event,
      ticketKey: issueKey.data,
      author,
      at: normalizeJiraDateTime(comment["created"] ?? envelope["timestamp"], "comment.created"),
      body: typeof comment["body"] === "string" ? comment["body"] : "",
      commentId: typeof comment["id"] === "string" ? comment["id"] : null,
      edited: isEdited(event, comment),
      issue: envelope["issue"],
    };
  }

  if (issueKey?.success && event.startsWith("jira:issue_")) {
    return { kind: "issue", event, ticketKey: issueKey.data, issue: envelope["issue"] };
  }

  return { kind: "other", event };
}

/**
 * `comment_updated` is an edit by definition; a `comment_created` delivery
 * whose `created` and `updated` timestamps disagree has been edited too.
 */
function isEdited(event: string, comment: Record<string, unknown>): boolean {
  if (event === "comment_updated") return true;
  const created = comment["created"];
  const updated = comment["updated"];
  return typeof created === "string" && typeof updated === "string" && created !== updated;
}

export interface WebhookCommand {
  envelope: CommandEnvelope | null;
  /** Present when the comment looked like a command but could not be honoured. */
  invalid: Extract<CommandParseResult, { status: "invalid" }> | null;
}

/**
 * Extract a command from a verified webhook payload. Returns `{ envelope: null }`
 * for anything that is not a command — never throws on unknown commands.
 *
 * ONLY a freshly created, never-edited comment can carry a command. In Jira DC
 * "Edit All Comments" is a routine project-lead permission, so an edit event
 * names the original `author` while a different `updateAuthor` supplied the
 * text: honouring it would let anyone with that permission approve a gate as
 * someone else and walk straight past the SoD matrix (M32/M51).
 */
export function commandFromWebhook(payload: unknown): WebhookCommand {
  const event = parseWebhookEvent(payload);
  if (event.kind !== "comment") return { envelope: null, invalid: null };
  if (event.event !== "comment_created" || event.edited) return { envelope: null, invalid: null };

  const parsed = parseCommandBody(event.body);
  if (parsed.status === "none") return { envelope: null, invalid: null };
  if (parsed.status === "invalid") return { envelope: null, invalid: parsed };

  return {
    envelope: CommandEnvelope.parse({
      ticketKey: event.ticketKey,
      author: event.author,
      at: event.at,
      command: parsed.command,
    }),
    invalid: null,
  };
}
