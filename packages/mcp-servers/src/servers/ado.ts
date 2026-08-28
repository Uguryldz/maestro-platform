import { AppId } from "@maestro/contracts";
import type { ApplicationRecord } from "@maestro/contracts";
import type { RepoRef, ScmPort } from "@maestro/ports";
import { z } from "zod";
import { defineServer, defineTool, type ServerDefinition } from "../tool.js";

/** A unified diff, chunked so a single tool result cannot swallow the context window. */
export interface PrDiff {
  readonly prId: number;
  readonly files: readonly { path: string; status: string; additions: number; deletions: number }[];
  readonly patch: string;
  readonly truncated: boolean;
}

/** Diff reading, absent from `ScmPort` today — DI seam, port extension requested in RAPOR.md. */
export interface AdoDiffAccess {
  getPrDiff(repo: RepoRef, prId: number, maxBytes: number): Promise<PrDiff>;
}

/**
 * The application registry lookup (M100). Passed in rather than imported so
 * this server never learns where the registry lives.
 */
export interface ApplicationLookup {
  getApplication(appId: string): Promise<ApplicationRecord>;
}

export interface AdoMcpDeps {
  readonly scm: ScmPort;
  readonly apps: ApplicationLookup;
  readonly diffs: AdoDiffAccess;
}

const MAX_DIFF_BYTES = 256 * 1024;
const MAX_REPLY_CHARS = 4000;

/**
 * `ado-mcp` — repository and pull-request access for an agent session (M37).
 *
 * Reads are broad; there is exactly ONE write, `reply_thread`, and it exists
 * for the 12b loop: a reviewer asks for a change, the session makes it, and
 * the session answers in the thread it was asked in. Anything else that
 * changes the repository's state — creating the branch, opening the PR,
 * activating it out of draft, and above all merging — belongs to workflow
 * activities that run under the worker's identity after a human gate.
 *
 * `merge_pr` is absent on purpose; see `src/forbidden-tools.ts`.
 */
export function adoMcpServer(deps: AdoMcpDeps): ServerDefinition {
  const repoOf = async (appId: string): Promise<RepoRef> =>
    deps.scm.resolveRepo(await deps.apps.getApplication(appId));

  return defineServer({
    name: "ado-mcp",
    version: "0.1.0",
    description: "Azure DevOps repository, pull request and review-thread access for the session.",
    tools: [
      defineTool({
        name: "get_repo",
        description: "Resolve an application id to its Azure DevOps project/repository pair.",
        scope: "read",
        input: z.object({ appId: AppId }),
        subject: (args) => args.appId,
        handler: async (args) => repoOf(args.appId),
      }),
      defineTool({
        name: "get_pr_status",
        description: "State of a pull request (draft/active/completed/abandoned) and its merge commit if any.",
        scope: "read",
        input: z.object({ appId: AppId, prId: z.number().int().positive() }),
        subject: (args) => `${args.appId}#${args.prId}`,
        handler: async (args) => deps.scm.getPrStatus(await repoOf(args.appId), args.prId),
      }),
      defineTool({
        name: "list_pr_threads",
        description:
          "Review threads on a pull request with their comments and status — the input of the 12b rework loop.",
        scope: "read",
        input: z.object({ appId: AppId, prId: z.number().int().positive() }),
        subject: (args) => `${args.appId}#${args.prId}`,
        handler: async (args) => deps.scm.listPrThreads(await repoOf(args.appId), args.prId),
      }),
      defineTool({
        name: "get_pr_diff",
        description: "Unified diff of a pull request, truncated at a byte budget rather than silently cut.",
        scope: "read",
        input: z.object({
          appId: AppId,
          prId: z.number().int().positive(),
          maxBytes: z.number().int().positive().max(MAX_DIFF_BYTES).default(MAX_DIFF_BYTES),
        }),
        subject: (args) => `${args.appId}#${args.prId}`,
        handler: async (args) => deps.diffs.getPrDiff(await repoOf(args.appId), args.prId, args.maxBytes),
      }),
      defineTool({
        // The one write. Answering a reviewer is part of doing the work; it
        // decides nothing and closes no gate.
        name: "reply_thread",
        description: "Reply to a pull-request review thread (step 12b — answering a reviewer's request).",
        scope: "operate",
        input: z.object({
          appId: AppId,
          prId: z.number().int().positive(),
          threadId: z.number().int().positive(),
          text: z.string().trim().min(1).max(MAX_REPLY_CHARS),
        }),
        subject: (args) => `${args.appId}#${args.prId}/thread-${args.threadId}`,
        handler: async (args) => {
          await deps.scm.replyThread(await repoOf(args.appId), args.prId, args.threadId, args.text);
          return { replied: true, threadId: args.threadId };
        },
      }),
    ],
  });
}
