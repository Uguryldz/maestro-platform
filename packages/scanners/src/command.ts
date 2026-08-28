/**
 * Every scanner runs behind a tiny POSIX-sh preamble instead of being exec'd
 * directly. Two things forced this and both were proved against the real images
 * (gitleaks v8.30.1, semgrep 1.171.0, trivy 0.73.0):
 *
 * 1. gitleaks writes NOTHING to `--report-path /dev/stdout` — a dirty tree exits
 *    1 with zero bytes on stdout, so "no output" (an error for this package)
 *    was the only possible result of every gitleaks scan. The report has to be
 *    written to a file inside the container and read back.
 * 2. A container whose workspace mount is missing or empty runs happily and
 *    reports zero findings. "The scan ran but looked at nothing" is a pass the
 *    gate must never see (M27), and only the container can tell — the host path
 *    may not even exist on the machine the driver runs on.
 */

/** Reserved wrapper exit codes. Deliberately outside every tool's own range. */
export const WRAPPER_EXIT = {
  /** The mount path is not a directory inside the container. */ missingWorkspace: 91,
  /** The mount path is an empty directory — nothing could have been scanned. */ emptyWorkspace: 92,
  /** The tool exited but wrote no report file. */ missingReport: 93,
} as const;

export const WRAPPER_EXIT_REASONS: Readonly<Record<number, string>> = {
  [WRAPPER_EXIT.missingWorkspace]:
    "workspace mount is not a directory inside the container — the scan had no scope",
  [WRAPPER_EXIT.emptyWorkspace]:
    "workspace mount is empty inside the container — the scan had no scope",
  [WRAPPER_EXIT.missingReport]: "the tool exited without writing its report file",
};

/** Where a tool that cannot stream its report to stdout writes it. */
export function reportPath(tool: string): string {
  return `/tmp/maestro-${tool}-report.json`;
}

/**
 * `sh -c <script> sh <argv…>` — the tool command arrives as `"$@"`, never
 * spliced into the script, so no argument can change the script's meaning.
 * `mountPath` is the only interpolated value and `ContainerScanConfig` already
 * restricts it to `/[A-Za-z0-9._\-/]*`, which contains no shell metacharacter.
 */
export function wrapCommand(
  mountPath: string,
  argv: readonly string[],
  options: { readReport?: string } = {},
): string[] {
  assertMountPath(mountPath);
  const guard =
    `if [ ! -d '${mountPath}' ]; then exit ${WRAPPER_EXIT.missingWorkspace}; fi\n` +
    `if [ -z "$(ls -A '${mountPath}' 2>/dev/null)" ]; then exit ${WRAPPER_EXIT.emptyWorkspace}; fi\n`;

  // Without a report file the tool owns stdout and the guard is all we add.
  const body = options.readReport
    ? `"$@" >/dev/null\ncode=$?\n` +
      `if [ ! -f '${options.readReport}' ]; then exit ${WRAPPER_EXIT.missingReport}; fi\n` +
      `cat '${options.readReport}'\nexit $code\n`
    : `exec "$@"\n`;

  return ["sh", "-c", guard + body, "sh", ...argv];
}

/**
 * Defence in depth: the config schema already enforces this shape, but this
 * module writes shell, so it refuses to trust a caller that bypassed the schema.
 */
export function assertMountPath(mountPath: string): void {
  if (!/^\/[A-Za-z0-9._\-/]*$/.test(mountPath)) {
    throw new Error(`workspace mount path "${mountPath}" is not a plain absolute POSIX path`);
  }
}
