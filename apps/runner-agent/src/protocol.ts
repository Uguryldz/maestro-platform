/**
 * The agent's view of the wire protocol — now a RE-EXPORT, not a definition.
 *
 * These schemas were written here because `@maestro/runners/agent-protocol` is
 * a frozen file and carried only register/heartbeat/bye; leased work, the
 * kill-switch level and log streaming had nowhere to live. The builder did the
 * right thing by not forking the frozen half, and filed the shapes as an
 * interface request instead.
 *
 * The orchestrator has since moved them into the package (2026-08-09), which is
 * where they belong: the platform side has to parse exactly what the agent
 * sends, and two copies of a wire schema drift the moment one side adds a
 * field. This file stays as the app's local name for them so the nine importing
 * modules keep reading the way they were written.
 *
 * Two names changed in the move, to sit inside the package's own `Agent*`
 * naming and its discriminated unions: `PullReply` → `PullGranted` and
 * `LeaseRenewReply` → `LeaseRenewed`. They are aliased below.
 */

export {
  AGENT_PROTOCOL_VERSION,
  AgentId,
  AgentJobCompleted as JobCompletion,
  AgentKillLevel,
  AgentLeaseRenew as LeaseRenew,
  AgentLogChunk as LogChunk,
  AgentPull as PullRequest,
  LeasedJob,
  LeaseRenewed as LeaseRenewReply,
  LogStream,
  PullGranted as PullReply,
  SessionId,
} from "@maestro/runners";
