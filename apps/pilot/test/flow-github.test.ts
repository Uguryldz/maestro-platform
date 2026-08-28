import { doc, paragraph } from "@maestro/adapter-jira";
import { afterEach, describe, expect, it } from "vitest";
import { bootPilot, type PilotStage } from "../src/boot.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExecRequest, ExecResult } from "../src/workspace.js";
import { IMPLEMENTATION_PATH, TEST_PATH } from "../src/workspace.js";
import { cloudFixture, waitFor } from "./helpers.js";

/**
 * OFFLINE end-to-end test of the PILOT_SCM=github path. Three transports are
 * stubbed and NOTHING touches the network or a real git:
 *   - Jira Cloud   → the same stateful REST stub the fake-ADO flow test uses.
 *   - GitHub REST  → a router that answers repo/ref/pulls/comments + graphql.
 *   - git          → a recording exec runner (no shell-out).
 *
 * It proves the real branch/PR path is exercised (real openPr POST to GitHub),
 * the engineer step issues the git SEQUENCE clone→…→push, the token never
 * appears on a git argv or in a log line, the push credential is short-lived,
 * and a push failure fails the run CLOSED (no PR).
 */

const OPERATOR = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";
const SITE = "https://uyildiz.atlassian.net";
const TOKEN = "ghp_super_secret_github_token_value_1234567890";

// ------------------------------------------------------------- stub model

