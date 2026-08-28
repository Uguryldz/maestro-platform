/**
 * @maestro/mcp-servers — the four MCP servers Maestro runs (M37 · M101).
 *
 *  · `jira-mcp`      — read the ticket, its comments and its neighbourhood.
 *                      No write tool: writing to Jira is a workflow activity.
 *  · `ado-mcp`       — repository, pull request, review threads and diffs;
 *                      one write, `reply_thread`, for the 12b rework loop.
 *  · `workspace-mcp` — the sandbox filesystem, with `protected_paths` (M52)
 *                      enforced at the tool boundary rather than afterwards.
 *  · `maestro-mcp`   — the platform managing itself with the caller's own
 *                      RBAC. It lists and summarises gates; it never decides
 *                      one. `approve_gate`, `reject_gate` and `merge_pr` are
 *                      absent by design and refused by construction — see
 *                      `forbidden-tools.ts`.
 *
 * Everything here takes its collaborators by injection (M44): no driver, no
 * database and no HTTP framework is imported, so every rule in this package is
 * exercised offline by ordinary unit tests.
 */

export { McpDefinitionError, ScopeDeniedError, ToolAuditError, ToolInputError, ToolPolicyError, UnknownToolError } from "./errors.js";

export { grantedScopes, hasScope, sealCaller, TOOL_SCOPES, ToolScope } from "./scopes.js";
export type { CallerIdentity } from "./scopes.js";

export {
  assertReadOnlyServer,
  defineServer,
  defineTool,
  serverScopes,
} from "./tool.js";
export type { ServerDefinition, ToolCallContext, ToolDefinition, ToolSpec } from "./tool.js";

export {
  assertNoGateDecisionTools,
  FORBIDDEN_TOOL_NAMES,
  isGateDecisionToolName,
  normaliseToolName,
} from "./forbidden-tools.js";

export { aiViaActor, InMemoryToolAuditSink } from "./audit.js";
export type { ToolAuditRecord, ToolAuditSink, ToolOutcome } from "./audit.js";

export { McpServerRuntime, UNRESOLVED_SUBJECT } from "./runtime.js";
export type { ServerRuntimeDeps, ToolCallResult, ToolDenialReason, ToolListing } from "./runtime.js";

export { guardWorkspacePath, isUnreadablePath, unreadablePatterns, workspaceMatcher } from "./workspace-path.js";
export type { ProtectedPathMatcher } from "./workspace-path.js";

export { assertSearchGlob, redactSearchHits } from "./workspace-glob.js";

export { allowedOnIdeChannel, maskForIde } from "./ide-boundary.js";
export type { IdeMaskedHook, IdePiiOptions, MaybeClassified } from "./ide-boundary.js";

export { bindMcpServer, toCallToolResult } from "./transport.js";
export { serveStdio, serveStreamableHttp } from "./transports.js";

export { jiraMcpServer } from "./servers/jira.js";
export type { JiraComment, JiraMcpDeps, JiraReadAccess, RelatedTicket } from "./servers/jira.js";

export { adoMcpServer } from "./servers/ado.js";
export type { AdoDiffAccess, AdoMcpDeps, ApplicationLookup, PrDiff } from "./servers/ado.js";

export {
  workspaceMcpServer,
  workspaceProtectedPatterns,
  workspaceUnreadablePatterns,
} from "./servers/workspace.js";
export type {
  WorkspaceEntry,
  WorkspaceFileContent,
  WorkspaceFs,
  WorkspaceMatch,
  WorkspaceMcpDeps,
} from "./servers/workspace.js";

export { maestroMcpServer } from "./servers/maestro.js";
export type { MaestroMcpDeps } from "./servers/maestro.js";
export type {
  KillSwitchLevel,
  KillSwitchProposal,
  KnowledgeHit,
  MaestroPlatform,
  ParamChangeProposal,
  ParamView,
  PendingGate,
  QuotaStatus,
  RunDetail,
  RunnerHealth,
} from "./servers/maestro-platform.js";
