/** Driver configuration is wrong or incomplete — never a silent fallback. */
export class PublishConfigError extends Error {
  constructor(message: string) {
    super(`publish: ${message}`);
    this.name = "PublishConfigError";
  }
}

/** A document could not be rendered (missing message key, language mismatch, …). */
export class PublishRenderError extends Error {
  constructor(message: string) {
    super(`publish: ${message}`);
    this.name = "PublishRenderError";
  }
}

/** Remote target answered with a non-success status. */
export class PublishHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: string,
  ) {
    super(`publish: ${method} ${url} -> HTTP ${status}${body ? `: ${body}` : ""}`);
    this.name = "PublishHttpError";
  }
}

/** A remote response did not match the shape this driver depends on. */
export class PublishResponseError extends Error {
  constructor(what: string, issues: string[]) {
    super(`publish: unexpected ${what} response — ${issues.join("; ")}`);
    this.name = "PublishResponseError";
  }
}
