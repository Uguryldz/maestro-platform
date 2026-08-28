import { TicketKey, type CommandEnvelope, type TicketSnapshot } from "@maestro/contracts";
import { CapabilityNotSupportedError, type WorkPort } from "@maestro/ports";
import { adfToWikiMarkup, toAdfDocument } from "./adf.js";
import { JiraDcClient, type FetchLike, type TokenProvider } from "./client.js";
import type { JiraDcConfig } from "./config.js";
import {
  JiraArgumentError,
  JiraLinkFailedError,
  JiraMembershipUnresolvedError,
  JiraResponseError,
} from "./errors.js";
import { ISSUE_FIELDS, mapIssueToSnapshot } from "./mapping.js";
import {
  commandFromWebhook,
  JIRA_SIGNATURE_HEADER,
  verifyWebhookSignature,
  type RawBody,
  type WebhookCommand,
} from "./webhook.js";

export interface JiraDcWorkPortOptions {
  config: JiraDcConfig;
  /** Resolves the PAT (usually `() => secrets.get(config.tokenRef)`). */
  token: TokenProvider;
  /** Resolves the webhook shared secret. */
  webhookSecret: () => string | Promise<string>;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const API = "/rest/api/2";
const MAX_GROUP_PAGES = 40;

/**
 * WorkPort driver for Jira Data Center (M46). Stays inside the permission set
 * agreed in M102 — Browse, Add Comment, Edit Issue (labels), Assign,
 * Create/Link Issue — and deliberately owns no workflow transition.
 */
export class JiraDcWorkPort implements WorkPort {
  readonly driver = "jira-dc";
  private readonly client: JiraDcClient;
  private readonly config: JiraDcConfig;
  private readonly webhookSecret: () => string | Promise<string>;

  constructor(options: JiraDcWorkPortOptions) {
    this.config = options.config;
    this.webhookSecret = options.webhookSecret;
    this.client = new JiraDcClient({
      baseUrl: options.config.baseUrl,
      token: options.token,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.config.requestTimeoutMs,
      sleep: options.sleep,
    });
  }

