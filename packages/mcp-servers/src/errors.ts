/**
 * Errors this package raises. All of them are *refusals*, never failures of
 * the underlying system: a refusal is a decision the platform made on purpose
 * and must therefore be distinguishable, in the audit trail and in the error
 * text, from "Jira was down".
 */

/** A server definition that would violate a platform rule (M32/M37/M101). */
export class McpDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpDefinitionError";
  }
}

/** The caller's token does not carry the scope this tool declares (M101). */
export class ScopeDeniedError extends Error {
  constructor(
    readonly tool: string,
    readonly required: string,
    readonly granted: readonly string[],
  ) {
    super(`tool "${tool}" requires scope "${required}"; token grants: ${granted.join(", ") || "(none)"}`);
    this.name = "ScopeDeniedError";
  }
}

/** The tool exists in no server, or is hidden from this caller. */
export class UnknownToolError extends Error {
  constructor(
    readonly server: string,
    readonly tool: string,
  ) {
    super(`${server}: no tool named "${tool}"`);
    this.name = "UnknownToolError";
  }
}

/** Arguments failed the tool's Zod schema. */
export class ToolInputError extends Error {
  constructor(
    readonly tool: string,
    readonly issues: readonly string[],
  ) {
    super(`${tool}: invalid arguments — ${issues.join("; ")}`);
    this.name = "ToolInputError";
  }
}

/**
 * A handler refused on policy grounds — a protected path (M52), a repo the
 * caller's application record does not cover, a proposal that may not apply
 * itself. Handlers throw this instead of returning an error payload so a
 * refusal can never be mistaken for a successful result by an agent that only
 * reads `content`.
 */
export class ToolPolicyError extends Error {
  constructor(
    readonly tool: string,
    readonly rule: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolPolicyError";
  }
}

/** The audit sink refused or failed — the call is abandoned (M33/M101). */
export class ToolAuditError extends Error {
  constructor(
    readonly tool: string,
    readonly sinkFailure: unknown,
  ) {
    super(`${tool}: the call was not auditable, so it was not made`);
    this.name = "ToolAuditError";
  }
}
