import { TicketKey, type CommandEnvelope, type TicketSnapshot } from "@maestro/contracts";
import { type WorkPort } from "@maestro/ports";
import { toAdfDocument } from "../adf.js";
import type { FetchLike, TokenProvider } from "../client.js";
import {
  JiraArgumentError,
  JiraForbiddenError,
  JiraLinkFailedError,
  JiraMembershipUnresolvedError,
  JiraResponseError,
  JiraWebhookVerificationError,
} from "../errors.js";
import { ISSUE_FIELDS } from "../mapping.js";
import { JIRA_SIGNATURE_HEADER, verifyWebhookSignature } from "../webhook.js";
import { normalizeAttachments, type JiraAttachment } from "./attachments.js";
import { JiraCloudClient } from "./client.js";
import { commandFromCloudPayload, parseCommandFromComment, type CloudCommentCommand } from "./comment-command.js";
import type { JiraCloudConfig } from "./config.js";
import { cloudUserIdOf, mapCloudIssueToSnapshot } from "./mapping.js";
import { searchIssues, type CloudSearchPage, type CloudSearchRequest } from "./search.js";
import { JiraCloudWorkflowReader, type JiraWorkflowGraph, type JiraWorkflowReadOptions } from "./workflow.js";
import {
  DEFAULT_REVIEW_STATUS_NAME,
  foldStatusName,
  parseAvailableTransitions,
  requireTransitionId,
  selectReturnTransition,
  selectReviewTransition,
  selectTransitionByStatusName,
  type AvailableTransition,
} from "./return-flow.js";

export interface JiraCloudWorkPortOptions {
  config: JiraCloudConfig;
  /** Resolves the API token (usually `() => secrets.get(config.apiTokenRef)`). */
  token: TokenProvider;
  /**
   * Resolves the webhook signing secret. Absent when the deployment registered
   * no webhook — `verifyWebhook` then REFUSES rather than passes.
   */
  webhookSecret?: () => string | Promise<string>;
  fetchImpl?: FetchLike;
}

const API = "/rest/api/3";
const MAX_GROUP_PAGES = 40;

/**
 * WorkPort driver for Jira Cloud. Same M102 permission stance as the DC
 * driver — Browse, Add Comment, Edit Issue (labels), Assign, Create/Link
 * Issue — with the Cloud-specific differences: REST v3, Basic auth
 * (email + API token), ADF bodies posted verbatim and `accountId` identities.
 *
 * Deliveries arrive either way: a registered webhook (verified here, see
 * `verifyWebhook`) or the pilot's comment poll (comment-command.ts). Polling
 * remains the fallback for a site that cannot reach the platform from the
 * internet; it is not a reason to leave the signed path unimplemented.
 */
export class JiraCloudWorkPort implements WorkPort {
  readonly driver = "jira-cloud";
  private readonly client: JiraCloudClient;
  private readonly config: JiraCloudConfig;
  private readonly webhookSecret: (() => string | Promise<string>) | null;

  constructor(options: JiraCloudWorkPortOptions) {
    this.config = options.config;
    this.webhookSecret = options.webhookSecret ?? null;
    this.client = new JiraCloudClient({
      baseUrl: options.config.baseUrl,
      email: options.config.email,
      token: options.token,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.config.requestTimeoutMs,
    });
  }

