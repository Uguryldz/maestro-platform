import { ApplicationRecord, type GitSha } from "@maestro/contracts";
import type { CommitChecks, PrStatus, PrThread, RepoRef, ScmPort } from "@maestro/ports";
import { isFullSha, toFullRef, toGitSha, toHeadsPath } from "./branch.js";
import type { GithubClient } from "./client.js";
import { DEFAULT_MAX_PUSH_TTL_SECONDS } from "./config.js";
import {
  assertTtlWithinCeiling,
  issuedCredentialIssues,
  pushScope,
  type SecretIssuer,
} from "./credential.js";
import { GithubResponseError } from "./errors.js";
import { parseOrThrow as parse } from "./parse.js";
import {
  CheckRunsResponse,
  CreatedRefResponse,
  CreatedReviewComment,
  GitRefResponse,
  MarkReadyResponse,
  MergeResponse,
  PullRequestResponse,
  RepoResponse,
  type ReviewComment,
  ReviewCommentsResponse,
} from "./schemas.js";

export interface GithubScmDriverOptions {
  client: GithubClient;
  issueSecret: SecretIssuer;
  /** Ceiling for push credential TTLs (M31); defaults to the config default. */
  maxPushTtlSeconds?: number;
  /** Injected clock so the expiry window can be asserted deterministically. */
  now?: () => number;
}

/** Marks a draft pull request ready for review (draft → active). */
const MARK_READY_MUTATION = `mutation MarkReady($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) {
    pullRequest { number isDraft }
  }
}`;

/**
 * ScmPort driver "github" (Dalga C1). Implements the same frozen ScmPort as
 * the ADO driver against GitHub's REST v3 API, plus one GraphQL mutation
 * (draft → ready-for-review has no REST form).
 *
 * RepoRef maps to GitHub as { project: owner, repo }.
 */
export class GithubScmDriver implements ScmPort {
  private readonly client: GithubClient;
  private readonly issueSecret: SecretIssuer;
  private readonly maxPushTtlSeconds: number;
  private readonly now: () => number;