function stubLlmFetch(_url: string, init?: RequestInit): Promise<Response> {
  const raw = typeof init?.body === "string" ? init.body : "";
  const messages = (JSON.parse(raw) as { messages: Array<{ content: string }> }).messages;
  const prompt = messages.map((m) => m.content).join("\n");
  let content = "{}";
  if (prompt.includes("Schema name: IntakeOutput")) {
    content = JSON.stringify({ complete: true, missing: [] });
  } else if (prompt.includes("Schema name: AnalysisDoc")) {
    content = JSON.stringify(analysisOutput);
  } else if (prompt.includes("Schema name: CodeDraft")) {
    content = JSON.stringify(codeDraft);
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

// Analyst output in the REAL `kurumsal-analiz` template shape (M108), section
// keyed, with a source row per claim section pointing at the ticket (the only
// reference the pilot's context carries today).
const TICKET_KEY = "OPS-6";
const analysisOutput = {
  riskTier: "dusuk",
  riskReason: "Yüzey sınırlı olduğundan risk düşük değerlendirildi.",
  clarificationsUsed: [],
  sections: {
    purpose:
      "İşlem onayında müşteriye makbuz e-postası gönderilecek. Böylece manuel makbuz talepleri azalacak.",
    scope: { included: ["Makbuz"], excluded: ["SMS makbuz"] },
    impactMatrix: [
      { appId: "ugurpay", impacted: true, summary: "Ödeme akışı makbuz tetikler.", source: "primary_repo_discovery" },
    ],
    acceptanceCriteria: ["Makbuz gider.", "Hatada gitmez.", "Audit kaydı yazılır."],
    uiApiChanges: [{ Yüzey: "POST /pay", Durum: "değişti", "Geriye uyum": "geriye uyumlu" }],
    testApproach:
      "Birim testleri makbuz kurallarını doğrular. Entegrasyon testi tetiği kontrol eder.",
    riskAndRollback: {
      risk: "Yanlış makbuz müşteriyi yanıltabilir.",
      mitigation: "Doğrulama testleri eklenir.",
      rollback: "Özellik bayrağı kapatılır.",
    },
    sources: [
      { section: "purpose", claim: "makbuz e-postası", kind: "ticket", ref: TICKET_KEY },
      { section: "scope", claim: "makbuz üretimi", kind: "ticket", ref: TICKET_KEY },
      { section: "impactMatrix", claim: "ödeme akışı etkileniyor", kind: "ticket", ref: TICKET_KEY },
      { section: "acceptanceCriteria", claim: "makbuz gider", kind: "ticket", ref: TICKET_KEY },
      { section: "uiApiChanges", claim: "onay ucu tetikler", kind: "ticket", ref: TICKET_KEY },
      { section: "testApproach", claim: "makbuz test edilir", kind: "ticket", ref: TICKET_KEY },
      { section: "riskAndRollback", claim: "yanlış makbuz riski", kind: "ticket", ref: TICKET_KEY },
    ],
    openItems: [],
  },
};

const codeDraft = {
  summary: "Makbuz modülü.",
  implementation: ["export function ok() {", "  return 'makbuz';", "}"].join("\n"),
  test: [
    "import assert from 'node:assert/strict';",
    "import { ok } from '../src/impl.mjs';",
    "assert.equal(ok(), 'makbuz');",
    "console.log('OK');",
  ].join("\n"),
};

// -------------------------------------------------------- stub Jira Cloud

function fakeJiraCloud(): { fetchImpl: (u: string, i?: RequestInit) => Promise<Response> } {
  const comments: Array<{ id: string; body: unknown }> = [];
  let nextId = 20000;
  let labels: string[] = [];
  const issue = cloudFixture("issue-get") as { fields: Record<string, unknown> } & Record<string, unknown>;
  const group = cloudFixture("group-member-by-name");

  const json = (status: number, body: unknown): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    });

  const fetchImpl = (rawUrl: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body: Record<string, unknown> =
      typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : {};

    if (path === "/rest/api/3/search/jql") return Promise.resolve(json(200, cloudFixture("search-jql")));
    if (path === "/rest/api/3/group/member") return Promise.resolve(json(200, group));
    if (path === "/rest/api/3/issue/OPS-6" && method === "GET") {
      if (url.searchParams.get("fields") === "labels") return Promise.resolve(json(200, { fields: { labels } }));
      return Promise.resolve(json(200, issue));
    }
    if (path === "/rest/api/3/issue/OPS-6" && method === "PUT") {
      const update = body["update"] as { labels?: Array<Record<string, string>> } | undefined;
      for (const op of update?.labels ?? []) {
        if (op["add"]) labels = [...new Set([...labels, op["add"]])];
      }
      return Promise.resolve(json(204, undefined));
    }
    // Attachment upload (M103r) — this fake refuses it (500). The run must still
    // finish: attaching is fail-soft, proven here in a REAL run, not just a unit.
    if (path === "/rest/api/3/issue/OPS-6/attachments" && method === "POST") {
      return Promise.resolve(json(500, { errorMessages: ["attachment store offline"] }));
    }
    if (path === "/rest/api/3/issue/OPS-6/comment" && method === "POST") {
      const id = String(nextId++);
      comments.push({ id, body: body["body"] });
      return Promise.resolve(json(201, { id }));
    }
    if (/^\/rest\/api\/3\/issue\/OPS-6\/comment\/\d+$/.test(path) && method === "PUT") {
      return Promise.resolve(json(200, { id: path.split("/").pop() }));
    }
    if (path === "/rest/api/3/issue/OPS-6/comment" && method === "GET") {
      const approve = {
        id: String(nextId++), // her listelemede TAZE komut — kapı tabanı (stale-guard) eskisini eler
        author: { accountId: OPERATOR },
        body: doc(paragraph("/approve")),
        created: "2026-08-10T15:00:00.000+0300",
        updated: "2026-08-10T15:00:00.000+0300",
      };
      const marker = { created: "2026-08-10T14:59:00.000+0300", updated: "2026-08-10T14:59:00.000+0300", author: { accountId: "maestro-app" } };
      return Promise.resolve(json(200, { comments: [...comments.map((c) => ({ ...c, ...marker })), approve] }));
    }
    throw new Error(`unexpected Jira call: ${method} ${path}`);
  };
  return { fetchImpl };
}

// ------------------------------------------------------------ stub GitHub

interface GithubStub {
  fetchImpl: (u: string, i?: RequestInit) => Promise<Response>;
  calls: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
}

