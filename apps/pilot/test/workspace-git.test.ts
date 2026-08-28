import { describe, expect, it } from "vitest";
import {
  buildGitClonePlan,
  buildGitCommitPushPlan,
  createWorkspace,
  GitStepError,
  IMPLEMENTATION_PATH,
  REPO_DIR_NAME,
  type ExecRequest,
  type ExecResult,
  type GitCloneArgs,
  type GitCommitPushArgs,
} from "../src/workspace.js";

/**
 * OFFLINE unit tests for the github git path. Nothing shells out: a stubbed
 * exec runner records every command. The path is split in two halves that
 * bracket the code write:
 *   gitClone       → clone→branch (BEFORE the code is written into the clone)
 *   gitCommitPush  → add→commit→push→rev-parse (AFTER the code is written)
 * The whole point of the split is that the code files land INSIDE the git
 * working tree, so `git add` sees a real diff — otherwise the clone is empty and
 * git reports "nothing to commit, working tree clean". The tests also prove the
 * token is fed to git ONLY through the environment (never on an argv, never in
 * the remote URL), and that a non-zero git step fails CLOSED.
 */

const TOKEN = "ghs-super-secret-token-value";
const CLONE_ARGS: GitCloneArgs = {
  remoteUrl: "https://github.com/ugurbank/ugurpay.git",
  branch: "feature/OPS-6",
  baseBranch: "main",
  token: TOKEN,
  authorName: "Maestro AI",
  authorEmail: "maestro@ugurbank.example",
};
const COMMIT_PUSH_ARGS: GitCommitPushArgs = {
  branch: "feature/OPS-6",
  commitSubject: "[AI] OPS-6 makbuz modülü",
  coAuthor: "Co-Authored-By: Maestro <maestro@ugurbank.example>",
  token: TOKEN,
  authorName: "Maestro AI",
  authorEmail: "maestro@ugurbank.example",
};

/** Records exec requests and replies OK (or a scripted failure at one step). */
function recordingExec(failAt?: (req: ExecRequest) => boolean): {
  exec: (req: ExecRequest) => Promise<ExecResult>;
  calls: ExecRequest[];
} {
  const calls: ExecRequest[] = [];
  const exec = (req: ExecRequest): Promise<ExecResult> => {
    calls.push(req);
    if (failAt?.(req)) {
      return Promise.resolve({ ok: false, exitCode: 1, stdout: "", stderr: "boom" });
    }
    const isRevParse = req.args[0] === "rev-parse";
    return Promise.resolve({
      ok: true,
      exitCode: 0,
      stdout: isRevParse ? "abc123def456abc123def456abc123def456abcd\n" : "",
      stderr: "",
    });
  };
  return { exec, calls };
}

describe("buildGitClonePlan", () => {
  it("emits clone→checkout in order (the pre-write half)", () => {
    const plan = buildGitClonePlan(CLONE_ARGS);
    const verbs = plan.steps.map((s) => s.args[0]);
    expect(verbs).toEqual(["clone", "checkout"]);
  });

  it("clones into ./repo from the parent, then branches inside the repo", () => {
    const plan = buildGitClonePlan(CLONE_ARGS);
    expect(plan.repoDirName).toBe(REPO_DIR_NAME);
    const clone = plan.steps[0]!;
    expect(clone.cwd).toBe("parent");
    expect(clone.args).toEqual([
      "clone",
      "--branch",
      "main",
      "--depth",
      "1",
      "https://github.com/ugurbank/ugurpay.git",
      "repo",
    ]);
    const checkout = plan.steps[1]!;
    expect(checkout.cwd).toBe("repo");
    expect(checkout.args).toEqual(["checkout", "-b", "feature/OPS-6"]);
  });

  it("carries the token ONLY in the credential env, never on any argv or the remote", () => {
    const plan = buildGitClonePlan(CLONE_ARGS);
    const everyArg = plan.steps.flatMap((s) => s.args).join(" ");
    expect(everyArg).not.toContain(TOKEN);
    expect(everyArg).toContain("https://github.com/ugurbank/ugurpay.git");
    expect(everyArg).not.toContain("@github.com");
    expect(plan.credentialEnv["GIT_CONFIG_COUNT"]).toBe("3");
    expect(plan.credentialEnv["GIT_CONFIG_KEY_0"]).toBe("http.extraHeader");
    const header = plan.credentialEnv["GIT_CONFIG_VALUE_0"] ?? "";
    expect(header.toLowerCase()).toContain("authorization: basic ");
    const b64 = header.split(" ").pop() ?? "";
    expect(Buffer.from(b64, "base64").toString("utf8")).toContain(TOKEN);
    expect(plan.credentialEnv["GIT_TERMINAL_PROMPT"]).toBe("0");
  });
});

