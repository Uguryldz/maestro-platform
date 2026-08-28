import { ApplicationRecord, GitSha } from "@maestro/contracts";
import type { PrStatus, PrThread, RepoRef, ScmPort } from "@maestro/ports";
import { isFullSha, toGitSha, toRefName, ZERO_OBJECT_ID } from "./branch.js";
import type { AdoClient } from "./client.js";
import { DEFAULT_MAX_PUSH_TTL_SECONDS } from "./config.js";
import {
  assertTtlWithinCeiling,
  issuedCredentialIssues,
  pushScope,
  type SecretIssuer,
} from "./credential.js";
import { AdoResponseError } from "./errors.js";
import { parseOrThrow as parse } from "./parse.js";
import {
  type AdoThreadStatus,
  CreatedCommentResponse,
  PullRequestResponse,
  RefsListResponse,
  RefUpdateResponse,
  RepoResponse,
  type Thread,
  ThreadsListResponse,
} from "./schemas.js";

export interface AdoScmDriverOptions {
  client: AdoClient;
  issueSecret: SecretIssuer;
  /** Ceiling for push credential TTLs (M31); defaults to the config default. */
  maxPushTtlSeconds?: number;
  /** Injected clock so the expiry window can be asserted deterministically. */
  now?: () => number;
}

/** ADO thread status → port status. */
const THREAD_STATUS: Record<AdoThreadStatus, PrThread["status"]> = {
  active: "active",
  // A pending thread is still open work for the reviewer loop (12b).
  pending: "active",
  // "unknown" is what ADO returns for threads whose status was never set;
  // treating it as active keeps the loop open instead of silently passing.
  unknown: "active",
  fixed: "fixed",
  closed: "closed",
  wontFix: "closed",
  byDesign: "closed",
};

/**
 * ScmPort driver "ado" (M11-M13). One implementation serves both Server and
 * Services: the mode only changes URL shape and api-version, which the
 * AdoClient owns, so the REST calls below are identical in both worlds.
 */
export class AdoScmDriver implements ScmPort {
  private readonly client: AdoClient;
  private readonly issueSecret: SecretIssuer;
  private readonly maxPushTtlSeconds: number;
  private readonly now: () => number;

