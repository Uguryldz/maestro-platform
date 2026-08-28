import { mapCloudIssueToSnapshot, type JiraCloudWorkPort } from "@maestro/adapter-jira";
import type { CommandEnvelope, TicketKey } from "@maestro/contracts";
import { DISCOVERY_FIELDS, DISCOVERY_JQL, DISCOVERY_MAX } from "./config.js";

/**
 * The pilot's stand-in for the two things the demo got from webhooks. Atlassian
 * Cloud cannot reach localhost, so nothing is delivered TO us — we POLL:
 *
 *   discoverTickets()  — the newest OPS tickets ASSIGNED to the Maestro Bot
 *                        and not yet Done (assignment is the opt-in).
 *   pollForCommand()   — a gate's comments, until a valid /approve or /reject.
 *
 * Both take the live WorkPort (or, in tests, one wired to a stub fetch), so the
 * poll logic is exercised entirely offline against recorded comment fixtures.
 */

export interface DiscoveredTicket {
  key: string;
  summary: string;
  status: string | null;
  /**
   * Issue type NAME (e.g. "Task"). Requested from Jira all along but never
   * mapped — without it the auto-start guard could not evaluate issuetype
   * listening rules and silently never started anything.
   */
  issueType: string | null;
  createdAt: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function statusOf(raw: unknown): string | null {
  const status = record(record(raw)?.["fields"])?.["status"];
  const name = record(status)?.["name"];
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

/**
 * One discovery pass. Honors the bounded-JQL guard (the query names a project),
 * returns lightweight rows for the picker. Newest first, as the JQL orders. The
 * raw issue is mapped through the driver's own mapper so a shape the site would
 * reject never reaches the UI as a half-ticket.
 *
 * `jql` is injected by boot with the resolved, accountId-bearing assignment
 * query. It defaults to `DISCOVERY_JQL` (bounded, `assignee = currentUser()`)
 * so offline callers that don't wire an accountId still issue a valid query.
 */
export async function discoverTickets(
  work: JiraCloudWorkPort,
  jql: string = DISCOVERY_JQL,
): Promise<DiscoveredTicket[]> {
  const page = await work.searchIssues({
    jql,
    maxResults: DISCOVERY_MAX,
    fields: [...DISCOVERY_FIELDS],
  });

  const rows: DiscoveredTicket[] = [];
  for (const raw of page.issues) {
    const key = record(raw)?.["key"];
    if (typeof key !== "string") continue;
    const fields = record(record(raw)?.["fields"]);
    const summary = typeof fields?.["summary"] === "string" ? fields["summary"] : key;
    const created = typeof fields?.["created"] === "string" ? fields["created"] : null;
    const issueTypeName = record(fields?.["issuetype"])?.["name"];
    rows.push({
      key,
      summary,
      status: statusOf(raw),
      issueType: typeof issueTypeName === "string" ? issueTypeName : null,
      createdAt: created,
    });
  }
  return rows;
}

/** Read one ticket as a validated snapshot (delegates to the live driver). */
export async function readTicket(work: JiraCloudWorkPort, key: TicketKey): ReturnType<JiraCloudWorkPort["getTicket"]> {
  return work.getTicket(key);
}

export interface CommandPollOptions {
  work: JiraCloudWorkPort;
  ticketKey: string;
  /** Comment ids already acted on — de-dupe across polls (M105). */
  seen: Set<string>;
  /** Only these commands resolve the gate; others are ignored, invalids logged. */
  accept: ReadonlyArray<CommandEnvelope["command"]["name"]>;
  onInvalid?: (messageKey: string, command: string) => void;
  onIgnored?: (envelope: CommandEnvelope) => void;
}

export interface CommandPollResult {
  envelope: CommandEnvelope;
  commentId: string;
}

function commentId(comment: unknown): string | null {
  const id = record(comment)?.["id"];
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number") return String(id);
  return null;
}

/**
 * STALE-APPROVAL GUARD (canlı OPS-15 bulgusu). A gate's `seen` set used to
 * start EMPTY, so an `/approve` comment left over from a PREVIOUS run on the
 * same ticket resolved a brand-new gate instantly — a compliance gate honoured
 * an approval that predates the thing it approves. Seeding `seen` with every
 * comment id that exists at gate-open makes only comments written AFTER the
 * gate count. Fail-closed: if the baseline cannot be read, the caller must not
 * open the gate on an unbaselined set.
 */
export async function markExistingCommentsSeen(
  work: JiraCloudWorkPort,
  ticketKey: string,
  seen: Set<string>,
): Promise<number> {
  const comments = await work.listComments(ticketKey);
  let added = 0;
  for (const comment of comments) {
    const id = commentId(comment);
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      added += 1;
    }
  }
  return added;
}

/**
 * ONE poll of a gate's comments. Lists the issue's comments, runs each unseen
 * one through the driver's `parseCommandFromComment` (which enforces the M105
 * rules — only a never-edited, plain top-level command counts), and returns the
 * FIRST comment carrying an accepted command. Comments are de-duped by id, so a
 * command already acted on in a previous poll is never honoured twice.
 *
 * Returns null when this pass found nothing to act on; the caller waits and
 * calls again. Membership / SoD is checked by the caller, not here — this
 * function only turns comments into commands.
 */
export async function pollForCommandOnce(options: CommandPollOptions): Promise<CommandPollResult | null> {
  const { work, ticketKey, seen, accept } = options;
  const comments = await work.listComments(ticketKey);

  for (const comment of comments) {
    const id = commentId(comment);
    // A comment we cannot identify cannot be de-duped, so it must not be able
    // to re-trigger a gate on the next poll — skip it (fail-closed).
    if (id === null || seen.has(id)) continue;

    const parsed = work.parseCommandFromComment(ticketKey, comment);
    if (parsed.invalid !== null) {
      seen.add(id);
      options.onInvalid?.(parsed.invalid.messageKey, parsed.invalid.command);
      continue;
    }
    const envelope = parsed.envelope;
    if (envelope === null) continue; // not a command comment; leave unseen (it never will be)

    // From here the comment IS a command — mark it seen whether or not we act,
    // so a non-matching command (e.g. /status) is not re-parsed every poll.
    seen.add(id);
    if (!accept.includes(envelope.command.name)) {
      options.onIgnored?.(envelope);
      continue;
    }
    return { envelope, commentId: id };
  }
  return null;
}

/**
 * Poll a gate until a command we accept arrives, honouring an AbortSignal so a
 * finished/failed run stops polling. `sleep` is injected so tests advance
 * without real timers.
 */
export async function pollForCommand(
  options: CommandPollOptions & {
    intervalMs: number;
    signal: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<CommandPollResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    if (options.signal.aborted) throw new PollAbortedError();
    const hit = await pollForCommandOnce(options);
    if (hit !== null) return hit;
    await sleep(options.intervalMs);
  }
}

export class PollAbortedError extends Error {
  constructor() {
    super("komut yoklaması iptal edildi");
    this.name = "PollAbortedError";
  }
}

export { mapCloudIssueToSnapshot };
