import { CommandEnvelope, TicketKey } from "@maestro/contracts";
import { adfToCommandLines, isAdfDoc } from "../adf.js";
import { parseCommandBody, type CommandParseResult } from "../commands.js";
import { normalizeJiraDateTime } from "../datetime.js";
import { JiraArgumentError, JiraResponseError } from "../errors.js";
import { cloudUserIdOf } from "./mapping.js";

/**
 * Commands from POLLED Cloud comments. The pilot has no Cloud webhook: it
 * lists comments (GET /rest/api/3/issue/{key}/comment — see
 * fixtures/cloud/comments-list.json) and feeds each comment resource here.
 * The comment resource does not carry the issue key (only an issue-id URL),
 * so the caller — who polled a specific issue — supplies it.
 */

export interface CloudCommentCommand {
  envelope: CommandEnvelope | null;
  /** Present when the comment looked like a command but could not be honoured. */
  invalid: Extract<CommandParseResult, { status: "invalid" }> | null;
}

const NO_COMMAND: CloudCommentCommand = { envelope: null, invalid: null };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse one Cloud comment resource into a command, or none. Never throws on
 * unknown commands — only on a payload too malformed to reason about.
 *
 * ONLY a never-edited comment can carry a command, same rule as the DC
 * webhook driver: an edit keeps the original `author` while a different
 * `updateAuthor` supplied the text, so honouring it would let a comment
 * editor approve a gate as someone else (M32/M51). Polling has no
 * created/updated EVENT distinction — the timestamps are the evidence.
 */
export function parseCommandFromComment(ticketKey: string, comment: unknown): CloudCommentCommand {
  const key = TicketKey.safeParse(ticketKey);
  if (!key.success) throw new JiraArgumentError("ticketKey", `"${ticketKey}" is not a Jira issue key`);
  const resource = record(comment);
  if (!resource) throw new JiraResponseError("cloud comment", ["payload is not an object"]);

  const parsed = parseCloudCommentBody(resource["body"]);
  if (parsed.status === "none") return NO_COMMAND;

  const created = resource["created"];
  const updated = resource["updated"];
  if (typeof created !== "string") throw new JiraResponseError("cloud comment", ["comment has no created timestamp"]);
  // Symmetric with the created guard, fail-closed: without an updated
  // timestamp the comment cannot PROVE it was never edited, and an edited
  // comment must never carry a command (the DC K-2 rule). A poller that
  // strips fields gets a loud error, not a silently honoured approval.
  if (typeof updated !== "string") {
    throw new JiraResponseError("cloud comment", ["comment has no updated timestamp — cannot prove it is unedited"]);
  }
  if (updated !== created) return NO_COMMAND;

  if (parsed.status === "invalid") return { envelope: null, invalid: parsed };

  const author = cloudUserIdOf(resource["author"]);
  if (!author) throw new JiraResponseError("cloud comment", ["comment has no identifiable author"]);

  return {
    envelope: CommandEnvelope.parse({
      ticketKey: key.data,
      author,
      at: normalizeJiraDateTime(created, "comment.created"),
      command: parsed.command,
    }),
    invalid: null,
  };
}

/**
 * M105 over ADF: the command grammar runs only when the FIRST visible line is
 * plain, unstyled TOP-LEVEL paragraph text. A blockquote reply, a codeBlock
 * sample or a code/link-styled "/approve" quotes a command instead of giving
 * one — none of them may open a gate (the ADF face of the DC K-1 finding).
 * Non-paragraph content still counts as visible lines, so a plain "/approve"
 * followed by a quote or a code block stays a takes-no-argument rejection.
 */
function parseCloudCommentBody(body: unknown): CommandParseResult {
  // A plain string body (legacy/defensive) has no styling to hide behind.
  if (typeof body === "string") return parseCommandBody(body);
  if (!isAdfDoc(body)) return { status: "none" };

  const lines = adfToCommandLines(body);
  const first = lines.find((line) => line.text.trim().length > 0);
  if (first === undefined || !first.commandCapable) return { status: "none" };
  return parseCommandBody(lines.map((line) => line.text).join("\n"));
}

/**
 * WorkPort.parseCommand adapter: accepts either the poller's own envelope
 * (`{ ticketKey, comment }`) or a webhook-style one (`{ issue: { key },
 * comment }`), and delegates. A payload without a comment carries no command.
 */
export function commandFromCloudPayload(rawBody: unknown): CloudCommentCommand {
  const envelope = record(rawBody);
  if (!envelope) throw new JiraResponseError("cloud command payload", ["payload is not an object"]);
  const comment = record(envelope["comment"]);
  if (!comment) return NO_COMMAND;

  const key = typeof envelope["ticketKey"] === "string" ? envelope["ticketKey"] : record(envelope["issue"])?.["key"];
  if (typeof key !== "string") {
    throw new JiraResponseError("cloud command payload", ["no ticket key (neither ticketKey nor issue.key)"]);
  }
  return parseCommandFromComment(key, comment);
}