  async getTicket(key: TicketKey): Promise<TicketSnapshot> {
    const issueKey = requireTicketKey(key, "key");
    const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}`, {
      fields: ISSUE_FIELDS,
    });
    return mapIssueToSnapshot(raw);
  }

  /**
   * `body` is an ADF document or a plain string. DC's REST v2 comment API
   * speaks wiki markup, so the document is rendered on the way out (M46).
   */
  async addComment(key: TicketKey, body: unknown): Promise<{ commentId: string }> {
    const issueKey = requireTicketKey(key, "key");
    const rendered = adfToWikiMarkup(toAdfDocument(body));
    const created = await this.client.post<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}/comment`, {
      body: rendered,
    });
    return { commentId: requireId(created, "comment") };
  }

  /**
   * Edit an existing comment in place — the "▶ Maestro durum" progress comment
   * is updated instead of spamming new ones (M75).
   */
  async updateComment(key: TicketKey, commentId: string, body: unknown): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    if (commentId.trim().length === 0) throw new JiraArgumentError("commentId", "empty");
    const rendered = adfToWikiMarkup(toAdfDocument(body));
    const updated = await this.client.put<unknown>(
      `${API}/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      { body: rendered },
    );
    requireId(updated, "comment");
  }

  /** Full replacement of the label set — the only issue edit the driver performs (M102). */
  async setLabels(key: TicketKey, labels: string[]): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    const clean = labels.map((label) => label.trim());
    for (const label of clean) {
      if (label.length === 0) throw new JiraArgumentError("labels", "empty label");
      if (/\s/.test(label)) throw new JiraArgumentError("labels", `Jira labels cannot contain whitespace: "${label}"`);
    }
    await this.client.put<void>(`${API}/issue/${encodeURIComponent(issueKey)}`, { fields: { labels: clean } });
  }

  /**
   * On DC the assignee is addressed by username (`name`); `null` unassigns.
   * The port calls the argument `accountId` for Cloud parity.
   */
  async assign(key: TicketKey, accountId: string | null): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    const name = accountId === null ? null : accountId.trim();
    if (name !== null && name.length === 0) throw new JiraArgumentError("accountId", "empty");
    await this.client.put<void>(`${API}/issue/${encodeURIComponent(issueKey)}/assignee`, { name });
  }

  /** Fan-out child (M100): create, then link it back to the parent. */
  async createLinkedIssue(
    parent: TicketKey,
    fields: { summary: string; description: string; labels?: string[] },
  ): Promise<{ key: TicketKey }> {
    const parentKey = requireTicketKey(parent, "parent");
    const projectKey = parentKey.split("-")[0];
    if (!projectKey) throw new JiraArgumentError("parent", "cannot derive project key");
    if (fields.summary.trim().length === 0) throw new JiraArgumentError("summary", "empty");

    const created = await this.client.post<unknown>(`${API}/issue`, {
      fields: {
        project: { key: projectKey },
        summary: fields.summary,
        description: fields.description,
        issuetype: { name: this.config.childIssueTypeName },
        ...(fields.labels && fields.labels.length > 0 ? { labels: fields.labels } : {}),
      },
    });

    const childKey = requireKey(created, "created issue");
    try {
      await this.client.post<void>(`${API}/issueLink`, {
        type: { name: this.config.linkTypeName },
        inwardIssue: { key: childKey },
        outwardIssue: { key: parentKey },
      });
    } catch (error) {
      throw new JiraLinkFailedError(childKey, parentKey, error);
    }
    return { key: childKey };
  }

  /**
   * Group membership backing gate authorisation (M32/M51). This is the ONLY
   * evidence a gate decision rests on, so it matches solely on identifiers a
   * Jira admin controls, skips inactive members locally, and never guesses:
   * an undecidable page raises instead of quietly denying.
   */
  async verifyMembership(userId: string, group: string): Promise<boolean> {
    // The decision carries an AUDIT actor (`712020.abc@banka.local`), while
    // the directory knows a Jira identifier. The local part is what the two
    // have in common; the raw string is kept too, because a Data Center login
    // may legitimately contain an `@`.
    const raw = userId.trim().toLowerCase();
    const needles = [raw, raw.includes("@") ? raw.slice(0, raw.lastIndexOf("@")) : raw];
    if (raw.length === 0) throw new JiraArgumentError("userId", "empty");
    if (group.trim().length === 0) throw new JiraArgumentError("group", "empty");

    let startAt = 0;
    for (let page = 0; page < MAX_GROUP_PAGES; page += 1) {
      const res = await this.client.get<unknown>(`${API}/group/member`, {
        groupname: group,
        includeInactiveUsers: false,
        startAt,
        maxResults: this.config.groupPageSize,
      });
      const body = asRecord(res);
      const values = Array.isArray(body?.["values"]) ? body["values"] : [];
      for (const member of values) {
        if (isActiveMember(member)) {
          const ids = identifiersOf(member);
          if (needles.some((needle) => ids.includes(needle))) return true;
        }
      }
      if (values.length === 0) return false;
      startAt += values.length;
      if (!hasMorePages(body, startAt, group)) return false;
    }
    throw new JiraMembershipUnresolvedError(
      group,
      "too_many_pages",
      `stopped after ${MAX_GROUP_PAGES} pages of ${this.config.groupPageSize}`,
    );
  }

  /** Verified webhook payload → command, or null. Never throws on unknown commands. */
  async parseCommand(rawBody: unknown): Promise<CommandEnvelope | null> {
    return this.parseCommandDetailed(rawBody).envelope;
  }

  /** Same parse, keeping the "looks like a command but is malformed" result. */
  parseCommandDetailed(rawBody: unknown): WebhookCommand {
    return commandFromWebhook(rawBody);
  }

  /**
   * Verify a delivery before anything else touches it. Throws
   * JiraWebhookVerificationError on any failure — fail-closed, no boolean.
   */
  async verifyWebhook(rawBody: RawBody, headers: Record<string, string>): Promise<void> {
    const header = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === JIRA_SIGNATURE_HEADER,
    )?.[1];
    verifyWebhookSignature(rawBody, header, await this.webhookSecret());
  }

  /** Not supported on DC (M102): no workflow permission is requested. */
  async transition(_key: TicketKey, _transitionId: string): Promise<void> {
    throw new CapabilityNotSupportedError("WorkPort", "transition");
  }
}

function requireTicketKey(value: string, argument: string): TicketKey {
  const parsed = TicketKey.safeParse(value);
  if (!parsed.success) throw new JiraArgumentError(argument, `"${value}" is not a Jira issue key`);
  return parsed.data;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireId(value: unknown, context: string): string {
  const id = asRecord(value)?.["id"];
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number") return String(id);
  throw new JiraResponseError(context, ["response carries no id"]);
}

function requireKey(value: unknown, context: string): TicketKey {
  const key = asRecord(value)?.["key"];
  const parsed = typeof key === "string" ? TicketKey.safeParse(key) : null;
  if (!parsed?.success) throw new JiraResponseError(context, ["response carries no usable issue key"]);
  return parsed.data;
}

/**
 * Identifiers a DC user may be matched by, lowercased. `displayName` is NOT
 * one of them: it comes from LDAP, is not unique, and changes — two people
 * called "Mert Demir" would share gate authority. Only the admin-controlled
 * username, the rename-proof user key, and the e-mail address count.
 */
/**
 * Every identifier a member can be recognised by.
 *
 * `name` and `key` are Data Center's; Cloud sends neither, and hides
 * `emailAddress` unless the caller has user-management scope — so on a Cloud
 * site every one of them is null and the only identifier present is
 * `accountId`. Without it, `verifyMembership` answered false for a person who
 * IS in the group, and a real approval was refused as "üyelik doğrulanamadı"
 * (OPS-36).
 *
 * The account id is also offered in the shape the audit trail forces it into:
 * `HUMAN_ACTOR` allows no colon, so the BFF writes `712020:abc` as
 * `712020.abc@<domain>` (`apps/bff/src/actor.ts`) and it is THAT string which
 * comes back on the decision. Both spellings are matched here rather than
 * unpicked at the call site, because this is the one place that knows what a
 * Jira identifier looks like.
 */
function identifiersOf(member: unknown): string[] {
  const user = asRecord(member);
  if (!user) return [];
  const accountId = typeof user["accountId"] === "string" ? user["accountId"] : undefined;
  const ids = [
    user["name"],
    user["key"],
    user["emailAddress"],
    accountId,
    // The colon-free spelling the audit contract requires. The local part
    // only — the domain is the deployment's, not Jira's, so matching on it
    // would tie this driver to whatever `MAESTRO_ACTOR_DOMAIN` happens to say.
    accountId?.replace(/:/gu, "."),
  ];
  return ids
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim().toLowerCase());
}

/**
 * `includeInactiveUsers=false` asks the server to leave off-boarded accounts
 * out, but the driver must not depend on the server honouring it — an approver
 * who left the bank never passes a gate (M32 fail-closed).
 */
function isActiveMember(member: unknown): boolean {
  return asRecord(member)?.["active"] !== false;
}

/**
 * Decide whether another page must be fetched. A page bean that carries
 * neither `isLast` nor a numeric `total` cannot be reasoned about, and
 * stopping there would deny a real member without a trace.
 */
function hasMorePages(body: Record<string, unknown> | null, startAt: number, group: string): boolean {
  const isLast = body?.["isLast"];
  if (typeof isLast === "boolean") return !isLast;
  const total = body?.["total"];
  if (typeof total === "number") return startAt < total;
  throw new JiraMembershipUnresolvedError(
    group,
    "incomplete_page_bean",
    "the member page carries neither a boolean isLast nor a numeric total",
  );
}