describe("buildGitCommitPushPlan", () => {
  it("emits add→commit→push→rev-parse in order (the post-write half)", () => {
    const plan = buildGitCommitPushPlan(COMMIT_PUSH_ARGS);
    const verbs = plan.steps.map((s) => s.args[0]);
    expect(verbs).toEqual(["add", "commit", "push", "rev-parse"]);
    // Every step runs INSIDE the clone (the git working tree with the code).
    for (const step of plan.steps) expect(step.cwd).toBe("repo");
  });

  it("never puts --force on the push (no force-push, M13)", () => {
    const plan = buildGitCommitPushPlan(COMMIT_PUSH_ARGS);
    const push = plan.steps.find((s) => s.args[0] === "push");
    expect(push?.args).toEqual(["push", "origin", "feature/OPS-6"]);
    expect(plan.steps.some((s) => s.args.includes("--force") || s.args.includes("-f"))).toBe(false);
  });

  it("carries the token ONLY in the credential env, never on any argv", () => {
    const plan = buildGitCommitPushPlan(COMMIT_PUSH_ARGS);
    const everyArg = plan.steps.flatMap((s) => s.args).join(" ");
    expect(everyArg).not.toContain(TOKEN);
    const header = plan.credentialEnv["GIT_CONFIG_VALUE_0"] ?? "";
    const b64 = header.split(" ").pop() ?? "";
    expect(Buffer.from(b64, "base64").toString("utf8")).toContain(TOKEN);
  });

  it("commit message carries the [AI] subject and the Co-Authored-By trailer (M13)", () => {
    const plan = buildGitCommitPushPlan(COMMIT_PUSH_ARGS);
    const commit = plan.steps.find((s) => s.args[0] === "commit");
    const message = commit?.args[commit.args.indexOf("-m") + 1] ?? "";
    expect(message).toContain("[AI] OPS-6");
    expect(message).toContain("Co-Authored-By: Maestro");
  });
});

describe("workspace.gitClone + gitCommitPush", () => {
  it("clone flips codeDir into <root>/repo so writes land in the git working tree", async () => {
    const { exec, calls } = recordingExec();
    const ws = await createWorkspace({ exec });
    try {
      // Before the clone the code dir is the workspace root (the fake path).
      expect(ws.codeDir).toBe(ws.root);
      await ws.gitClone(CLONE_ARGS);
      // After the clone the code dir IS the clone working tree — the fix.
      expect(ws.codeDir).toBe(`${ws.root}/${REPO_DIR_NAME}`);

      // A write now lands INSIDE the clone, so a later `git add` sees it.
      await ws.write(IMPLEMENTATION_PATH, "export const x = 1;\n");
      const { readFile } = await import("node:fs/promises");
      const written = await readFile(
        `${ws.root}/${REPO_DIR_NAME}/${IMPLEMENTATION_PATH}`,
        "utf8",
      );
      expect(written).toContain("export const x = 1;");

      // clone ran in the parent; checkout ran inside the repo.
      expect(calls.map((c) => c.args[0])).toEqual(["clone", "checkout"]);
      expect(calls[0]!.cwd).toBe(ws.root);
      expect(calls[1]!.cwd).toBe(`${ws.root}/${REPO_DIR_NAME}`);
    } finally {
      await ws.dispose();
    }
  });

  it("commit/push runs the sequence inside the clone and returns the pushed sha", async () => {
    const { exec, calls } = recordingExec();
    const ws = await createWorkspace({ exec });
    try {
      await ws.gitClone(CLONE_ARGS);
      await ws.write(IMPLEMENTATION_PATH, "export const x = 1;\n");
      const result = await ws.gitCommitPush(COMMIT_PUSH_ARGS);
      expect(result.commitSha).toBe("abc123def456abc123def456abc123def456abcd");

      // Full end-to-end git order across both halves.
      expect(calls.map((c) => c.args[0])).toEqual([
        "clone",
        "checkout",
        "add",
        "commit",
        "push",
        "rev-parse",
      ]);
      // The add→commit→push→rev-parse steps ALL run in the clone working tree
      // (the code write landed there), so `git add` has a real diff to stage.
      for (const call of calls.slice(2)) {
        expect(call.cwd).toBe(`${ws.root}/${REPO_DIR_NAME}`);
      }
      // Every git child got the credential env (token only in env, never argv).
      for (const call of calls) {
        expect(call.file).toBe("git");
        expect(call.env?.["GIT_CONFIG_KEY_0"]).toBe("http.extraHeader");
        expect(call.args.join(" ")).not.toContain(TOKEN);
      }
    } finally {
      await ws.dispose();
    }
  });

  it("fails CLOSED when the push step exits non-zero (no false success)", async () => {
    const { exec, calls } = recordingExec((req) => req.args[0] === "push");
    const ws = await createWorkspace({ exec });
    try {
      await ws.gitClone(CLONE_ARGS);
      await expect(ws.gitCommitPush(COMMIT_PUSH_ARGS)).rejects.toBeInstanceOf(GitStepError);
      // rev-parse never ran — the sequence stopped at the failed push.
      expect(calls.map((c) => c.args[0])).toEqual([
        "clone",
        "checkout",
        "add",
        "commit",
        "push",
      ]);
    } finally {
      await ws.dispose();
    }
  });

  it("fails CLOSED when the clone step exits non-zero, before any write", async () => {
    const { exec, calls } = recordingExec((req) => req.args[0] === "clone");
    const ws = await createWorkspace({ exec });
    try {
      await expect(ws.gitClone(CLONE_ARGS)).rejects.toBeInstanceOf(GitStepError);
      // The clone failed, so codeDir was NOT flipped — no half-open working tree.
      expect(ws.codeDir).toBe(ws.root);
      expect(calls.map((c) => c.args[0])).toEqual(["clone"]);
    } finally {
      await ws.dispose();
    }
  });

  it("the GitStepError message carries the argv + stderr but NOT the token", async () => {
    const { exec } = recordingExec((req) => req.args[0] === "clone");
    const ws = await createWorkspace({ exec });
    try {
      const error = await ws.gitClone(CLONE_ARGS).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitStepError);
      const message = (error as GitStepError).message;
      expect(message).toContain("clone");
      expect(message).toContain("boom");
      expect(message).not.toContain(TOKEN);
    } finally {
      await ws.dispose();
    }
  });
});