function fakeGithub(): GithubStub {
  const calls: GithubStub["calls"] = [];
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (rawUrl: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body: unknown =
      typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, headers: { ...((init?.headers ?? {}) as Record<string, string>) }, body });

    if (path.endsWith("/graphql")) {
      return Promise.resolve(
        json(200, { data: { markPullRequestReadyForReview: { pullRequest: { number: 77, isDraft: false } } } }),
      );
    }
    // GET /repos/{owner}/{repo}
    if (/\/repos\/[^/]+\/[^/]+$/.test(path) && method === "GET") {
      return Promise.resolve(json(200, { name: "ugurpay", owner: { login: "ugurbank" }, default_branch: "main" }));
    }
    // GET .../git/ref/heads/main
    if (path.includes("/git/ref/") && method === "GET") {
      return Promise.resolve(json(200, { ref: "refs/heads/main", object: { type: "commit", sha: "f".repeat(40) } }));
    }
    // POST .../git/refs
    if (path.endsWith("/git/refs") && method === "POST") {
      const ref = (body as { ref: string }).ref;
      return Promise.resolve(json(201, { ref, object: { sha: "f".repeat(40) } }));
    }
    // POST .../pulls
    if (path.endsWith("/pulls") && method === "POST") {
      return Promise.resolve(json(201, { number: 77, node_id: "PR_kw1", state: "open", draft: true }));
    }
    // GET .../pulls/77
    if (/\/pulls\/77$/.test(path) && method === "GET") {
      return Promise.resolve(json(200, { number: 77, node_id: "PR_kw1", state: "open", draft: false }));
    }
    // GET .../pulls/77/comments
    if (/\/pulls\/77\/comments$/.test(path) && method === "GET") {
      return Promise.resolve(json(200, []));
    }
    // GET .../commits/{sha}/check-runs — real CI (B14). One completed, passing
    // check, so the pilot's awaitRealCi sees green on the first poll.
    if (path.includes("/check-runs") && method === "GET") {
      return Promise.resolve(
        json(200, { total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion: "success" }] }),
      );
    }
    // PUT .../pulls/77/merge — real merge (B14, auto-merge armed).
    if (/\/pulls\/77\/merge$/.test(path) && method === "PUT") {
      return Promise.resolve(json(200, { merged: true, sha: "c".repeat(40) }));
    }
    throw new Error(`unexpected GitHub call: ${method} ${path}`);
  };
  return { fetchImpl, calls };
}

// -------------------------------------------------------------- git exec

interface ExecStub {
  exec: (req: ExecRequest) => Promise<ExecResult>;
  git: ExecRequest[];
  failPush: boolean;
  /** cwd of the `git add` step — where the diff is staged from (the clone). */
  addCwd: string | null;
  /** true iff the impl file existed on disk under the `git add` cwd. */
  implInClone: boolean;
  /** true iff the test file existed on disk under the node-test cwd. */
  testInClone: boolean;
  /** cwd the generated node test ran in (must be the clone on the github path). */
  testCwd: string | null;
}

function recordingExec(): ExecStub {
  const git: ExecRequest[] = [];
  const stub: ExecStub = {
    git,
    failPush: false,
    addCwd: null,
    implInClone: false,
    testInClone: false,
    testCwd: null,
    exec: (req: ExecRequest): Promise<ExecResult> => {
      // The node test run still goes through this runner; only record git.
      if (req.file === "git") {
        git.push(req);
        // The whole fix: when git stages the diff, the model's file must ALREADY
        // exist under the git working directory (the clone). Prove it on disk.
        if (req.args[0] === "add") {
          stub.addCwd = req.cwd;
          stub.implInClone = existsSync(join(req.cwd, IMPLEMENTATION_PATH));
        }
        if (stub.failPush && req.args[0] === "push") {
          return Promise.resolve({ ok: false, exitCode: 128, stderr: "remote rejected", stdout: "" });
        }
        const sha = "a".repeat(40);
        return Promise.resolve({
          ok: true,
          exitCode: 0,
          stdout: req.args[0] === "rev-parse" ? `${sha}\n` : "",
          stderr: "",
        });
      }
      // The generated test really runs (proves the test gate stays real). It must
      // run in the clone, where the code and test files were written.
      stub.testCwd = req.cwd;
      stub.testInClone = existsSync(join(req.cwd, TEST_PATH));
      return Promise.resolve({ ok: true, exitCode: 0, stdout: "OK", stderr: "" });
    },
  };
  return stub;
}

// ----------------------------------------------------------------- test

