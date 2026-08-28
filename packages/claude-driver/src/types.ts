/**
 * Injection points. Everything touching the outside world (a process, the
 * clock) is an interface, so the package is testable offline and
 * deterministically — no test here may start the real `claude` binary.
 */

/** One child process invocation. `stdin` is written then closed. */
export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** One complete stdout line at a time: how a long turn reaches the journal
   * before it ends (M30). Optional — the parser works off buffered output. */
  readonly onStdoutLine?: (line: string) => void;
}

export interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when `timeoutMs` elapsed and the process group was killed. */
  readonly timedOut: boolean;
}

export type SpawnFn = (spec: SpawnSpec) => Promise<SpawnResult>;
