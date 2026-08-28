/** Refused configuration — thrown by factories BEFORE any scan runs, so a
 * misconfigured scanner can never degrade into "no scan" at run time (M27). */
export class ScanConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanConfigError";
  }
}

/** Output this package refuses to interpret. Never swallowed: the driver turns
 * it into an `error` outcome, which blocks (M27 fail-closed). */
export class ScanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanParseError";
  }
}
