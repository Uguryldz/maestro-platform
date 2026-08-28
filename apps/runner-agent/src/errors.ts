/**
 * Typed failures of the runner agent.
 *
 * Same rule as `@maestro/runners/errors.ts`: an error may name what was asked
 * for (agent id, lease id, endpoint, config field) and NEVER a credential, a
 * job's environment or its command. The agent holds a shared secret and streams
 * job output, so a careless `${error}` here is a token in a log file (task #6).
 */

export class RunnerAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerAgentError";
  }
}

/** Configuration is missing or invalid — thrown before the agent registers. */
export class RunnerAgentConfigError extends RunnerAgentError {
  constructor(reason: string) {
    super(`runner agent configuration error: ${reason}`);
    this.name = "RunnerAgentConfigError";
  }
}

/** The platform refused a message, or answered something unusable. */
export class PlatformProtocolError extends RunnerAgentError {
  constructor(
    readonly endpoint: string,
    reason: string,
  ) {
    super(`platform ${endpoint} rejected: ${reason}`);
    this.name = "PlatformProtocolError";
  }
}

/** The platform answered a non-2xx status. Carries status + endpoint, never a body. */
export class PlatformHttpError extends RunnerAgentError {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`platform ${endpoint} failed with HTTP ${status}`);
    this.name = "PlatformHttpError";
  }
}

/**
 * The agent lost a lease it was working on (expired, revoked or reassigned).
 * The job must stop: the platform may already have handed it to someone else.
 */
export class LeaseLostError extends RunnerAgentError {
  constructor(
    readonly leaseId: string,
    readonly reason: "expired" | "revoked" | "shutdown",
  ) {
    super(`lease "${leaseId}" lost (reason: ${reason})`);
    this.name = "LeaseLostError";
  }
}

/**
 * The reason carried by the `AbortSignal` handed to `RunnerPort.runSession`.
 * Reaches the runner driver, so it names the CAUSE (kill switch, lost lease,
 * shutdown) and nothing about the job itself.
 */
export class JobAbortedError extends RunnerAgentError {
  constructor(readonly reason: string) {
    super(`job aborted (reason: ${reason})`);
    this.name = "JobAbortedError";
  }
}

/** The token reference could not be resolved. Never quotes the value it looked for. */
export class TokenResolutionError extends RunnerAgentError {
  constructor(reason: string) {
    super(`runner agent token could not be resolved: ${reason}`);
    this.name = "TokenResolutionError";
  }
}
