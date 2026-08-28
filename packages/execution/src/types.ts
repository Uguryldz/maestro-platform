/**
 * Injection points. Everything touching the outside world (the clock, the
 * working copy, a build command) is an interface, so the package is testable
 * offline and deterministically.
 */

/**
 * Working-copy states M52 has to reason about. `renamed` and `typechange` are
 * not decoration:
 *  · a rename is the cheapest way to move content onto protected ground —
 *    `git status` reports it as ONE entry, and a model that only reads the
 *    destination misses that a file left a protected directory (and vice
 *    versa), so both ends are checked;
 *  · `typechange` (git's `T`) is a regular file replaced by a symlink or the
 *    other way round. Collapsed into "modified" it reads as an ordinary edit,
 *    while it is how a tracked path starts pointing outside the workspace.
 */
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "typechange";

/** Working-copy status of one file the agent session left behind. */
export interface ChangedFile {
  /** Workspace-relative, forward slashes. Absolute or `..` paths are rejected. */
  readonly path: string;
  readonly status: ChangeStatus;
  /** Where a `renamed` entry came from. Checked against the deny-list too. */
  readonly fromPath?: string;
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * Reads what the session changed (Wave 3 / docker-linux runner implements it).
 * A failure here is fatal, never "no changes" — fail-closed for M52.
 */
export interface WorkspaceProbe {
  changedFiles(workspacePath: string): Promise<readonly ChangedFile[]>;
  /**
   * Changes under `.git/` itself. A separate method because `git status`
   * structurally cannot report them: git does not track its own directory, so
   * a hook dropped into `.git/hooks/post-checkout` is both unprotected AND
   * invisible to the M52 gate — persistent code execution on the bank's runner
   * that leaves no trace in any diff. Implementations compare the directory
   * against the state it was handed to the session in.
   */
  internalChangedFiles(workspacePath: string): Promise<readonly ChangedFile[]>;
}

/** A verification command (lint / build / test) and what it printed. */
export interface CommandResult {
  readonly name: string;
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly durationMs: number;
}

export interface CommandSpec {
  readonly name: string;
  readonly command: readonly string[];
}

/** Runs the repo's own lint/build/test commands (`.maestro.yaml`, M71). */
export interface VerificationRunner {
  run(workspacePath: string, spec: CommandSpec): Promise<CommandResult>;
}

export interface DiffSummary {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}
