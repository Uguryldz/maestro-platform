/** Base class so a composition root can catch everything this package throws. */
export class ClaudeDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeDriverError";
  }
}

/** The CLI ran but did not speak the protocol we parse. Never downgraded to
 * "empty answer": a turn we cannot read is one we can prove nothing about. */
export class ClaudeCliProtocolError extends ClaudeDriverError {
  constructor(message: string) {
    super(`claude CLI stream protocol: ${message}`);
    this.name = "ClaudeCliProtocolError";
  }
}

/** The CLI exited non-zero, or reported `is_error` in its result message. */
export class ClaudeCliError extends ClaudeDriverError {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

/** Misconfiguration of the driver itself (bad flag values, missing binary path). */
export class ClaudeConfigError extends ClaudeDriverError {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeConfigError";
  }
}