  async getTicket(key: TicketKey): Promise<TicketSnapshot> {
    const issueKey = requireTicketKey(key, "key");
    const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}`, {
      fields: ISSUE_FIELDS,
    });
    return mapCloudIssueToSnapshot(raw);
  }

  /**
   * The ticket's ATTACHMENTS — filename, mime type, size and a download URL —
   * read live from the issue. A concrete capability (not on the frozen
   * `WorkPort`, same posture as `readProjectWorkflow`/`addAttachment`): the
   * analyst wants to know a screenshot or a spec PDF is attached, since a bank
   * ticket often says "this screen shows this error (screenshot)". A missing or
   * malformed `attachment` field yields [] rather than throwing — an issue with
   * no attachments is normal, not an error.
   */
  async readAttachments(key: TicketKey): Promise<JiraAttachment[]> {
    const issueKey = requireTicketKey(key, "key");
    const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}`, {
      fields: "attachment",
    });
    return normalizeAttachments(raw);
  }

  /**
   * Download an attachment's raw text via its `content` URL (authenticated, same
   * host). Used only for text attachments the analyst reads inline; the caller
   * decides which. Returns the body as a string — the caller caps size before
   * asking. Not on the frozen port (concrete capability, like readAttachments).
   */
  async downloadAttachment(contentUrl: string): Promise<string> {
    return this.client.getText(contentUrl);
  }

  /**
   * Create a CHILD issue under a parent — the fan-out capability (M100): when an
   * analysis finds a work item spans several applications, one sub-ticket is
   * opened per impacted app so each has its own tracked flow. Concrete capability
   * (not on the frozen WorkPort). `POST /rest/api/3/issue` with `parent` linking
   * it to the analysed ticket. Returns the created key. The issue type defaults
   * to "Alt görev"/"Sub-task"; the caller may override for a site that renames it.
   */
  async createChildIssue(args: {
    projectKey: string;
    parentKey: string;
    summary: string;
    description?: string;
    issueType?: string;
    /**
     * Cloud accountId the child opens ASSIGNED to (fan-out ownership — the
     * Maestro Bot, so each child lands straight in the bot's queue). Absent =
     * unassigned, the old behaviour.
     */
    assigneeAccountId?: string;
  }): Promise<{ key: string }> {
    const created = await this.client.post<{ key?: string }>(`${API}/issue`, {
      fields: {
        project: { key: args.projectKey },
        parent: { key: args.parentKey },
        summary: args.summary.slice(0, 250),
        issuetype: { name: args.issueType ?? "Alt görev" },
        ...(args.description !== undefined
          ? { description: toAdfDocument(args.description) }
          : {}),
        // Cloud's create-issue API addresses the assignee as `{ id }` (v3).
        ...(args.assigneeAccountId !== undefined && args.assigneeAccountId.trim().length > 0
          ? { assignee: { id: args.assigneeAccountId.trim() } }
          : {}),
      },
    });
    const key = typeof created?.key === "string" ? created.key : null;
    if (key === null) throw new JiraResponseError("create child issue", ["response carried no issue key"]);
    return { key };
  }

  /**
   * `body` is an ADF document or a plain string. Cloud's REST v3 comment API
   * speaks ADF natively, so the document goes out verbatim — no wiki-markup
   * rendering (recorded 201: fixtures/cloud/comment-created-response.json).
   */
  async addComment(key: TicketKey, body: unknown): Promise<{ commentId: string }> {
    const issueKey = requireTicketKey(key, "key");
    const created = await this.client.post<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}/comment`, {
      body: toAdfDocument(body),
    });
    return { commentId: requireId(created, "comment") };
  }

  /** Edit the single live status comment in place instead of spamming (M75). */
  async updateComment(key: TicketKey, commentId: string, body: unknown): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    if (commentId.trim().length === 0) throw new JiraArgumentError("commentId", "empty");
    const updated = await this.client.put<unknown>(
      `${API}/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      { body: toAdfDocument(body) },
    );
    requireId(updated, "comment");
  }

  /**
   * Diff-based label edit: read the current labels, then send only the
   * add/remove delta (recorded 204: PUT with `{update:{labels:[{add:…}]}}`).
   * Unlike the DC driver's full replacement, the delta cannot wipe labels a
   * human added between our read and write of an unrelated label.
   */
  async setLabels(key: TicketKey, labels: string[]): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    const desired = requireCleanLabels(labels);

    const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}`, { fields: "labels" });
    const current = currentLabelsOf(raw);
    const wanted = new Set(desired);
    const have = new Set(current);
    const operations = [
      ...desired.filter((label) => !have.has(label)).map((label) => ({ add: label })),
      ...current.filter((label) => !wanted.has(label)).map((label) => ({ remove: label })),
    ];
    if (operations.length === 0) return;

    await this.client.put<void>(`${API}/issue/${encodeURIComponent(issueKey)}`, {
      update: { labels: operations },
    });
  }

  /** Cloud addresses the assignee by `accountId`; `null` unassigns. */
  async assign(key: TicketKey, accountId: string | null): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    const id = accountId === null ? null : accountId.trim();
    if (id !== null && id.length === 0) throw new JiraArgumentError("accountId", "empty");
    await this.client.put<void>(`${API}/issue/${encodeURIComponent(issueKey)}/assignee`, { accountId: id });
  }

  /**
   * Fan-out child (M100): create, then link back via POST /issueLink — NOT
   * the `parent` field. On a team-managed project `parent` demands the next
   * hierarchy level (an Epic), so a task could never fan out under a task;
   * an issue link of the configured type works at any level, exactly as on DC.
   */
  async createLinkedIssue(
    parent: TicketKey,
    fields: { summary: string; description: string; labels?: string[] },
  ): Promise<{ key: TicketKey }> {
    const parentKey = requireTicketKey(parent, "parent");
    const projectKey = parentKey.split("-")[0];
    if (!projectKey) throw new JiraArgumentError("parent", "cannot derive project key");
    if (fields.summary.trim().length === 0) throw new JiraArgumentError("summary", "empty");
    // Same pre-flight as setLabels — a label Jira would reject must not fail
    // the whole create halfway through the fan-out.
    const labels = fields.labels === undefined ? [] : requireCleanLabels(fields.labels);

    const created = await this.client.post<unknown>(`${API}/issue`, {
      fields: {
        project: { key: projectKey },
        summary: fields.summary,
        // v3 wants ADF here too; plain text is wrapped into paragraphs.
        description: toAdfDocument(fields.description),
        issuetype: { name: this.config.childIssueTypeName },
        ...(labels.length > 0 ? { labels } : {}),
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
   * Group membership backing gate authorisation (M32/M51) — same fail-closed
   * loop as the DC driver over the standard Cloud page bean, but matching
   * only on `accountId` and (when the site exposes it) the e-mail address.
   * No live fixture was recorded for this endpoint; see RAPOR.md.
   */
  async verifyMembership(userId: string, group: string): Promise<boolean> {
    const raw = userId.trim().toLowerCase();
    if (raw.length === 0) throw new JiraArgumentError("userId", "empty");
    /**
     * The decision carries an AUDIT actor, not a Jira identifier.
     *
     * `HUMAN_ACTOR` (packages/audit) allows no colon, so the BFF rewrites the
     * account id `712020:b836c135-…` as `712020.b836c135-…@<domain>` before it
     * can be recorded (`apps/bff/src/actor.ts`). That rewritten string is what
     * comes back on the gate decision — and matched against a raw `accountId`
     * it never equals, so a real approval by a member of the group was refused
     * as "üyelik doğrulanamadı" (OPS-36).
     *
     * Both spellings are tried, and the account id is compared with its colons
     * normalised the same way. The domain is dropped rather than compared: it
     * is the deployment's, not Jira's.
     */
    const local = raw.includes("@") ? raw.slice(0, raw.lastIndexOf("@")) : raw;
    const needles = new Set([raw, local]);
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
        if (asRecord(member)?.["active"] === false) continue; // off-boarded — never passes a gate
        const id = cloudUserIdOf(member);
        const email = asRecord(member)?.["emailAddress"];
        const candidates = [id, id?.replace(/:/gu, "."), typeof email === "string" ? email : null]
          .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
          .map((c) => c.trim().toLowerCase());
        if (candidates.some((candidate) => needles.has(candidate))) return true;
      }
      // Decide continuation from the page bean FIRST: an empty page that
      // still claims more members is contradictory, and short-circuiting it
      // to `false` would be a silent deny (the O-6 rule).
      startAt += values.length;
      if (!hasMorePages(body, startAt, group)) return false;
      if (values.length === 0) {
        throw new JiraMembershipUnresolvedError(
          group,
          "contradictory_page",
          "the page claims more members but carries none — refusing a silent deny",
        );
      }
    }
    throw new JiraMembershipUnresolvedError(
      group,
      "too_many_pages",
      `stopped after ${MAX_GROUP_PAGES} pages of ${this.config.groupPageSize}`,
    );
  }

  /**
   * Bounded search on /rest/api/3/search/jql (the old /search is removed —
   * CHANGE-2046). Refuses unbounded JQL before it leaves the process.
   */
  searchIssues(request: CloudSearchRequest): Promise<CloudSearchPage> {
    return searchIssues(this.client, request);
  }

  /**
   * One page of an issue's comments, raw as recorded
   * (fixtures/cloud/comments-list.json) — the poll source that feeds
   * parseCommandFromComment, since the pilot receives no Cloud webhooks.
   */
  async listComments(key: TicketKey): Promise<unknown[]> {
    const issueKey = requireTicketKey(key, "key");
    const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}/comment`, {});
    const comments = asRecord(raw)?.["comments"];
    if (!Array.isArray(comments)) throw new JiraResponseError("comments", ["response carries no comments array"]);
    return comments;
  }

  /**
   * The ticket's ASSIGNEE changes, oldest→newest, from the issue changelog
   * (iş atama usulü onayı için). Each entry: WHO made the change (`actor`),
   * WHO the ticket was assigned TO (`toAccountId` — null when unassigned) and
   * the changelog entry's own id/time, so a gate can baseline exactly like it
   * baselines comments (only entries newer than gate-open count).
   */
  async listAssigneeChanges(
    key: TicketKey,
  ): Promise<Array<{ id: string; actorAccountId: string; toAccountId: string | null; at: string }>> {
    const issueKey = requireTicketKey(key, "key");
    const raw = await this.client.get<unknown>(
      `${API}/issue/${encodeURIComponent(issueKey)}/changelog`,
      {},
    );
    const values = asRecord(raw)?.["values"];
    if (!Array.isArray(values)) throw new JiraResponseError("changelog", ["response carries no values array"]);

    const out: Array<{ id: string; actorAccountId: string; toAccountId: string | null; at: string }> = [];
    for (const entry of values) {
      const rec = asRecord(entry);
      const id = rec?.["id"];
      const created = rec?.["created"];
      const actor = asRecord(rec?.["author"])?.["accountId"];
      const items = rec?.["items"];
      if (typeof id !== "string" && typeof id !== "number") continue;
      if (typeof actor !== "string" || !Array.isArray(items)) continue;
      for (const item of items) {
        const it = asRecord(item);
        if (it?.["field"] !== "assignee") continue;
        const to = it["to"];
        out.push({
          id: String(id),
          actorAccountId: actor,
          toAccountId: typeof to === "string" && to.length > 0 ? to : null,
          at: typeof created === "string" ? created : "",
        });
      }
    }
    return out;
  }

  /** Poller payload → command, or null. Never throws on unknown commands. */
  async parseCommand(rawBody: unknown): Promise<CommandEnvelope | null> {
    return this.parseCommandDetailed(rawBody).envelope;
  }

  /** Same parse, keeping the "looks like a command but is malformed" result. */
  parseCommandDetailed(rawBody: unknown): CloudCommentCommand {
    return commandFromCloudPayload(rawBody);
  }

  /** Direct entry for the comment poller: one comment resource + its issue key. */
  parseCommandFromComment(ticketKey: string, comment: unknown): CloudCommentCommand {
    return parseCommandFromComment(ticketKey, comment);
  }

  /**
   * Attach a single file to an issue (M103r — the analysis Word/PDF land on the
   * ticket automatically instead of a human dragging them in).
   *
   * DRIVER-SPECIFIC CAPABILITY, not a WorkPort method. `WorkPort` is FROZEN
   * (packages/ports), so this lives on the concrete Cloud driver only — the same
   * shape as `verifyWebhook`/`transition`, which throw `CapabilityNotSupported`
   * on the port surface while real behaviour lives on the drivers. A caller
   * reaches it through the concrete `JiraCloudWorkPort` type (as the pilot does
   * via `createJiraCloudWorkPort`), never through a `WorkPort` reference.
   *
   * POST /rest/api/3/issue/{key}/attachments, `multipart/form-data`, `file`
   * field, header `X-Atlassian-Token: no-check` → 200 with a JSON array of
   * attachment resources (fixtures/cloud/attachments-created.json). Returns the
   * created attachment id(s). The filename is sanitised (no path segments, no
   * CR/LF) before it reaches the multipart part name.
   */
  async addAttachment(
    key: TicketKey,
    filename: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ ids: string[] }> {
    const issueKey = requireTicketKey(key, "key");
    const safeName = sanitizeAttachmentFilename(filename);
    // Copy into a fresh ArrayBuffer so the Blob owns exactly these bytes even if
    // `bytes` is a view over a larger pooled buffer.
    const copy = bytes.slice();
    const blob = new Blob([copy], { type: contentType });
    const created = await this.client.postFile<unknown>(
      `${API}/issue/${encodeURIComponent(issueKey)}/attachments`,
      "file",
      blob,
      safeName,
    );
    return { ids: attachmentIdsOf(created) };
  }

  /**
   * Read the project's workflow graph (statuses + observed transitions) for
   * Studio's import screen.
   *
   * DRIVER-SPECIFIC CAPABILITY, not a WorkPort method — the same shape as
   * `addAttachment`. `WorkPort` is FROZEN (packages/ports), and mapping live
   * Jira statuses onto Studio is a NEW read layer, not a change to the frozen
   * port surface. A caller reaches it through the concrete `JiraCloudWorkPort`
   * type (as the composition root does via `createJiraCloudWorkPort`), never
   * through a `WorkPort` reference. Read-only: it moves no issue, so the frozen
   * `transition()` no-op below is unaffected.
   */
  readProjectWorkflow(projectKey: string, options?: JiraWorkflowReadOptions): Promise<JiraWorkflowGraph> {
    return new JiraCloudWorkflowReader(this.client).readProjectWorkflow(projectKey, options);
  }

  /**
   * The transitions available FROM an issue's current status, each carrying its
   * destination status's category — the source a caller picks a target from by
   * category rather than by a brittle localised name.
   *
   * DRIVER-SPECIFIC CAPABILITY, not a WorkPort method — the same shape as
   * `readProjectWorkflow`. This one READS (`GET /issue/{key}/transitions`), and
   * `expand=transitions.fields` is NOT requested: the default payload already
   * carries `to.statusCategory`, which is all the category-based selection needs.
   */
  async readAvailableTransitions(key: TicketKey): Promise<AvailableTransition[]> {
    const issueKey = requireTicketKey(key, "key");
    const raw = await this.client.get<unknown>(
      `${API}/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    return parseAvailableTransitions(raw);
  }

  /**
   * Apply a transition by id — the WRITE the frozen `WorkPort.transition` no-op
   * cannot perform. `POST /issue/{key}/transitions` with `{ transition: { id } }`
   * answers 204 on success (fixtures/cloud/transition-applied is a 204).
   *
   * DRIVER-SPECIFIC CAPABILITY, reached through the concrete `JiraCloudWorkPort`
   * exactly like `addAttachment`. The frozen port's `transition()` below stays a
   * CapabilityNotSupported no-op; a caller that wants the real move addresses the
   * concrete driver, so no frozen contract is widened.
   */
  async applyTransition(key: TicketKey, transitionId: string): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    const id = requireTransitionId(transitionId);
    await this.client.post<void>(`${API}/issue/${encodeURIComponent(issueKey)}/transitions`, {
      transition: { id },
    });
  }

  /**
   * Hand an unfit ticket back to its reporter (İADE): reassign it to
   * `reporterAccountId` and move it to a backlog/To-Do status, choosing the
   * transition DYNAMICALLY by destination category (never a hard-coded name —
   * see return-flow.ts). Returns what actually happened so the caller can log
   * and audit the real outcome:
   *
   *   - `assigned`     — the reassignment succeeded.
   *   - `transitioned` — a To-Do transition was found AND applied.
   *   - `transition`   — the transition Jira offered (null when none applied),
   *                      so the caller records which status the ticket returned to.
   *
   * Fail-SOFT is the caller's job (the return is a clean stop, not a failure):
   * this method still throws on a real Jira error so the caller decides whether
   * to swallow it. When the issue's current status offers NO To-Do transition
   * (already in the backlog, or the workflow forbids going back), the ticket is
   * still reassigned and `transitioned:false` is returned — not an error.
   */
  async returnToReporter(
    key: TicketKey,
    reporterAccountId: string,
  ): Promise<{ assigned: boolean; transitioned: boolean; transition: AvailableTransition | null }> {
    const issueKey = requireTicketKey(key, "key");
    await this.assign(issueKey, reporterAccountId);
    const transitions = await this.readAvailableTransitions(issueKey);
    const target = selectReturnTransition(transitions);
    if (target === null) {
      return { assigned: true, transitioned: false, transition: null };
    }
    await this.applyTransition(issueKey, target.id);
    return { assigned: true, transitioned: true, transition: target };
  }

  /**
   * Hand a ticket to the Analyst Manager for analysis approval (onay devri):
   * reassign it to `managerAccountId` and move it INTO REVIEW — the review
   * status chosen DYNAMICALLY, matching `reviewStatusName` (default "İNCELEMEDE")
   * by name FIRST and then falling back to the In-Progress category (never a
   * hard-coded transition id or a brittle name-only match — see return-flow.ts).
   * Returns what actually happened so the caller logs and audits the real
   * outcome:
   *
   *   - `assigned`     — the reassignment to the manager succeeded.
   *   - `transitioned` — a review transition was found AND applied.
   *   - `transition`   — the transition Jira offered (null when none applied),
   *                      so the caller records which status the ticket moved to.
   *
   * The reassign runs FIRST and unconditionally: even a workflow that offers no
   * in-progress edge from the current status (already in review, or a locked
   * workflow) still lands the ticket in the manager's queue, with
   * `transitioned:false` — that is not an error. This method still throws on a
   * real Jira error (a refused assign, a 5xx) so the caller decides whether to
   * treat the handover as fatal.
   */
  async sendToReview(
    key: TicketKey,
    managerAccountId: string,
    reviewStatusName: string = DEFAULT_REVIEW_STATUS_NAME,
  ): Promise<{ assigned: boolean; transitioned: boolean; transition: AvailableTransition | null }> {
    const issueKey = requireTicketKey(key, "key");
    const manager = managerAccountId.trim();
    if (manager.length === 0) throw new JiraArgumentError("managerAccountId", "empty");
    await this.assign(issueKey, manager);
    const transitions = await this.readAvailableTransitions(issueKey);
    const target = selectReviewTransition(transitions, reviewStatusName);
    if (target === null) {
      return { assigned: true, transitioned: false, transition: null };
    }
    await this.applyTransition(issueKey, target.id);
    return { assigned: true, transitioned: true, transition: target };
  }

  /**
   * Verify a delivery before anything else touches it, so a ticket created in
   * Jira can start a run WITHOUT anyone pressing Start.
   *
   * Jira Cloud signs a registered webhook with HMAC-SHA256 over the raw UTF-8
   * request body and sends the digest as `X-Hub-Signature: sha256=<hex>`, using
   * the `secret` supplied at registration time — the same scheme Data Center
   * uses, so the two drivers share one verifier (`../webhook.ts`) rather than
   * keeping two copies of a constant-time comparison.
   * (developer.atlassian.com/cloud/jira/platform/webhooks — "Validating webhook
   * deliveries"; the docs state sha256 is what Jira signs with today.)
   *
   * Fail-closed on every path, including the one that used to be a capability
   * refusal: a deployment that registered no webhook has NO secret to check
   * against, and the only safe reading of an unverifiable delivery is to refuse
   * it. `missing_secret` says the platform is misconfigured — it never means
   * "let it through".
   */
  async verifyWebhook(rawBody: string | Uint8Array, headers: Record<string, string>): Promise<void> {
    if (this.webhookSecret === null) {
      throw new JiraWebhookVerificationError("missing_secret");
    }
    const header = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === JIRA_SIGNATURE_HEADER,
    )?.[1];
    verifyWebhookSignature(rawBody, header, await this.webhookSecret());
  }

  /**
   * Move the issue by TRANSITION ID — the frozen port's `transition`, now real
   * on Cloud rather than a capability refusal. It is `applyTransition` under the
   * port's name: one `POST /issue/{key}/transitions` with `{transition:{id}}`,
   * answered 204.
   *
   * Kept as a thin delegation on purpose. A caller holding a plain `WorkPort`
   * reference can now move a ticket, while everything that already addresses the
   * concrete driver keeps working — one request shape, one place to change it.
   *
   * By-id remains the LOW-level entry: a transition id is a per-workflow number
   * (the live OPS workflow's 11/21/31/41 mean nothing on another project), so a
   * caller that knows only WHERE it wants the ticket should reach for
   * `transitionToStatus` instead of hard-coding one of these.
   */
  async transition(key: TicketKey, transitionId: string): Promise<void> {
    await this.applyTransition(key, transitionId);
  }

  /**
   * Move the issue to a STATUS BY NAME, and report what happened instead of
   * throwing — the entry point a workflow step uses when its policy is "warn but
   * continue".
   *
   * DRIVER-SPECIFIC CAPABILITY, not a WorkPort method — the same shape as
   * `addAttachment` / `readProjectWorkflow`. `WorkPort` is FROZEN
   * (packages/ports), and this returns a RESULT rather than `void`, which the
   * frozen signature cannot express.
   *
   * Why by name and not by id: a transition id is meaningless outside the one
   * workflow that issued it, so a hard-coded id silently moves the wrong ticket
   * (or nothing) the moment a project uses a different workflow. The caller names
   * the destination it wants; this method asks Jira which edge leads there.
   *
   * The contract is total — it NEVER throws, and every outcome is a reason:
   *
   *   - `{moved:true}`                     — a matching transition was applied.
   *   - `{moved:false, reason:"already"}`  — the issue is ALREADY in that status,
   *     so no POST is sent at all. The step may be retried (a workflow replay, a
   *     manual re-run), and a re-POST of an already-made move is at best a 400;
   *     short-circuiting is what makes the call idempotent.
   *   - `{moved:false, reason:"no_transition"}` — the workflow offers no edge to
   *     that status from where the issue stands. Not an error: a site may simply
   *     not have the column, or the issue may sit somewhere the move is illegal.
   *   - `{moved:false, reason:"forbidden"}` — Jira answered 403. The service
   *     account may browse the issue but not transition it; the analysis is still
   *     worth delivering, so the caller warns and carries on.
   *   - `{moved:false, reason:"read_failed" | "transition_failed"}` — anything
   *     else (5xx, 404, a malformed body), split by WHICH call failed so the log
   *     says whether we never learned the options or could not apply the one we
   *     picked.
   */
  async transitionToStatus(
    key: TicketKey,
    statusName: string,
  ): Promise<{ moved: boolean; reason?: string }> {
    // The key and the status name are validated up front and reported as a
    // reason, not raised: a caller that must not throw would otherwise still get
    // an exception out of the argument guards.
    const parsed = TicketKey.safeParse(key);
    if (!parsed.success) return { moved: false, reason: "bad_key" };
    const issueKey = parsed.data;
    const wanted = statusName.trim();
    if (wanted.length === 0) return { moved: false, reason: "bad_status_name" };

    // Read the CURRENT status first, so an already-there issue costs one GET and
    // no write. `fields=status` keeps it to the one field the decision needs
    // rather than dragging the whole issue across.
    let current: string | null;
    let transitions: AvailableTransition[];
    try {
      const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}`, {
        fields: "status",
      });
      current = currentStatusNameOf(raw);
      if (current !== null && foldStatusName(current) === foldStatusName(wanted)) {
        return { moved: false, reason: "already" };
      }
      transitions = await this.readAvailableTransitions(issueKey);
    } catch {
      return { moved: false, reason: "read_failed" };
    }

    const target = selectTransitionByStatusName(transitions, wanted);
    if (target === null) return { moved: false, reason: "no_transition" };

    try {
      await this.applyTransition(issueKey, target.id);
    } catch (error) {
      // 403 is called out by itself because it is the one failure an operator
      // fixes in Jira (grant the service account "Transition Issues") rather
      // than in Maestro — worth its own reason in the log.
      if (error instanceof JiraForbiddenError) return { moved: false, reason: "forbidden" };
      return { moved: false, reason: "transition_failed" };
    }
    return { moved: true };
  }
}

