import { z } from "zod";

/**
 * Zod shapes for the GitHub REST/GraphQL responses this adapter consumes.
 *
 * They are deliberately partial: only the fields the adapter reads are
 * declared, and unknown keys are allowed, so a GitHub API addition cannot
 * break the driver. Every response is parsed through these — an unvalidated
 * response is a hallucinated integration (insa-plani §6).
 */

/** GET /repos/{owner}/{repo} — the repository object. */
export const RepoResponse = z.looseObject({
  name: z.string().min(1),
  full_name: z.string().min(1).optional(),
  owner: z.looseObject({ login: z.string().min(1) }),
  default_branch: z.string().min(1).optional(),
});
export type RepoResponse = z.infer<typeof RepoResponse>;

/** GET /repos/{owner}/{repo}/git/ref/heads/{branch} — a single reference. */
export const GitRefResponse = z.looseObject({
  ref: z.string().min(1),
  node_id: z.string().min(1).optional(),
  object: z.looseObject({
    type: z.string().optional(),
    sha: z.string().min(1),
  }),
});
export type GitRefResponse = z.infer<typeof GitRefResponse>;

/** POST /repos/{owner}/{repo}/git/refs — the created reference (echoes GitRef). */
export const CreatedRefResponse = z.looseObject({
  ref: z.string().min(1),
  object: z.looseObject({ sha: z.string().min(1) }),
});
export type CreatedRefResponse = z.infer<typeof CreatedRefResponse>;

/**
 * Pull request object (create + get). `state` is only ever "open" | "closed";
 * `draft` splits an open PR into draft vs. active, and `merged` splits a
 * closed PR into completed vs. abandoned. `merge_commit_sha` is present on
 * closed PRs but MUST only be trusted when `merged` is true (see scm.ts).
 */
export const PullRequestResponse = z.looseObject({
  number: z.number().int().positive(),
  node_id: z.string().min(1),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  merge_commit_sha: z.string().nullable().optional(),
});
export type PullRequestResponse = z.infer<typeof PullRequestResponse>;

/**
 * A single pull request REVIEW comment (line-anchored). `in_reply_to_id`
 * chains a reply to the comment that started its thread; a comment with no
 * `in_reply_to_id` is itself a thread root.
 */
export const ReviewComment = z.looseObject({
  id: z.number().int(),
  in_reply_to_id: z.number().int().optional(),
  user: z.looseObject({ login: z.string().optional() }).nullable().optional(),
  body: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  path: z.string().optional(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

/** GET /repos/{owner}/{repo}/pulls/{n}/comments — the flat comment list. */
export const ReviewCommentsResponse = z.array(ReviewComment);
export type ReviewCommentsResponse = z.infer<typeof ReviewCommentsResponse>;

/** POST reply — the created review comment. */
export const CreatedReviewComment = z.looseObject({
  id: z.number().int(),
  in_reply_to_id: z.number().int().optional(),
  body: z.string().optional(),
});
export type CreatedReviewComment = z.infer<typeof CreatedReviewComment>;

/** GraphQL markPullRequestReadyForReview payload. */
export const MarkReadyResponse = z.looseObject({
  markPullRequestReadyForReview: z
    .looseObject({
      pullRequest: z.looseObject({
        number: z.number().int().optional(),
        isDraft: z.boolean().optional(),
      }),
    })
    .nullable(),
});
export type MarkReadyResponse = z.infer<typeof MarkReadyResponse>;

/**
 * GET /repos/{owner}/{repo}/commits/{sha}/check-runs — the CI checks for a
 * commit (B14). Only the fields the aggregate verdict needs are declared:
 * `status` (queued/in_progress/completed) and, once completed, `conclusion`
 * (success/failure/neutral/…). `name` is kept for the human-readable log line.
 */
export const CheckRunsResponse = z.looseObject({
  total_count: z.number().int(),
  check_runs: z.array(
    z.looseObject({
      name: z.string().optional(),
      status: z.string(),
      conclusion: z.string().nullable().optional(),
    }),
  ),
});
export type CheckRunsResponse = z.infer<typeof CheckRunsResponse>;

/** PUT /repos/{owner}/{repo}/pulls/{n}/merge — the merge result (B14). */
export const MergeResponse = z.looseObject({
  merged: z.boolean(),
  sha: z.string().min(1).optional(),
  message: z.string().optional(),
});
export type MergeResponse = z.infer<typeof MergeResponse>;
