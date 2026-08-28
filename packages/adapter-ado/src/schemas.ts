import { z } from "zod";

/**
 * Zod shapes for the ADO REST responses this adapter consumes.
 *
 * They are deliberately partial: only the fields the adapter reads are
 * declared, and unknown keys are allowed, so an ADO upgrade that adds
 * fields cannot break the driver. Every response is parsed through these —
 * an unvalidated response is a hallucinated integration (insa-plani §6).
 */

export const RepoResponse = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  project: z.looseObject({ name: z.string().min(1) }),
  defaultBranch: z.string().min(1).optional(),
  remoteUrl: z.string().optional(),
});
export type RepoResponse = z.infer<typeof RepoResponse>;

export const RefsListResponse = z.looseObject({
  count: z.number().int().nonnegative().optional(),
  value: z.array(z.looseObject({ name: z.string().min(1), objectId: z.string().min(1) })),
});

export const RefUpdateResponse = z.looseObject({
  value: z.array(
    z.looseObject({
      name: z.string().min(1),
      newObjectId: z.string().min(1),
      success: z.boolean(),
      updateStatus: z.string().optional(),
    }),
  ),
});

/** Pull request states as ADO reports them; "notSet" means "never opened". */
export const AdoPrStatus = z.enum(["notSet", "active", "completed", "abandoned", "all"]);

export const PullRequestResponse = z.looseObject({
  pullRequestId: z.number().int().positive(),
  status: AdoPrStatus,
  isDraft: z.boolean().optional(),
  sourceRefName: z.string().optional(),
  targetRefName: z.string().optional(),
  lastMergeCommit: z.looseObject({ commitId: z.string() }).optional(),
});
export type PullRequestResponse = z.infer<typeof PullRequestResponse>;

/** Comment thread status; system threads (votes, policies) carry none. */
export const AdoThreadStatus = z.enum([
  "unknown",
  "active",
  "fixed",
  "wontFix",
  "closed",
  "byDesign",
  "pending",
]);
export type AdoThreadStatus = z.infer<typeof AdoThreadStatus>;

export const ThreadComment = z.looseObject({
  id: z.number().int(),
  parentCommentId: z.number().int().optional(),
  author: z.looseObject({ displayName: z.string().optional(), uniqueName: z.string().optional() }).optional(),
  content: z.string().optional(),
  publishedDate: z.string().optional(),
  lastUpdatedDate: z.string().optional(),
  commentType: z.string().optional(),
  isDeleted: z.boolean().optional(),
});
export type ThreadComment = z.infer<typeof ThreadComment>;

export const Thread = z.looseObject({
  id: z.number().int(),
  status: AdoThreadStatus.optional(),
  isDeleted: z.boolean().optional(),
  publishedDate: z.string().optional(),
  comments: z.array(ThreadComment).optional(),
});
export type Thread = z.infer<typeof Thread>;

export const ThreadsListResponse = z.looseObject({
  count: z.number().int().nonnegative().optional(),
  value: z.array(Thread),
});

export const CreatedCommentResponse = z.looseObject({
  id: z.number().int(),
  content: z.string().optional(),
});

/**
 * Service Hook envelope. Both deployment modes post the same envelope; only
 * `resource` differs in detail, and `publisherId` is absent on some older
 * Server payloads, hence optional.
 */
export const ServiceHookEnvelope = z.looseObject({
  eventType: z.string().min(1),
  publisherId: z.string().optional(),
  id: z.string().optional(),
  createdDate: z.string().optional(),
  resource: z.unknown(),
  resourceContainers: z.unknown().optional(),
});
export type ServiceHookEnvelope = z.infer<typeof ServiceHookEnvelope>;

/**
 * `build.complete` resource — the subset the CI signal needs (M12/M13).
 *
 * `reason`, `definition`, `project` and `repository` are the provenance of
 * the verdict: without them any queued build could answer for the PR. They
 * stay optional here (a foreign payload must not throw) and are demanded by
 * the gate in `ci.ts`, which drops the event when they are absent.
 */
export const BuildCompleteResource = z.looseObject({
  id: z.number().int().positive(),
  buildNumber: z.string().optional(),
  status: z.string().optional(),
  result: z.string().optional(),
  /** Why the build ran: only "pullRequest" is a branch-policy validation build. */
  reason: z.string().optional(),
  definition: z.looseObject({ id: z.number().int().positive(), name: z.string().optional() }).optional(),
  project: z.looseObject({ name: z.string().min(1), id: z.string().optional() }).optional(),
  repository: z.looseObject({ name: z.string().min(1), id: z.string().optional() }).optional(),
  sourceBranch: z.string().optional(),
  sourceGetVersion: z.string().optional(),
  finishTime: z.string().optional(),
  lastChangedDate: z.string().optional(),
  triggerInfo: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  _links: z.looseObject({ web: z.looseObject({ href: z.string() }).optional() }).optional(),
});
export type BuildCompleteResource = z.infer<typeof BuildCompleteResource>;
