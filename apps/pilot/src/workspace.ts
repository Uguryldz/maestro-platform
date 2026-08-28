import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The demo's stand-in for the hardened sandbox (M25/M60 — a real container
 * pool arrives in wave 2). It is deliberately small and honest: the generated
 * files are written to a throwaway temp directory and the generated test is
 * executed with the plain Node binary. Nothing is mounted, nothing is cached,
 * and the process inherits NO environment, so the OpenRouter key cannot leak
 * into it.
 *
 * Dalga C2 adds a REAL git path (`gitPush`) used ONLY when PILOT_SCM=github:
 * clone → branch → commit → push, over an INJECTED exec runner so tests never
 * shell out. The push credential is fed to git through GIT_CONFIG_* env vars
 * (an ephemeral `http.extraHeader`), never on the argv and never written to
 * `.git/config` — see `buildGitPushPlan`.
 */

/** Fixed paths, so the model's import specifier is predictable. */
export const IMPLEMENTATION_PATH = "src/impl.mjs";
export const TEST_PATH = "test/impl.test.mjs";

/** A single command the workspace asks the (injected) runner to execute. */
export interface ExecRequest {
  file: string;
  args: string[];
  cwd: string;
  /** Extra env for THIS child only; merged over a minimal inherited PATH. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one command. Injected so tests stub it — the pilot never shells out in a test. */
export type ExecRunner = (request: ExecRequest) => Promise<ExecResult>;

export interface DemoWorkspace {
  root: string;
  /**
   * The directory the code files are written to and the test is run in. On the
   * fake path this is `root`. On the github path, AFTER `gitClone`, it becomes
   * the cloned repo working tree (`root/repo`) — so the model's files land
   * inside the git working directory and there is a real diff to commit.
   */
  readonly codeDir: string;
  /**
   * A ticket-scoped directory for AI context/cache (prompts, retrieval caches,
   * scratch state) that must NOT leak between tickets. On the mkdtemp path it
   * lives under the throwaway root; under a persistent root it lives INSIDE the
   * ticket's own subdirectory (`<root>/<ticketKey>/context`), so one ticket can
   * never read another ticket's cache — the shared root holds only isolated
   * per-ticket data. Always distinct from `codeDir` so a `git add --all` in the
   * clone never stages the AI's scratch state.
   */
  readonly contextDir: string;
  write(relativePath: string, content: string): Promise<void>;
  runTest(timeoutMs?: number): Promise<TestRun>;
  /**
   * Clone the repo into `root/repo` and re-point `codeDir` at that working tree.
   * MUST run before `write`/`runTest` on the github path so the code files are
   * written inside the git working directory (that is the whole fix — otherwise
   * `git commit` finds an empty clone and reports "nothing to commit").
   * Returns the branch that was checked out, so the caller can commit against it.
   */
  gitClone(args: GitCloneArgs): Promise<void>;
  /**
   * Stage → commit → push from the cloned working tree (`codeDir`), then return
   * the pushed commit sha. MUST run after `gitClone` + the code writes.
   * Fails CLOSED: any non-zero git step throws, so a caller can never mistake a
   * failed push for a successful one.
   */
  gitCommitPush(args: GitCommitPushArgs): Promise<{ commitSha: string }>;
  dispose(): Promise<void>;
}

export interface TestRun {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface GitCloneArgs {
  /** HTTPS remote WITHOUT credentials, e.g. https://github.com/owner/repo.git */
  remoteUrl: string;
  /** Feature branch to create and push, e.g. feature/OPS-6. */
  branch: string;
  /** Base branch to clone/branch from, e.g. main. */
  baseBranch: string;
  /** Short-lived push token (M31). NEVER logged; fed to git via env only. */
  token: string;
  /** Author identity for the commit; the token is NOT this. */
  authorName: string;
  authorEmail: string;
}

export interface GitCommitPushArgs {
  /** Feature branch to push, e.g. feature/OPS-6. Must match the cloned branch. */
  branch: string;
  /** First line of the commit message ([AI] prefix expected, M13). */
  commitSubject: string;
  /** Trailer line, e.g. "Co-Authored-By: Maestro <maestro@…>" (M13). */
  coAuthor: string;
  /** Short-lived push token (M31). NEVER logged; fed to git via env only. */
  token: string;
  /** Author identity for the commit; the token is NOT this. */
  authorName: string;
  authorEmail: string;
}

export interface CreateWorkspaceOptions {
  /** Injected command runner; defaults to a real `execFile` sandboxed runner. */
  exec?: ExecRunner;
  /**
   * The KÖK (permanent root) for the single analysis sandbox. When set, the
   * workspace is opened as an ISOLATED subdirectory `<root>/<ticketKey>/` under
   * this stable root instead of a fresh `mkdtemp` temp dir — and `dispose()`
   * removes ONLY that ticket subdirectory, never the root. When absent (the
   * default), behaviour is unchanged: a throwaway `mkdtemp` dir, disposed whole
   * (no regression for callers/tests that pass no root).
   *
   * This value is read from the UI/param settings (env only SEEDS the default at
   * bootstrap), never from the environment at use time.
   */
  persistentRoot?: string;
  /**
   * The ticket the workspace is opened for. REQUIRED when `persistentRoot` is
   * set — it names the isolated subdirectory (`<root>/<ticketKey>/`) so each
   * ticket gets its own space and cannot see another's. Ignored on the mkdtemp
   * path. The value is slugged (see `ticketDirName`) so a ticket key can never
   * escape the root via path separators.
   */
  ticketKey?: string;
}

/** The AI context/cache subdir name inside a ticket's isolated area. */
export const CONTEXT_DIR_NAME = "context";
/** The code/working subdir name inside a ticket's isolated area (persistent root). */
export const WORK_DIR_NAME = "work";

/**
 * Turn a ticket key into a SAFE single path segment for the isolated subdir.
 *
 * A ticket key is operator/Jira-supplied, so it is treated as untrusted here:
 * every character outside `[A-Za-z0-9._-]` is replaced with `_`, which strips
 * path separators (`/`, `\`), `..` traversal, NUL, and drive-letter tricks. The
 * result can only ever name a direct child of the root, so one ticket's area can
 * never be steered onto another's — or outside the root. Throws (fails CLOSED)
 * if nothing usable remains, rather than opening an ambiguous shared dir.
 */
export function ticketDirName(ticketKey: string): string {
  const slug = ticketKey
    // Everything outside the safe set becomes `_` — kills `/`, `\`, NUL, spaces.
    .replace(/[^A-Za-z0-9._-]/g, "_")
    // Collapse any run of two-or-more dots so no `..` survives ANYWHERE (belt and
    // braces on top of the separator strip: even a flattened segment carries no
    // traversal token).
    .replace(/\.{2,}/g, "_")
    // Drop a leading dot so the segment is never hidden/relative.
    .replace(/^\.+/, "");
  if (slug.length === 0 || /^_+$/.test(slug)) {
    throw new Error(`geçersiz ticket anahtarı sandbox dizini için: ${JSON.stringify(ticketKey)}`);
  }
  return slug;
}

const GIT_TIMEOUT_MS = 60_000;

/** The clone target subdir under the workspace root; the git working tree. */
export const REPO_DIR_NAME = "repo";

/**
 * Builds the credential/identity env that carries the token OUT of band, shared
 * by the clone and commit/push plans.
 *
 * Credential handling (the security core, M31/M80):
 *  - The token is turned into a Basic `http.extraHeader` and injected through
 *    GIT_CONFIG_COUNT / GIT_CONFIG_KEY_0 / GIT_CONFIG_VALUE_0. Git applies it
 *    like a `-c` override but it is EPHEMERAL: it is never written to
 *    `.git/config`, and — unlike `-c key=value` — it is not on the argv, so it
 *    cannot surface in `ps`, a shell history, or a logged command line.
 *  - The env map is returned SEPARATELY from the argv so a logger can print the
 *    argv freely and never touch the secret.
 */
function buildCredentialEnv(args: {
  token: string;
  authorName: string;
  authorEmail: string;
}): Record<string, string> {
  const header = `AUTHORIZATION: basic ${base64(`x-access-token:${args.token}`)}`;
  // All overrides — the credential header AND the commit identity — ride
  // GIT_CONFIG_* so NONE of them land on an argv or in `.git/config`. The token
  // is the one that matters for secrecy; the identity travels the same way so a
  // logger printing the argv shows a clean `git commit -m …` with no `-c`.
  return {
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: header,
    GIT_CONFIG_KEY_1: "user.name",
    GIT_CONFIG_VALUE_1: args.authorName,
    GIT_CONFIG_KEY_2: "user.email",
    GIT_CONFIG_VALUE_2: args.authorEmail,
    // Belt-and-braces: never let git pop an interactive credential prompt.
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Builds the ordered git command plan for the CLONE half: clone the base branch
 * into `./repo`, then branch off. This MUST run before the code is written so
 * the model's files land inside the git working tree. Pure and exported so a
 * test can assert the sequence + that the token never lands on an argv, and the
 * remote URL stays credential-free.
 */
export function buildGitClonePlan(args: GitCloneArgs): {
  steps: Array<{ args: string[]; cwd: "parent" | "repo" }>;
  credentialEnv: Record<string, string>;
  repoDirName: string;
} {
  const credentialEnv = buildCredentialEnv(args);
  const steps: Array<{ args: string[]; cwd: "parent" | "repo" }> = [
    // clone the base branch, shallow, into ./repo
    {
      args: ["clone", "--branch", args.baseBranch, "--depth", "1", args.remoteUrl, REPO_DIR_NAME],
      cwd: "parent",
    },
    // branch off
    { args: ["checkout", "-b", args.branch], cwd: "repo" },
  ];
  return { steps, credentialEnv, repoDirName: REPO_DIR_NAME };
}

/**
 * Builds the ordered git command plan for the COMMIT/PUSH half: stage → commit →
 * push → rev-parse, all inside the cloned working tree (`./repo`). This runs
 * AFTER the code was written into the clone, so `git add --all` sees a real
 * diff. Pure and exported so a test can assert the sequence and prove the token
 * never lands on an argv.
 */
export function buildGitCommitPushPlan(args: GitCommitPushArgs): {
  steps: Array<{ args: string[]; cwd: "parent" | "repo" }>;
  credentialEnv: Record<string, string>;
  repoDirName: string;
} {
  const credentialEnv = buildCredentialEnv(args);
  const message = `${args.commitSubject}\n\n${args.coAuthor}`;
  const steps: Array<{ args: string[]; cwd: "parent" | "repo" }> = [
    // stage the model's files (written into the clone before this runs)
    { args: ["add", "--all"], cwd: "repo" },
    // commit with the AI author identity (from env) + co-author trailer (M13)
    { args: ["commit", "-m", message], cwd: "repo" },
    // push the new branch; NEVER --force (protected_paths / no force-push, M13)
    { args: ["push", "origin", args.branch], cwd: "repo" },
    // resolve the pushed commit sha for the caller
    { args: ["rev-parse", "HEAD"], cwd: "repo" },
  ];
  return { steps, credentialEnv, repoDirName: REPO_DIR_NAME };
}

export async function createWorkspace(options: CreateWorkspaceOptions = {}): Promise<DemoWorkspace> {
  const exec = options.exec ?? defaultExecRunner;

  // Two modes for opening the workspace root:
  //
  //  · PERSISTENT ROOT (persistentRoot set): the analysis sandbox has ONE stable
  //    KÖK that is never torn down. Each ticket gets its own ISOLATED subdir
  //    `<root>/<ticketKey>/` — created here, removed by `dispose()` (the root and
  //    every OTHER ticket survive). `disposeTarget` is that ticket subdir.
  //
  //  · MKDTEMP (default): a fresh throwaway dir per call, disposed whole. No
  //    regression — any caller/test that passes no root keeps the old behaviour.
  //
  // `root` is always the directory the fake-path code write + test run in;
  // `disposeTarget` is what `dispose()` removes — the same as `root` on the
  // mkdtemp path, but the ticket subdir (NOT the KÖK) on the persistent path.
  let root: string;
  let disposeTarget: string;
  let contextDir: string;
  if (options.persistentRoot !== undefined && options.persistentRoot.trim().length > 0) {
    if (options.ticketKey === undefined || options.ticketKey.trim().length === 0) {
      throw new Error("kalıcı sandbox kökü verildi ama ticketKey verilmedi");
    }
    const ticketRoot = join(options.persistentRoot, ticketDirName(options.ticketKey));
    root = join(ticketRoot, WORK_DIR_NAME);
    contextDir = join(ticketRoot, CONTEXT_DIR_NAME);
    // Ensure the KÖK, this ticket's area, its work dir AND its context dir exist.
    // `recursive` creates the (permanent) root if it is not there yet without
    // failing when it already is — the root is shared across tickets/runs.
    await mkdir(root, { recursive: true });
    await mkdir(contextDir, { recursive: true });
    // dispose() removes ONLY this ticket's area, never the shared KÖK.
    disposeTarget = ticketRoot;
  } else {
    root = await mkdtemp(join(tmpdir(), "maestro-demo-"));
    contextDir = join(root, CONTEXT_DIR_NAME);
    await mkdir(contextDir, { recursive: true });
    disposeTarget = root;
  }

  const repoDir = join(root, REPO_DIR_NAME);

  // The directory the code is written to and the test runs in. Starts as `root`
  // (the fake path). `gitClone` flips it to the cloned repo working tree so the
  // model's files land INSIDE the git working directory — that is the fix.
  let codeDir = root;

  // Runs the ordered git steps of a plan, failing CLOSED on any non-zero step.
  // Returns the rev-parse HEAD sha if the plan resolves one, else "".
  const runGitPlan = async (plan: {
    steps: Array<{ args: string[]; cwd: "parent" | "repo" }>;
    credentialEnv: Record<string, string>;
  }): Promise<string> => {
    // The credential env rides on EVERY git child (the header is only used by
    // the transport steps, but keeping it uniform means no branch decides,
    // per command, whether to attach the secret). PATH is the only inherited
    // value; nothing else of the pilot's environment reaches git.
    const baseEnv: Record<string, string> = { PATH: process.env["PATH"] ?? "", ...plan.credentialEnv };
    let commitSha = "";
    for (const step of plan.steps) {
      const result = await exec({
        file: "git",
        args: step.args,
        cwd: step.cwd === "parent" ? root : repoDir,
        env: baseEnv,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (!result.ok) {
        // Fail closed. The message carries the git argv (never the secret —
        // it lives only in env) and stderr, so the step surfaces a real cause.
        throw new GitStepError(step.args, result.exitCode, result.stderr || result.stdout);
      }
      if (step.args[0] === "rev-parse") commitSha = result.stdout.trim();
    }
    return commitSha;
  };

  return {
    root,
    contextDir,
    get codeDir(): string {
      return codeDir;
    },
    async write(relativePath: string, content: string): Promise<void> {
      const full = join(codeDir, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    },
    runTest(timeoutMs = 20_000): Promise<TestRun> {
      const startedAt = Date.now();
      return exec({
        file: process.execPath,
        args: [TEST_PATH],
        cwd: codeDir,
        timeoutMs,
        env: { PATH: process.env["PATH"] ?? "" },
      }).then((result) => ({
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        durationMs: Date.now() - startedAt,
      }));
    },
    async gitClone(args: GitCloneArgs): Promise<void> {
      // Clone + branch off, THEN re-point codeDir at the working tree so the
      // subsequent write()/runTest() operate inside the git repo. Without this
      // flip the code files land at root and the clone is empty — the bug that
      // produced "nothing to commit, working tree clean".
      await runGitPlan(buildGitClonePlan(args));
      codeDir = repoDir;
    },
    async gitCommitPush(args: GitCommitPushArgs): Promise<{ commitSha: string }> {
      const commitSha = await runGitPlan(buildGitCommitPushPlan(args));
      if (commitSha === "") {
        throw new GitStepError(["rev-parse", "HEAD"], null, "git push HEAD sha'sı çözülemedi");
      }
      return { commitSha };
    },
    async dispose(): Promise<void> {
      // Remove this workspace's area only: the whole throwaway dir on the
      // mkdtemp path, or just THIS ticket's subdir under a persistent KÖK. The
      // shared root and every other ticket's area are left untouched.
      await rm(disposeTarget, { recursive: true, force: true });
    },
  };
}

/** A git step that exited non-zero. Carries argv + stderr, never the token. */
export class GitStepError extends Error {
  constructor(
    readonly gitArgs: string[],
    readonly exitCode: number | null,
    readonly detail: string,
  ) {
    super(`git ${gitArgs.join(" ")} çıkış kodu ${exitCode ?? "?"}: ${detail}`);
    this.name = "GitStepError";
  }
}

/** Real runner: `execFile` with an explicit env, no shell, no inherited env. */
function defaultExecRunner(request: ExecRequest): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    execFile(
      request.file,
      request.args,
      {
        cwd: request.cwd,
        timeout: request.timeoutMs ?? 20_000,
        env: request.env ?? { PATH: process.env["PATH"] ?? "" },
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? null
              : 0;
        resolve({
          ok: error === null,
          exitCode: code,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
