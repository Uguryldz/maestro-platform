import { WorkspaceProbeError } from "./errors.js";
import { mergeCounts, parseInternalPaths, parseNumstatZ, parsePorcelainZ } from "./git-status.js";
import { runInSandbox, type SandboxSessionDeps } from "./sandbox-session.js";
import type { ChangedFile, WorkspaceProbe } from "./types.js";

/**
 * `WorkspaceProbe` over the runner fleet.
 *
 * Every command runs INSIDE the sandbox, against the same volume the agent
 * session wrote — never against a host path. A probe that shelled out on the
 * host would be reading a different filesystem from the one it is reporting
 * on, and on the docker-linux runner it would find nothing at all.
 *
 * Fail-closed throughout: any command that does not exit 0 raises rather than
 * returning an empty list. `AgentExecution` treats a probe failure as fatal
 * precisely because "I could not look" and "nothing was touched" produce the
 * same M52 verdict otherwise — and only one of them is safe.
 */

export interface SandboxProbeOptions extends SandboxSessionDeps {
  /**
   * Cancels the probe. The same signal the turn holds, so a `stop_all` during
   * the inspection stops it rather than waiting for the next command.
   */
  readonly signal?: AbortSignal;
}

/** Seconds. A status call that takes this long means a broken workspace. */
const PROBE_TIMEOUT_SECONDS = 120;

export class SandboxWorkspaceProbe implements WorkspaceProbe {
  constructor(private readonly options: SandboxProbeOptions) {}

  /**
   * Tracked and untracked changes, with line counts.
   *
   * `--porcelain=v1 -z` for the states, `--numstat -z` for the counts, merged
   * by path. Untracked files are asked for explicitly (`-uall`): the default
   * `-unormal` collapses a new directory into ONE entry naming the directory,
   * so an agent that created `.github/workflows/` with three files in it would
   * be reported as having touched a single path that is not itself protected.
   */
  async changedFiles(workspacePath: string): Promise<readonly ChangedFile[]> {
    const status = await this.git(workspacePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "-uall",
      "--no-renames=false",
    ]);
    const files = parsePorcelainZ(status);
    if (files.length === 0) return [];

    // Counts are a nice-to-have on top of the status list: a numstat that
    // fails must not erase changes the status call already proved exist.
    const numstat = await this.git(workspacePath, ["diff", "--numstat", "-z", "HEAD"]).catch(() => "");
    return mergeCounts(files, parseNumstatZ(numstat));
  }

  /**
   * Changes under `.git/` itself.
   *
   * Compared against a marker file written when the workspace was handed to
   * the session: everything under `.git/` NEWER than the marker was touched
   * during the turn. `git status` cannot answer this — git does not track its
   * own directory — so without this call a `post-checkout` hook is both
   * unprotected and invisible to the gate.
   *
   * The marker is created by the workspace provisioner; if it is missing, the
   * whole of `.git/` is reported rather than nothing, because "I cannot tell
   * what changed here" must not read as "nothing changed here".
   */
  async internalChangedFiles(workspacePath: string): Promise<readonly ChangedFile[]> {
    const stdout = await this.run(
      workspacePath,
      [
        "sh",
        "-c",
        // `-newer` against the marker when it exists, everything otherwise.
        // `-print0` pairs with the NUL parsing the rest of this file uses.
        'cd "$0"/.git 2>/dev/null || exit 0; ' +
          'if [ -f ../.maestro-workspace ]; then find . -type f -newer ../.maestro-workspace -print0; ' +
          "else find . -type f -print0; fi",
        workspacePath,
      ],
      "internal-scan",
    );
    return parseInternalPaths(stripDotSlash(stdout));
  }

  private git(workspacePath: string, args: readonly string[]): Promise<string> {
    return this.run(workspacePath, ["git", "-C", workspacePath, ...args], `git ${args[0] ?? ""}`);
  }

  /**
   * One probe command. A non-zero exit is an ERROR, never an empty result.
   *
   * The stderr tail is quoted into the message: a probe failure is the one
   * thing standing between the agent's diff and the deny-list, so the operator
   * reading the run needs git's own reason, not "probe failed".
   */
  private async run(workspacePath: string, command: readonly string[], label: string): Promise<string> {
    const result = await runInSandbox(
      { ...this.options, timeoutSeconds: PROBE_TIMEOUT_SECONDS },
      { command },
      this.options.signal,
    );
    if (result.exitCode !== 0) {
      throw new WorkspaceProbeError(workspacePath, `${label} exited ${result.exitCode}: ${result.stderrTail.trim()}`);
    }
    return result.stdoutTail;
  }
}

/** `find .` prefixes every hit with `./`; the deny-list patterns do not. */
function stripDotSlash(stdout: string): string {
  return stdout
    .split("\0")
    .map((line) => (line.startsWith("./") ? line.slice(2) : line))
    .join("\0");
}
