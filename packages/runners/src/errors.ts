/**
 * Typed failures of the runner drivers (M21-M27).
 *
 * Rule for this file: an error may name *what was asked for* (container name,
 * image reference, volume, HTTP status, endpoint path) and never the job's
 * environment or command payload — a `RunJob.env` carries short-lived tokens
 * (M80) and must not reach a log line through a message or `JSON.stringify`.
 */

/** Base class so a caller can catch every runner failure in one branch. */
export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}

/** Driver configuration or wiring is wrong — thrown at construction time. */
export class RunnerConfigError extends RunnerError {
  constructor(reason: string) {
    super(`runners driver configuration error: ${reason}`);
    this.name = "RunnerConfigError";
  }
}

/** No free slot for the requested platform (M21). Fail-closed: never queued silently. */
export class RunnerCapacityError extends RunnerError {
  constructor(
    readonly platform: string,
    readonly capacity: number,
  ) {
    super(`no free runner slot for platform "${platform}" (capacity ${capacity})`);
    this.name = "RunnerCapacityError";
  }
}

/** The lease is unknown, already released, or belongs to another driver. */
export class RunnerLeaseError extends RunnerError {
  constructor(
    readonly leaseId: string,
    readonly reason: "unknown" | "released" | "busy" | "foreign",
  ) {
    super(`runner lease "${leaseId}" rejected (reason: ${reason})`);
    this.name = "RunnerLeaseError";
  }
}

/** A workspace key / cache key does not satisfy the grammar (see workspace.ts). */
export class RunnerKeyError extends RunnerError {
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`invalid runner key "${key}": ${reason}`);
    this.name = "RunnerKeyError";
  }
}

/** Docker answered a non-2xx status. Carries status + endpoint, never a job payload. */
export class DockerHttpError extends RunnerError {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly detail: string,
  ) {
    super(`docker ${endpoint} failed with HTTP ${status}: ${detail}`);
    this.name = "DockerHttpError";
  }
}

/** Docker answered 2xx but the body is unusable (not JSON, missing fields). */
export class DockerResponseError extends RunnerError {
  constructor(
    readonly endpoint: string,
    readonly issue: string,
  ) {
    super(`docker ${endpoint} response is not usable: ${issue}`);
    this.name = "DockerResponseError";
  }
}

/** The agent protocol rejected a message or an expired session (M22). */
export class AgentProtocolError extends RunnerError {
  constructor(
    readonly agentId: string,
    reason: string,
  ) {
    super(`runner agent "${agentId}" rejected: ${reason}`);
    this.name = "AgentProtocolError";
  }
}
