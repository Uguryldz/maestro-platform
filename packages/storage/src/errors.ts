/**
 * Storage driver errors. Every failure mode is explicit: no driver ever
 * silently degrades a request it cannot honour (M57 fail-closed).
 */

/** The requested key does not exist. Identical for every driver. */
export class ObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`storage: object not found: ${key}`);
    this.name = "ObjectNotFoundError";
  }
}

/** The key violates the key-safety rules (see keys.ts). */
export class InvalidKeyError extends Error {
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`storage: invalid key "${key}": ${reason}`);
    this.name = "InvalidKeyError";
  }
}

/**
 * A put asked for Object Lock (M57) but the driver instance has no retention
 * configuration. Never downgrade to an unlocked write — the caller believes
 * the object is WORM-protected, so we fail loudly instead.
 */
export class ObjectLockNotConfiguredError extends Error {
  constructor(readonly key: string) {
    super(
      `storage: objectLock requested for "${key}" but this driver has no objectLock configuration ` +
        `(M57 fail-closed: silent downgrade is forbidden)`,
    );
    this.name = "ObjectLockNotConfiguredError";
  }
}

/** A write was refused because the object is still under retention (WORM). */
export class ObjectLockedError extends Error {
  constructor(
    readonly key: string,
    readonly retainUntil: string,
  ) {
    super(`storage: object "${key}" is retention-locked until ${retainUntil}`);
    this.name = "ObjectLockedError";
  }
}

/** The backend answered with a non-success status. */
export class StorageRequestError extends Error {
  constructor(
    readonly operation: string,
    readonly key: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`storage: ${operation} "${key}" failed with HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "StorageRequestError";
  }
}

/** Where an unusable response was observed. */
export interface ResponseContext {
  operation: string;
  key: string;
  status: number;
}

/**
 * A 2xx response the driver refuses to interpret: it did not come from the S3
 * API (no `x-amz-request-id`), or its body is not the document the operation
 * needs. Answering with an empty listing or a 25-byte "object" would make a
 * proxy login page look like "this ticket has no evidence" (M34/M66).
 */
export class UnexpectedResponseError extends StorageRequestError {
  constructor(
    context: ResponseContext,
    readonly reason: string,
    body: string,
  ) {
    super(context.operation, context.key, context.status, body);
    this.name = "UnexpectedResponseError";
    this.message =
      `storage: ${context.operation} "${context.key}" got an unusable HTTP ${context.status} ` +
      `response (${reason}): ${body.slice(0, 300)}`;
  }
}

/** A presign ttl outside the driver's accepted range. */
export class InvalidTtlError extends Error {
  constructor(
    readonly key: string,
    readonly ttlSeconds: number,
    readonly maxSeconds: number,
  ) {
    super(
      `storage: presign "${key}" ttl must be a positive integer of at most ` +
        `${maxSeconds} seconds, got ${ttlSeconds}`,
    );
    this.name = "InvalidTtlError";
  }
}

/** The driver configuration is unusable. Thrown at construction time. */
export class StorageConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`storage: driver configuration invalid:\n- ${issues.join("\n- ")}`);
    this.name = "StorageConfigError";
  }
}