  constructor(options: GithubScmDriverOptions) {
    this.client = options.client;
    this.issueSecret = options.issueSecret;
    this.maxPushTtlSeconds = options.maxPushTtlSeconds ?? DEFAULT_MAX_PUSH_TTL_SECONDS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Resolves the Application Registry record (M100) to a repository, and
   * verifies it exists — a typo in the registry must fail here, loudly, not
   * three steps later when a push has nowhere to go. `adoProject`/`adoRepo`
   * carry the GitHub owner/repo (the contract field names predate GitHub;
   * the semantics are owner/repo here).
   */
  async resolveRepo(app: ApplicationRecord): Promise<RepoRef> {
    const record = ApplicationRecord.parse(app);
    const owner = record.adoProject; // owner login
    const repo = record.adoRepo; // repository name
    const body = parse(
      RepoResponse,
      await this.client.request({
        path: `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      }),
      "GET repository",
    );
    return { project: body.owner.login, repo: body.name };
  }

  /**
   * Creates a branch in two steps: resolve the base ref/commit to a sha, then
   * POST a new ref pointing at it. A full 40-char commit id is used directly;
   * anything else is treated as a branch name and resolved to its tip first.
   */
  async createBranch(repo: RepoRef, name: string, fromRef: string): Promise<void> {
    const baseSha = isFullSha(fromRef) ? fromRef : await this.resolveRefSha(repo, fromRef);
    const fullRef = toFullRef(name);
    const body = parse(
      CreatedRefResponse,
      await this.client.request({
        path: `repos/${this.slug(repo)}/git/refs`,
        method: "POST",
        body: { ref: fullRef, sha: baseSha },
      }),
      "POST git/refs",
    );
    if (body.ref !== fullRef) {
      throw new GithubResponseError("POST git/refs", [
        `created ref ${body.ref} does not match requested ${fullRef}`,
      ]);
    }
  }

  /** Delete a branch (its ref) after merge, via DELETE git/refs/heads/{branch}. */
  async deleteBranch(repo: RepoRef, name: string): Promise<void> {
    await this.client.request({
      path: `repos/${this.slug(repo)}/git/refs/${toHeadsPath(name)}`,
      method: "DELETE",
    });
  }

  /** Tip commit sha of a branch via GET git/ref/heads/{branch}. */
  private async resolveRefSha(repo: RepoRef, fromRef: string): Promise<string> {
    const body = parse(
      GitRefResponse,
      await this.client.request({
        path: `repos/${this.slug(repo)}/git/ref/${toHeadsPath(fromRef)}`,
      }),
      "GET git/ref",
    );
    return body.object.sha;
  }

  /**
   * Short-lived push credential for the runner (M31/M80): a pass-through of
   * whatever the injected issuer mints (a GitHub App installation token scoped
   * to the repo, in practice). This adapter never stores or logs the value.
   *
   * "Short-lived" is enforced, not assumed, on both sides: the request may not
   * ask for more than the configured ceiling, and the issued credential must
   * actually expire inside the window it was asked for. A long-lived or
   * already-expired credential is a failure, not a warning.
   */
  async getPushCredential(
    repo: RepoRef,
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: string }> {
    assertTtlWithinCeiling(ttlSeconds, this.maxPushTtlSeconds);
    const issued = await this.issueSecret(pushScope(repo), ttlSeconds);
    const issues = issuedCredentialIssues(issued, ttlSeconds, this.now());
    if (issues.length > 0) throw new GithubResponseError("getPushCredential", issues);
    return { token: issued.secret, expiresAt: issued.expiresAt };
  }

  /**
   * Opens the PR. `head`/`base` are bare branch names on GitHub (not the
   * `refs/heads/` form ADO wants). `draft: true` is honoured directly.
   */
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
    const body = parse(
      PullRequestResponse,
      await this.client.request({
        path: `repos/${this.slug(repo)}/pulls`,
        method: "POST",
        body: {
          title: args.title,
          head: bareBranch(args.sourceBranch),
          base: bareBranch(args.targetBranch),
          body: args.description,
          draft: args.draft,
        },
      }),
      "POST pulls",
    );
    return { prId: body.number };
  }

  /**
   * Draft → active. GitHub has no REST route for "ready for review"; it is a
   * GraphQL mutation keyed by the PR's node id, so the driver fetches the node
   * id first, runs the mutation, and verifies the PR is no longer a draft. No
   * optimistic success.
   */
  async activatePr(repo: RepoRef, prId: number): Promise<void> {
    const pr = await this.getPullRequest(repo, prId);
    const data = parse(
      MarkReadyResponse,
      await this.client.graphql(MARK_READY_MUTATION, { id: pr.node_id }),
      "markPullRequestReadyForReview",
    );
    const stillDraft = data.markPullRequestReadyForReview?.pullRequest.isDraft;
    if (stillDraft === true) {
      throw new GithubResponseError("markPullRequestReadyForReview", [
        `pull request ${prId} is still a draft`,
      ]);
    }
  }

  /**
   * Review conversation for the 12b comment loop. GitHub returns review
   * comments as a FLAT list; a comment with no `in_reply_to_id` is a thread
   * root, and every comment carrying that root's id (directly or transitively)
   * belongs to its thread. Grouping is by resolved root id.
   *
   * Only line-anchored REVIEW comments are mapped — that is the review
   * conversation the engineering loop must answer. Issue comments (the PR's
   * non-anchored discussion) are deliberately NOT mapped here; see RAPOR.
   *
   * GitHub's REST comment list carries no per-thread resolved/unresolved flag
   * (that lives only in GraphQL), so every mapped thread is reported "active":
   * an open item for the loop until it is answered. Never silently "fixed".
   */
  async listPrThreads(repo: RepoRef, prId: number): Promise<PrThread[]> {
    const comments = parse(
      ReviewCommentsResponse,
      await this.client.request({
        path: `repos/${this.slug(repo)}/pulls/${prId}/comments`,
        query: { per_page: 100 },
      }),
      "GET pull comments",
    );
    return groupThreads(comments);
  }

  /**
   * Replies inside an existing review thread. `threadId` is the id of the
   * thread's root comment; GitHub's reply route parents the new comment to it.
   */
  async replyThread(repo: RepoRef, prId: number, threadId: number, text: string): Promise<void> {
    parse(
      CreatedReviewComment,
      await this.client.request({
        path: `repos/${this.slug(repo)}/pulls/${prId}/comments/${threadId}/replies`,
        method: "POST",
        body: { body: text },
      }),
      "POST comment reply",
    );
  }

  /**
   * PR state for the gates. `mergeSha` is filled ONLY for a merged PR:
   * `merge_commit_sha` is also populated on an open PR (GitHub's test-merge
   * preview commit) and on a closed-unmerged PR (the last attempted merge),
   * and neither of those commits is on the base branch. Reporting it would
   * tell the workflow a PR merged while review is still open — the gate would
   * record a merge that never happened.
   *
   *   open + draft   → draft
   *   open           → active
   *   closed + merged→ completed (mergeSha = merge_commit_sha)
   *   closed         → abandoned
   */
  async getPrStatus(repo: RepoRef, prId: number): Promise<PrStatus> {
    const body = await this.getPullRequest(repo, prId);

    let state: PrStatus["state"];
    if (body.state === "open") {
      state = body.draft === true ? "draft" : "active";
    } else {
      state = body.merged === true ? "completed" : "abandoned";
    }

    let mergeSha: GitSha | null = null;
    if (state === "completed") {
      const raw = body.merge_commit_sha ?? undefined;
      if (raw === undefined || raw === null) {
        throw new GithubResponseError("GET pull request", [
          `merged pull request ${prId} has no merge_commit_sha`,
        ]);
      }
      mergeSha = toGitSha(raw);
      if (mergeSha === null) {
        // A present-but-malformed commit id is a contract breach, not a
        // "no merge yet" — reporting null here would fake a clean state.
        throw new GithubResponseError("GET pull request", [`invalid merge_commit_sha: ${raw}`]);
      }
    }
    return { prId: body.number, state, mergeSha };
  }

  private async getPullRequest(repo: RepoRef, prId: number): Promise<PullRequestResponse> {
    return parse(
      PullRequestResponse,
      await this.client.request({ path: `repos/${this.slug(repo)}/pulls/${prId}` }),
      "GET pull request",
    );
  }

  /**
   * Aggregate CI verdict for a commit via GET commits/{sha}/check-runs (B14).
   *
   * Rules, fail-closed: any check still `queued`/`in_progress` → `pending`
   * (never call a build green while it is running); any completed check whose
   * conclusion is not a pass (`success`/`neutral`/`skipped`) → `failure`; all
   * completed and passing → `success`; no checks at all → `none` (a repo with
   * no CI configured — the caller decides whether that is acceptable).
   */
  async getCommitChecks(repo: RepoRef, sha: GitSha): Promise<CommitChecks> {
    const body = parse(
      CheckRunsResponse,
      await this.client.request({ path: `repos/${this.slug(repo)}/commits/${sha}/check-runs` }),
      "GET check-runs",
    );
    if (body.check_runs.length === 0) return { sha, state: "none", detail: [] };

    const PASS = new Set(["success", "neutral", "skipped"]);
    const detail: string[] = [];
    let anyPending = false;
    let anyFailed = false;
    for (const run of body.check_runs) {
      const name = run.name ?? "check";
      if (run.status !== "completed") {
        anyPending = true;
        detail.push(`${name} ⏳`);
        continue;
      }
      const conclusion = run.conclusion ?? "";
      if (PASS.has(conclusion)) {
        detail.push(`${name} ✓`);
      } else {
        anyFailed = true;
        detail.push(`${name} ✗ (${conclusion || "?"})`);
      }
    }
    // A failure is decided even if something is still pending: a red check does
    // not turn green by waiting, so surface it now rather than blocking.
    const state = anyFailed ? "failure" : anyPending ? "pending" : "success";
    return { sha, state, detail };
  }

  /**
   * Merge a pull request via PUT pulls/{n}/merge (B14). Returns the merge commit
   * sha. GitHub answers 200 with `{merged:true, sha}` on success and a 405/409
   * (a client error the transport raises) when the PR is not mergeable — this
   * method never fakes a merge, so a non-merged 200 is itself an error.
   */
  async mergePr(repo: RepoRef, prId: number): Promise<{ mergeSha: GitSha }> {
    const body = parse(
      MergeResponse,
      await this.client.request({
        path: `repos/${this.slug(repo)}/pulls/${prId}/merge`,
        method: "PUT",
        body: { merge_method: "merge" },
      }),
      "PUT merge",
    );
    if (!body.merged || body.sha === undefined) {
      throw new GithubResponseError("PUT merge", [
        `pull request ${prId} did not merge: ${body.message ?? "unknown"}`,
      ]);
    }
    const mergeSha = toGitSha(body.sha);
    if (mergeSha === null) {
      throw new GithubResponseError("PUT merge", [`invalid merge sha: ${body.sha}`]);
    }
    return { mergeSha };
  }

  private slug(repo: RepoRef): string {
    return `${encodeURIComponent(repo.project)}/${encodeURIComponent(repo.repo)}`;
  }
}

/** GitHub's head/base want a bare branch name, never `refs/heads/`. */
function bareBranch(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}

/**
 * Groups a flat review-comment list into threads by resolved root id. Follows
 * `in_reply_to_id` to a root, so a reply-to-a-reply still lands in the right
 * thread. Comment order within a thread is preserved as GitHub returns it.
 */
function groupThreads(comments: ReviewComment[]): PrThread[] {
  const byId = new Map<number, ReviewComment>();
  for (const c of comments) byId.set(c.id, c);

  const rootOf = (comment: ReviewComment): number => {
    let current = comment;
    const seen = new Set<number>();
    while (current.in_reply_to_id !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.in_reply_to_id);
      if (parent === undefined) return current.in_reply_to_id; // parent outside the page
      current = parent;
    }
    return current.id;
  };

  const threads = new Map<number, PrThread>();
  const order: number[] = [];
  for (const comment of comments) {
    const root = rootOf(comment);
    let thread = threads.get(root);
    if (thread === undefined) {
      thread = { threadId: root, status: "active", comments: [] };
      threads.set(root, thread);
      order.push(root);
    }
    thread.comments.push({
      author: comment.user?.login ?? "",
      text: comment.body ?? "",
      at: comment.created_at ?? "",
    });
  }
  return order.map((root) => threads.get(root)!);
}