/**
 * The issue's current status NAME from a `fields=status` read. Returns null when
 * the site answered without one: unknown is not "already there", so the caller
 * goes on to look for a transition rather than short-circuiting on a guess.
 */
function currentStatusNameOf(raw: unknown): string | null {
  const status = asRecord(asRecord(asRecord(raw)?.["fields"])?.["status"]);
  const name = status?.["name"];
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
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

/** Pre-flight shared by setLabels and createLinkedIssue: trim, refuse what Jira would reject. */
function requireCleanLabels(labels: string[]): string[] {
  const clean = labels.map((label) => label.trim());
  for (const label of clean) {
    if (label.length === 0) throw new JiraArgumentError("labels", "empty label");
    if (/\s/.test(label)) throw new JiraArgumentError("labels", `Jira labels cannot contain whitespace: "${label}"`);
  }
  return clean;
}

/**
 * Reduce an untrusted filename to a bare, single-segment name safe to hand to
 * the multipart part: strip any directory portion (`../evil` → `evil`), drop
 * control characters including CR/LF (a header-injection vector), and collapse
 * the reserved path/quote characters. A name that sanitises to nothing falls
 * back to `attachment` so the upload still names its part.
 */
export function sanitizeAttachmentFilename(name: string): string {
  // Last path segment only — handles both / and \ separators.
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, "") // control chars incl. CR/LF/TAB
    .replace(/["*:<>?|]/g, "") // characters Jira/OS reject in names
    .replace(/^\.+/, "") // no leading dots (".." → "", ".env" → "env")
    .trim();
  return cleaned.length > 0 ? cleaned : "attachment";
}

/**
 * Pull the created attachment ids out of the Cloud response — a JSON array of
 * attachment resources. Fails loudly if the site answered 2xx without a usable
 * array, so a silent "attached nothing" cannot masquerade as success.
 */
function attachmentIdsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new JiraResponseError("attachment", ["response is not an array of attachments"]);
  }
  const ids = raw
    .map((entry) => {
      const id = asRecord(entry)?.["id"];
      if (typeof id === "string" && id.length > 0) return id;
      if (typeof id === "number") return String(id);
      return null;
    })
    .filter((id): id is string => id !== null);
  if (ids.length === 0) {
    throw new JiraResponseError("attachment", ["response carries no attachment id"]);
  }
  return ids;
}

function currentLabelsOf(raw: unknown): string[] {
  const fields = asRecord(asRecord(raw)?.["fields"]);
  if (!fields) throw new JiraResponseError("issue.fields", ["label read returned no fields object"]);
  const labels = fields["labels"];
  return Array.isArray(labels)
    ? labels.filter((label): label is string => typeof label === "string" && label.trim().length > 0)
    : [];
}

/**
 * Same rule as on DC: a page bean carrying neither `isLast` nor a numeric
 * `total` cannot be reasoned about, and stopping there would silently deny a
 * real member — raise instead (M32 fail-closed, but never silent).
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