  constructor(options: AdoScmDriverOptions) {
    this.client = options.client;
    this.issueSecret = options.issueSecret;
    this.maxPushTtlSeconds = options.maxPushTtlSeconds ?? DEFAULT_MAX_PUSH_TTL_SECONDS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Resolves the Application Registry record (M100) to a repository, and
   * verifies it exists — a typo in the registry must fail here, loudly,
   * not three steps later when a push has nowhere to go.
   */
  async resolveRepo(app: ApplicationRecord): Promise<RepoRef> {
    const record = ApplicationRecord.parse(app);
    const body = parse(RepoResponse, await this.client.request({
      project: record.adoProject,
      path: `git/repositories/${encodeURIComponent(record.adoRepo)}`,
    }), "GET repository");
    return { project: body.project.name, repo: body.name };
  }

  /**
   * Creates a branch by pushing a ref update from the all-zero object id.
   * `fromRef` may be a full commit id or a branch/ref name, which is then
   * resolved to its tip first.
   */
  async createBranch(repo: RepoRef, name: string, fromRef: string): Promise<void> {
    const baseSha = isFullSha(fromRef) ? fromRef : await this.resolveRefSha(repo, fromRef);
    const refName = toRefName(name);
    const body = parse(RefUpdateResponse, await this.client.request({
      project: repo.project,
      path: `git/repositories/${encodeURIComponent(repo.repo)}/refs`,
      method: "POST",
      body: [{ name: refName, oldObjectId: ZERO_OBJECT_ID, newObjectId: baseSha }],
    }), "POST refs");

    const update = body.value[0];
    if (update === undefined) {
      throw new AdoResponseError("POST refs", ["empty ref update result"]);
    }
    if (!update.success) {
      // ADO answers 200 with success:false (stale base, branch exists,
      // policy plugin rejection) — never treat that as created.
      throw new AdoResponseError("POST refs", [
        `ref update for ${refName} rejected: ${update.updateStatus ?? "unknown"}`,
      ]);
    }
  }

  /** Tip commit id of a branch/ref, via the exact-name ref filter. */
  private async resolveRefSha(repo: RepoRef, fromRef: string): Promise<string> {
    const refName = toRefName(fromRef);
    const body = parse(RefsListResponse, await this.client.request({
      project: repo.project,
      path: `git/repositories/${encodeURIComponent(repo.repo)}/refs`,
      query: { filter: refName.replace(/^refs\//, "") },
    }), "GET refs");

    const match = body.value.find((ref) => ref.name === refName);
    if (match === undefined) {
      throw new AdoResponseError("GET refs", [`base ref ${refName} not found`]);
    }
    return match.objectId;
  }

  /**
   * Short-lived push credential for the runner (M31/M80): a pass-through of
   * whatever the injected issuer mints (an ADO PAT scoped to vso.code_write
   * in practice). This adapter never stores or logs the value.
   *
   * "Short-lived" is enforced, not assumed, on both sides of the call: the
   * request may not ask for more than the configured ceiling, and the issued
   * credential must actually expire inside the window it was asked for. A
   * long-lived or already-expired credential is a failure, not a warning.
   */
  async getPushCredential(
    repo: RepoRef,
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: string }> {
    assertTtlWithinCeiling(ttlSeconds, this.maxPushTtlSeconds);
    const issued = await this.issueSecret(pushScope(repo), ttlSeconds);
    const issues = issuedCredentialIssues(issued, ttlSeconds, this.now());
    if (issues.length > 0) throw new AdoResponseError("getPushCredential", issues);
    return { token: issued.secret, expiresAt: issued.expiresAt };
  }

  /** Opens the PR; `draft: true` is honoured as ADO's `isDraft` (M13). */
  async openPr(
    repo: RepoRef,
    args: {
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description: string;
      draft: boolean;
    },
  ): Promise<{ prId: number }> {
    const body = parse(PullRequestResponse, await this.client.request({
      project: repo.project,
      path: `git/repositories/${encodeURIComponent(repo.repo)}/pullrequests`,
      method: "POST",
      body: {
        sourceRefName: toRefName(args.sourceBranch),
        targetRefName: toRefName(args.targetBranch),
        title: args.title,
        description: args.description,
        isDraft: args.draft,
      },
    }), "POST pullrequests");
    return { prId: body.pullRequestId };
  }

  /** Draft → active. Verified against the response: no optimistic success. */
  async activatePr(repo: RepoRef, prId: number): Promise<void> {
    const body = parse(PullRequestResponse, await this.client.request({
      project: repo.project,
      path: `git/repositories/${encodeURIComponent(repo.repo)}/pullrequests/${prId}`,
      method: "PATCH",
      body: { isDraft: false },
    }), "PATCH pullrequest");
    if (body.isDraft === true) {
      throw new AdoResponseError("PATCH pullrequest", [`pull request ${prId} is still a draft`]);
    }
  }

  /**
   * Review threads for the 12b comment loop. System threads (votes, policy
   * updates, status changes) carry no reviewer text and are dropped.
   */
  async listPrThreads(repo: RepoRef, prId: number): Promise<PrThread[]> {
    const body = parse(ThreadsListResponse, await this.client.request({
      project: repo.project,
      path: `git/repositories/${encodeURIComponent(repo.repo)}/pullrequests/${prId}/threads`,
    }), "GET threads");

    return body.value
      .filter((thread) => thread.isDeleted !== true)
      .map((thread) => mapThread(thread))
      .filter((thread): thread is PrThread => thread !== null);
  }

  /** Replies inside an existing thread (parent = the thread's first comment). */
  async replyThread(repo: RepoRef, prId: number, threadId: number, text: string): Promise<void> {
    parse(CreatedCommentResponse, await this.client.request({
      project: repo.project,
      path:
        `git/repositories/${encodeURIComponent(repo.repo)}` +
        `/pullrequests/${prId}/threads/${threadId}/comments`,
      method: "POST",
      body: { content: text, parentCommentId: 1, commentType: "text" },
    }), "POST thread comment");
  }

  /**
   * PR state for the gates. `mergeSha` is only ever filled for a COMPLETED
   * pull request: ADO populates `lastMergeCommit` on every source-branch
   * update with the commit of its *preview* merge, so on an active PR that
   * field names a commit that exists in no target branch. Reporting it as
   * the merge sha would tell the workflow a PR was merged while review is
   * still open — the gate would record a merge that never happened.
   */
  async getPrStatus(repo: RepoRef, prId: number): Promise<PrStatus> {
    const body = parse(PullRequestResponse, await this.client.request({
      project: repo.project,
      path: `git/repositories/${encodeURIComponent(repo.repo)}/pullrequests/${prId}`,
    }), "GET pullrequest");

    let state: PrStatus["state"];
    switch (body.status) {
      case "active":
        state = body.isDraft === true ? "draft" : "active";
        break;
      case "completed":
      case "abandoned":
        state = body.status;
        break;
      default:
        throw new AdoResponseError("GET pullrequest", [`unsupported PR status: ${body.status}`]);
    }

    const rawMergeSha = state === "completed" ? body.lastMergeCommit?.commitId : undefined;
    let mergeSha: GitSha | null = null;
    if (rawMergeSha !== undefined) {
      mergeSha = toGitSha(rawMergeSha);
      if (mergeSha === null) {
        // A present-but-malformed commit id is a contract breach, not a
        // "no merge yet" — reporting null here would fake a clean state.
        throw new AdoResponseError("GET pullrequest", [`invalid lastMergeCommit: ${rawMergeSha}`]);
      }
    }
    return { prId: body.pullRequestId, state, mergeSha };
  }
}

function mapThread(thread: Thread): PrThread | null {
  const comments = (thread.comments ?? [])
    .filter((comment) => comment.isDeleted !== true && comment.commentType !== "system")
    .map((comment) => ({
      author: comment.author?.displayName ?? comment.author?.uniqueName ?? "",
      text: comment.content ?? "",
      at: comment.publishedDate ?? thread.publishedDate ?? "",
    }));
  if (comments.length === 0) return null;
  return { threadId: thread.id, status: THREAD_STATUS[thread.status ?? "unknown"], comments };
}
