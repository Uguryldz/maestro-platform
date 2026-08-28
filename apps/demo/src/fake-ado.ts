import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CORS_HEADERS, headerValue, readRawBody, requestUrl, sendJson, sendText } from "./http.js";

/**
 * A stand-in for Azure DevOps Services, serving the REST paths
 * `@maestro/adapter-ado` calls (repository, refs, pull requests, threads) with
 * bodies shaped like `packages/adapter-ado/test/fixtures`. It also plays the
 * Service Hook publisher: after a pull request leaves draft state it posts a
 * `build.complete` event with basic auth, `reason: "pullRequest"` and the
 * allow-listed definition id, so the CI driver's provenance gate is really
 * exercised rather than bypassed.
 *
 * DEMO PROP: in-memory, throwaway PAT, never deployed.
 */

export interface FakeAdoOptions {
  org: string;
  project: string;
  repo: string;
  /** PAT the adapter presents as `Basic base64(":" + pat)`. */
  pat: string;
  /** Basic-auth credential of the Service Hook subscription. */
  webhookUsername: string;
  webhookSecret: string;
  /** Where `build.complete` is delivered; a function so ports may bind later. */
  webhookUrl: () => string | null;
  /** Allow-listed PR validation build definition (M12). */
  definitionId: number;
  /** Delay before the build result arrives, in ms. */
  buildDelayMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export interface FakePullRequest {
  pullRequestId: number;
  status: "active" | "completed" | "abandoned";
  isDraft: boolean;
  title: string;
  description: string;
  sourceRefName: string;
  targetRefName: string;
  mergeCommitId: string | null;
  createdAt: string;
}

export interface FakeAdo {
  server: Server;
  /** Simulates a human pressing "Complete" in the ADO pull request screen. */
  completePullRequest(prId: number): boolean;
  pullRequests(): FakePullRequest[];
  branches(): string[];
  webhookErrors: string[];
}

const MAIN_SHA = "9c1e5a3b7d2f4068a1b3c5d7e9f0a2b4c6d8e0f1";
const HEAD_SHA = "b7a41f3c9d825e0641a2b3c4d5e6f708192a3b4c";
const MERGE_SHA = "d3f9a172c48b5e60a7d1c2b3e4f5061728394a5b";

export function createFakeAdo(options: FakeAdoOptions): FakeAdo {
  const now = options.now ?? ((): Date => new Date());
  const expectedAuth = `Basic ${Buffer.from(`:${options.pat}`, "utf8").toString("base64")}`;
  const webhookErrors: string[] = [];

  const refs = new Map<string, string>([["refs/heads/main", MAIN_SHA]]);
  const prs = new Map<number, FakePullRequest>();
  const threads = new Map<number, Array<Record<string, unknown>>>();
  let nextPrId = 128;
  let nextBuildId = 4711;
  let nextCommentId = 3;
  let base = "http://127.0.0.1";

  function prJson(pr: FakePullRequest): Record<string, unknown> {
    return {
      repository: {
        id: "5f8c3a1e-9b2d-4c7a-8e11-2b6d4f0a9c33",
        name: options.repo,
        project: { id: "1c9f2b77-3d64-45e0-9a2b-7f4c6d81ea05", name: options.project },
      },
      pullRequestId: pr.pullRequestId,
      codeReviewId: pr.pullRequestId,
      status: pr.status,
      creationDate: pr.createdAt,
      title: pr.title,
      description: pr.description,
      sourceRefName: pr.sourceRefName,
      targetRefName: pr.targetRefName,
      mergeStatus: "succeeded",
      isDraft: pr.isDraft,
      ...(pr.mergeCommitId === null ? {} : { lastMergeCommit: { commitId: pr.mergeCommitId } }),
      url: `${base}/${options.org}/${options.project}/_apis/git/repositories/${options.repo}/pullRequests/${pr.pullRequestId}`,
    };
  }

  /** Post the `build.complete` Service Hook for a PR validation build. */
  function emitBuildComplete(pr: FakePullRequest): void {
    const target = options.webhookUrl();
    if (target === null) return;
    const finished = now().toISOString().replace(/Z$/, "0000Z");
    const buildId = nextBuildId++;
    const payload = {
      subscriptionId: "7f6a2b91-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
      notificationId: 17,
      id: "e1a2b3c4-d5e6-4f70-8192-a3b4c5d6e7f8",
      eventType: "build.complete",
      publisherId: "tfs",
      message: { text: `Build ${buildId} succeeded` },
      resource: {
        _links: { web: { href: `${base}/${options.org}/${options.project}/_build/results?buildId=${buildId}` } },
        id: buildId,
        buildNumber: `${buildId}`,
        status: "completed",
        result: "succeeded",
        finishTime: finished,
        definition: { id: options.definitionId, name: `${options.repo}-pr-validation`, type: "build" },
        project: { id: "1c9f2b77-3d64-45e0-9a2b-7f4c6d81ea05", name: options.project },
        reason: "pullRequest",
        sourceBranch: `refs/pull/${pr.pullRequestId}/merge`,
        sourceVersion: HEAD_SHA,
        triggerInfo: {
          "pr.number": String(pr.pullRequestId),
          "pr.sourceBranch": pr.sourceRefName,
          "pr.sourceSha": HEAD_SHA,
          "pr.targetBranch": pr.targetRefName,
        },
        repository: { id: "5f8c3a1e-9b2d-4c7a-8e11-2b6d4f0a9c33", type: "TfsGit", name: options.repo },
      },
      resourceVersion: "2.0",
      createdDate: finished,
    };
    const authorization = `Basic ${Buffer.from(
      `${options.webhookUsername}:${options.webhookSecret}`,
      "utf8",
    ).toString("base64")}`;
    setTimeout(() => {
      void fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify(payload),
      })
        .then(async (response) => {
          if (!response.ok) webhookErrors.push(`service hook ${response.status}: ${await response.text()}`);
        })
        .catch((error: unknown) => {
          webhookErrors.push(String(error));
          options.onError?.(error);
        });
    }, options.buildDelayMs ?? 1_200);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      options.onError?.(error);
      sendJson(res, 500, { message: String(error) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = requestUrl(req);
    const method = req.method ?? "GET";
    base = `http://${req.headers.host ?? "127.0.0.1"}`;

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (url.pathname === "/_demo/state" && method === "GET") {
      sendJson(res, 200, { pullRequests: [...prs.values()], branches: [...refs.keys()] }, CORS_HEADERS);
      return;
    }

    const prefix = `/${options.org}/${options.project}/_apis/`;
    if (!url.pathname.startsWith(prefix)) {
      sendText(res, 404, "not found");
      return;
    }
    if (headerValue(req, "authorization") !== expectedAuth) {
      // Real ADO answers an unauthenticated API call with a sign-in page and a
      // 203; a 401 is the honest shape for a prop, and the client handles both.
      sendJson(res, 401, { message: "invalid personal access token" });
      return;
    }

    const rest = url.pathname.slice(prefix.length);
    const raw = method === "GET" ? "" : await readRawBody(req);
    const body: unknown = raw.length > 0 ? JSON.parse(raw) : null;
    const repoPrefix = `git/repositories/${options.repo}`;

    if (rest === `git/repositories/${options.repo}` && method === "GET") {
      sendJson(res, 200, {
        id: "5f8c3a1e-9b2d-4c7a-8e11-2b6d4f0a9c33",
        name: options.repo,
        url: `${base}${prefix}git/repositories/${options.repo}`,
        project: {
          id: "1c9f2b77-3d64-45e0-9a2b-7f4c6d81ea05",
          name: options.project,
          state: "wellFormed",
          visibility: "private",
        },
        defaultBranch: "refs/heads/main",
        size: 8231774,
        remoteUrl: `${base}/${options.org}/${options.project}/_git/${options.repo}`,
        webUrl: `${base}/${options.org}/${options.project}/_git/${options.repo}`,
        isDisabled: false,
      });
      return;
    }

    if (rest === `${repoPrefix}/refs`) {
      if (method === "GET") {
        const filter = url.searchParams.get("filter");
        const wanted = filter === null ? null : `refs/${filter}`;
        const value = [...refs.entries()]
          .filter(([name]) => wanted === null || name === wanted)
          .map(([name, objectId]) => ({
            name,
            objectId,
            url: `${base}${prefix}${repoPrefix}/${name}`,
          }));
        sendJson(res, 200, { value, count: value.length });
        return;
      }
      if (method === "POST" && Array.isArray(body)) {
        const value = (body as Array<Record<string, unknown>>).map((update) => {
          const name = String(update["name"] ?? "");
          const newObjectId = String(update["newObjectId"] ?? "");
          const exists = refs.has(name);
          if (!exists) refs.set(name, newObjectId);
          return {
            repositoryId: "5f8c3a1e-9b2d-4c7a-8e11-2b6d4f0a9c33",
            name,
            oldObjectId: String(update["oldObjectId"] ?? ""),
            newObjectId,
            isLocked: false,
            updateStatus: exists ? "referenceAlreadyExists" : "succeeded",
            success: !exists,
          };
        });
        sendJson(res, 200, { count: value.length, value });
        return;
      }
    }

    if (rest === `${repoPrefix}/pullrequests` && method === "POST") {
      const input = (body ?? {}) as Record<string, unknown>;
      const pr: FakePullRequest = {
        pullRequestId: nextPrId++,
        status: "active",
        isDraft: input["isDraft"] === true,
        title: String(input["title"] ?? ""),
        description: String(input["description"] ?? ""),
        sourceRefName: String(input["sourceRefName"] ?? ""),
        targetRefName: String(input["targetRefName"] ?? "refs/heads/main"),
        mergeCommitId: null,
        createdAt: now().toISOString(),
      };
      if (!refs.has(pr.sourceRefName)) {
        sendJson(res, 404, { message: `source branch ${pr.sourceRefName} does not exist` });
        return;
      }
      prs.set(pr.pullRequestId, pr);
      threads.set(pr.pullRequestId, []);
      sendJson(res, 201, prJson(pr));
      if (!pr.isDraft) emitBuildComplete(pr);
      return;
    }

    const prMatch = new RegExp(`^${repoPrefix}/pullrequests/(\\d+)(?:/(.*))?$`).exec(rest);
    if (prMatch) {
      const pr = prs.get(Number(prMatch[1]));
      if (!pr) {
        sendJson(res, 404, { message: `pull request ${prMatch[1]} not found` });
        return;
      }
      const tail = prMatch[2] ?? "";

      if (tail === "" && method === "GET") {
        sendJson(res, 200, prJson(pr));
        return;
      }
      if (tail === "" && method === "PATCH") {
        const input = (body ?? {}) as Record<string, unknown>;
        const leftDraft = pr.isDraft && input["isDraft"] === false;
        if (typeof input["isDraft"] === "boolean") pr.isDraft = input["isDraft"];
        sendJson(res, 200, prJson(pr));
        // Leaving draft is what makes the branch policy queue the validation
        // build in a real deployment, so that is where the hook fires here too.
        if (leftDraft) emitBuildComplete(pr);
        return;
      }
      if (tail === "threads" && method === "GET") {
        const value = threads.get(pr.pullRequestId) ?? [];
        sendJson(res, 200, { value, count: value.length });
        return;
      }
      const commentMatch = /^threads\/(\d+)\/comments$/.exec(tail);
      if (commentMatch && method === "POST") {
        const input = (body ?? {}) as Record<string, unknown>;
        const thread = (threads.get(pr.pullRequestId) ?? []).find(
          (candidate) => candidate["id"] === Number(commentMatch[1]),
        );
        if (!thread) {
          sendJson(res, 404, { message: `thread ${commentMatch[1]} not found` });
          return;
        }
        const comment = {
          id: nextCommentId++,
          parentCommentId: Number(input["parentCommentId"] ?? 1),
          author: { displayName: "Maestro Service", uniqueName: "maestro-svc@ugurbank.local" },
          content: String(input["content"] ?? ""),
          publishedDate: now().toISOString(),
          commentType: String(input["commentType"] ?? "text"),
          isDeleted: false,
        };
        (thread["comments"] as Array<Record<string, unknown>>).push(comment);
        sendJson(res, 200, comment);
        return;
      }
    }

    sendJson(res, 404, { message: `no fake ADO route for ${method} ${url.pathname}` });
  }

  return {
    server,
    completePullRequest(prId: number): boolean {
      const pr = prs.get(prId);
      if (!pr || pr.status !== "active") return false;
      pr.status = "completed";
      pr.mergeCommitId = MERGE_SHA;
      return true;
    },
    pullRequests: () => [...prs.values()],
    branches: () => [...refs.keys()],
    webhookErrors,
  };
}