describe("pilot github SCM path — gerçek dal/PR + gerçek git push (offline)", () => {
  let stage: PilotStage | null = null;
  afterEach(async () => {
    if (stage) await stage.close();
    stage = null;
  });

  it("intake→push→PR: git SEQUENCE issued, real PR opened, token never leaks", async () => {
    const logs: string[] = [];
    const exec = recordingExec();
    const github = fakeGithub();
    // Rebuild boot with a shared github stub so we can inspect its calls.
    stage = await bootPilot({
      env: {},
      uiPort: 0,
      adoPort: 0,
      scm: "github",
      openRouter: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
      jiraCloud: { baseUrl: SITE, email: "pilot@bank.example", apiToken: "api-token-123" },
      github: {
        owner: "ugurbank",
        repo: "ugurpay",
        token: TOKEN,
        apiBaseUrl: "https://api.github.com",
        graphqlUrl: "https://api.github.com/graphql",
        gitBaseUrl: "https://github.com",
      },
      githubFetch: github.fetchImpl,
      llmFetch: stubLlmFetch,
      jiraFetch: fakeJiraCloud().fetchImpl,
      workspaceOptions: { exec: exec.exec },
      buildDelayMs: 20,
      ciTimeoutMs: 15_000,
      commandPollMs: 20,
      // B14: arm auto-merge so this end-to-end exercises the REAL merge path
      // (real CI green → gate approved → Maestro merges via PUT .../merge).
      autoMerge: true,
    });
    const orig = stage.store.log.bind(stage.store);
    stage.store.log = (level, line) => {
      logs.push(line);
      orig(level, line);
    };

    const running = stage.start("OPS-6");
    const reached = (gate: string): boolean => {
      const s = stage!.store.snapshot();
      return s.awaitingGate === gate || s.finished || s.failure !== null;
    };
    await waitFor(() => reached("3"), 20_000, "analiz kapısı");
    await waitFor(() => reached("8"), 30_000, "PR kapısı");
    await running;

    const s = stage.store.snapshot();
    expect(s.failure).toBeNull();
    expect(s.finished).toBe(true);

    // The git sequence really ran, in order: clone FIRST (before the code is
    // written), then the rest AFTER the code lands in the clone.
    expect(exec.git.map((c) => c.args[0])).toEqual([
      "clone",
      "checkout",
      "add",
      "commit",
      "push",
      "rev-parse",
    ]);

    // THE FIX, proven end-to-end: the model's file was written INTO the git
    // working tree (the clone dir), so `git add` saw a real diff. The
    // "nothing to commit, working tree clean" bug was exactly the code landing
    // OUTSIDE the clone. The add step and the node test both ran in the clone.
    const cloneDir = join(exec.git[0]!.cwd, "repo");
    expect(exec.addCwd).toBe(cloneDir);
    expect(exec.testCwd).toBe(cloneDir);
    expect(exec.implInClone).toBe(true);
    expect(exec.testInClone).toBe(true);
    // A REAL PR was POSTed to GitHub.
    const prPost = github.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"));
    expect(prPost).toBeDefined();
    expect((prPost!.body as { head: string }).head).toBe("feature/OPS-6");

    // The token never appears on a git argv, nor in any log line.
    for (const call of exec.git) expect(call.args.join(" ")).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);

    // The token DID ride the git env (as the ephemeral extraHeader) — proving
    // the push was actually authenticated out-of-band.
    const push = exec.git.find((c) => c.args[0] === "push")!;
    const header = push.env?.["GIT_CONFIG_VALUE_0"] ?? "";
    const b64 = header.split(" ").pop() ?? "";
    expect(Buffer.from(b64, "base64").toString("utf8")).toContain(TOKEN);
  }, 90_000);

  it("push failure fails the run CLOSED — no PR opened", async () => {
    const logs: string[] = [];
    const exec = recordingExec();
    exec.failPush = true;
    const github = fakeGithub();
    stage = await bootPilot({
      env: {},
      uiPort: 0,
      adoPort: 0,
      scm: "github",
      openRouter: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
      jiraCloud: { baseUrl: SITE, email: "pilot@bank.example", apiToken: "api-token-123" },
      github: {
        owner: "ugurbank",
        repo: "ugurpay",
        token: TOKEN,
        apiBaseUrl: "https://api.github.com",
        graphqlUrl: "https://api.github.com/graphql",
        gitBaseUrl: "https://github.com",
      },
      githubFetch: github.fetchImpl,
      llmFetch: stubLlmFetch,
      jiraFetch: fakeJiraCloud().fetchImpl,
      workspaceOptions: { exec: exec.exec },
      buildDelayMs: 20,
      ciTimeoutMs: 15_000,
      commandPollMs: 20,
    });
    const orig = stage.store.log.bind(stage.store);
    stage.store.log = (level, line) => {
      logs.push(line);
      orig(level, line);
    };

    const running = stage.start("OPS-6");
    const done = (): boolean => {
      const s = stage!.store.snapshot();
      return s.failure !== null || s.finished;
    };
    const reached3 = (): boolean => stage!.store.snapshot().awaitingGate === "3" || done();
    await waitFor(reached3, 20_000, "analiz kapısı");
    await waitFor(done, 30_000, "sonuç");
    await running;

    const s = stage.store.snapshot();
    expect(s.failure).not.toBeNull();
    expect(s.finished).toBe(false);
    // No PR was ever POSTed — the push failed first.
    expect(github.calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toBe(false);
    // The token never leaked into the failure log.
    expect(logs.join("\n")).not.toContain(TOKEN);
  }, 90_000);
});
