import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Getting a repository onto disk so an agent session can read it.
 *
 * Step 3ö opens a session whose working directory is `RunContext.workspacePath`
 * (`packages/workflows/src/impl/analysis.ts`), and nothing in the workflow ever
 * put a repository there: the column was written empty and the session would
 * have opened on an empty path. That is why the analyst has always been
 * repo-blind — not a missing model capability, a missing checkout.
 *
 * Read-only by design. This release analyses; it does not write code, so the
 * clone is shallow, single-branch and never pushed from. A deployment that
 * enables the engineering turn needs branch and push handling on top, which is
 * the ScmPort's job rather than this one's.
 *
 * The token reaches git through a header in the URL-less form
 * (`http.extraHeader`), never on the argv: `ps` is readable by every user on
 * the host, and a PAT in a process listing is a PAT in an incident report.
 */

export interface CloneRequest {
  /** `owner/repo`, as the Application record carries it. */
  readonly repo: string;
  /** Where checkouts live. One directory per run underneath it. */
  readonly root: string;
  /** Run id — the directory name, so two runs never share a working tree. */
  readonly runId: string;
  /** Host of the SCM. Defaults to github.com. */
  readonly host?: string;
  /** Bearer token for a private repository; omitted for a public one. */
  readonly token?: string | undefined;
  readonly timeoutMs?: number;
}

export class WorkspaceError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * Clone (or reuse) the run's checkout and return its path.
 *
 * Reuse matters for a retried activity: Temporal re-runs an activity after a
 * worker crash, and re-cloning a repository that is already on disk would turn
 * every retry into a fresh network fetch. An existing directory with a `.git`
 * in it is taken as the checkout this run already made.
 */
export async function prepareWorkspace(request: CloneRequest): Promise<string> {
  const { repo, root, runId } = request;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new WorkspaceError(`repository must be "owner/repo", got "${repo}"`);
  }
  const path = join(root, runId);

  if (await isCheckout(path)) return path;

  await mkdir(root, { recursive: true });
  // A half-finished clone from a killed attempt is not a checkout; clear it
  // rather than letting git refuse "destination path already exists".
  await rm(path, { recursive: true, force: true });

  const host = request.host ?? "github.com";
  const args = [
    // No credential prompts, ever: a clone that cannot authenticate must fail
    // in seconds rather than block an activity until its timeout.
    "-c",
    "credential.helper=",
    /**
     * Basic, not Bearer.
     *
     * GitHub's git-over-HTTPS endpoint reads a personal access token as the
     * PASSWORD half of HTTP Basic auth (`x-access-token:<pat>`); a `Bearer`
     * header is ignored and git then falls back to prompting, which fails as
     * "could not read Username for https://github.com" — a message that reads
     * like a missing credential rather than a wrongly-shaped one. Azure DevOps
     * and GitHub Enterprise accept the same form.
     */
    ...(request.token === undefined
      ? []
      : [
          "-c",
          `http.https://${host}/.extraheader=Authorization: Basic ${Buffer.from(
            `x-access-token:${request.token}`,
          ).toString("base64")}`,
        ]),
    "clone",
    "--depth",
    "1",
    "--single-branch",
    `https://${host}/${repo}.git`,
    path,
  ];

  try {
    await run("git", args, {
      timeout: request.timeoutMs ?? 120_000,
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        GIT_TERMINAL_PROMPT: "0",
        ...(process.env["NODE_EXTRA_CA_CERTS"] === undefined
          ? {}
          : { GIT_SSL_CAINFO: process.env["NODE_EXTRA_CA_CERTS"] }),
      },
    });
  } catch (cause) {
    // The message may carry the header; report the repository and the reason
    // shape, never the raw stderr.
    throw new WorkspaceError(`clone failed for ${repo}`, cause);
  }
  return path;
}

async function isCheckout(path: string): Promise<boolean> {
  try {
    const info = await stat(join(path, ".git"));
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}
