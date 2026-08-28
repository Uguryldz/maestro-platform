import { IsoDateTime, NonEmpty } from "@maestro/contracts";
import { z } from "zod";

/**
 * Maestro Runner Agent protocol (M22) — MESSAGE SCHEMAS ONLY.
 *
 * Direction is the security property: mac/win runners dial OUT to Maestro over
 * gRPC/WebSocket and no port is ever opened towards a runner. This file
 * therefore contains no server, no socket and no listener; the transport lands
 * in Wave 3 and must keep the same direction. Replies are modelled as messages
 * the platform sends back down the connection the agent already opened.
 *
 * Direction is not identity, though. Anything that can reach the endpoint can
 * SAY it is `mac-mini-07`, so every registration carries a credential and the
 * platform verifies it (`agent-registry.ts`) — an unauthenticated `register`
 * that also displaced the previous session was a free way to take a real
 * machine's place in the pool.
 */

export const AGENT_PROTOCOL_VERSION = 1;

/** Platforms served by an agent. `docker-linux` handles the linux profiles (M21). */
export const AgentPlatform = z.enum(["macos-xcode", "windows-dotnet"]);
export type AgentPlatform = z.infer<typeof AgentPlatform>;

export const AgentId = z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/);

/**
 * Session id. Minted by the platform and used by the agent as a bearer
 * capability on every later message, so it must be unguessable: `randomUUID`
 * in production, and never derived from the agent id.
 */
export const SessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/);

/**
 * Shared secret proving the agent is the machine it claims to be. Long enough
 * that it cannot be guessed; it appears in NO reply, no session record and no
 * error message (see `AgentProtocolError` usage in the registry).
 */
export const AgentToken = z.string().min(24).max(512);

const LeaseIds = z.array(NonEmpty).max(64).default([]);

/** agent → platform: "I am here, this is what I can run." */
export const AgentRegister = z.object({
  type: z.literal("register"),
  protocolVersion: z.number().int(),
  agentId: AgentId,
  platform: AgentPlatform,
  agentVersion: NonEmpty,
  /** Free-form capability labels (xcode-16, vs2022, android-sdk-35…). */
  labels: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)).max(32).default([]),
  maxConcurrency: z.number().int().min(1).max(16),
  startedAt: IsoDateTime,
  authToken: AgentToken,
  /**
   * "I know another session of mine is live, replace it." A restart says this;
   * a stranger saying it still has to authenticate first, and the platform
   * answers with the leases the displaced session was holding so they can be
   * rescheduled instead of silently lost.
   */
  takeover: z.boolean().default(false),
});
export type AgentRegister = z.infer<typeof AgentRegister>;

/**
 * agent → platform: liveness + what it BELIEVES it holds. The list is a
 * declaration, not a fact: the platform keeps its own lease table and only
 * compares (see `AgentRegistry.heartbeat`).
 */
export const AgentHeartbeat = z.object({
  type: z.literal("heartbeat"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  at: IsoDateTime,
  activeLeases: LeaseIds,
  healthy: z.boolean(),
  /** Machine-readable reason when unhealthy; user-facing text lives in the catalog (M104). */
  reasonKey: NonEmpty.optional(),
});
export type AgentHeartbeat = z.infer<typeof AgentHeartbeat>;

/** agent → platform: orderly shutdown, so the slots free immediately. */
export const AgentBye = z.object({
  type: z.literal("bye"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  at: IsoDateTime,
  reasonKey: NonEmpty.optional(),
});
export type AgentBye = z.infer<typeof AgentBye>;

/**
 * Kill-switch level as the agent sees it (M58).
 *
 * The BFF models "nothing is stopped" as the absence of a broadcast; the agent
 * needs it as an explicit value, because a reply has to be able to say "clear"
 * as loudly as it says "stop". An agent that cannot distinguish "off" from "I
 * did not hear" has to choose, and either choice is wrong.
 */
export const AgentKillLevel = z.enum(["off", "pause_intake", "stop_all"]);
export type AgentKillLevel = z.infer<typeof AgentKillLevel>;

/**
 * A job the platform hands down, plus the lease that carries it.
 *
 * Work is LEASED, never assigned: an agent that dies mid-build must not take
 * the job with it, and an agent whose lease expired must not still be running
 * one. `leaseExpiresAt` is the absolute deadline past which the platform may
 * hand the same job to somebody else — which is why the executing agent has to
 * renew, and has to stop when a renewal is refused.
 */
export const LeasedJob = z.object({
  leaseId: NonEmpty,
  runId: NonEmpty,
  workspaceKey: NonEmpty,
  command: z.array(NonEmpty).min(1),
  timeoutSeconds: z.number().int().min(1),
  env: z.record(z.string(), z.string()).default({}),
  leaseExpiresAt: IsoDateTime,
});
export type LeasedJob = z.infer<typeof LeasedJob>;

/** agent → platform: "I have room for `max` jobs." Never more than free capacity. */
export const AgentPull = z.object({
  type: z.literal("pull"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  at: IsoDateTime,
  max: z.number().int().min(1).max(16),
});
export type AgentPull = z.infer<typeof AgentPull>;

/** agent → platform: extend a lease that is still being worked on. */
export const AgentLeaseRenew = z.object({
  type: z.literal("lease_renew"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  leaseId: NonEmpty,
  at: IsoDateTime,
});
export type AgentLeaseRenew = z.infer<typeof AgentLeaseRenew>;

/** Which pipe one chunk of streamed output came from. */
export const LogStream = z.enum(["stdout", "stderr"]);
export type LogStream = z.infer<typeof LogStream>;

/**
 * agent → platform: one chunk of sandbox output.
 *
 * `text` is MASKED before this object is built — known secrets first, then the
 * institutional PII boundary. Order matters: a token that happens to look like
 * an account number would otherwise become a REVERSIBLE `[ACCOUNT_n]` token
 * rather than being destroyed. Nothing on this path may carry a raw secret,
 * because the platform persists what it receives.
 */
export const AgentLogChunk = z.object({
  type: z.literal("log_chunk"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  leaseId: NonEmpty,
  runId: NonEmpty,
  stream: LogStream,
  text: z.string(),
  at: IsoDateTime,
});
export type AgentLogChunk = z.infer<typeof AgentLogChunk>;

/** agent → platform: terminal outcome of a leased job; releases the lease. */
export const AgentJobCompleted = z.object({
  type: z.literal("job_completed"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  leaseId: NonEmpty,
  runId: NonEmpty,
  outcome: z.enum(["succeeded", "failed", "cancelled", "abandoned"]),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().min(0),
  /** Message-catalog key (M104) — never a rendered sentence, never a payload. */
  reasonKey: NonEmpty.optional(),
  at: IsoDateTime,
});
export type AgentJobCompleted = z.infer<typeof AgentJobCompleted>;

/** Everything an agent may say. Outbound only. */
export const AgentMessage = z.discriminatedUnion("type", [
  AgentRegister,
  AgentHeartbeat,
  AgentBye,
  AgentPull,
  AgentLeaseRenew,
  AgentLogChunk,
  AgentJobCompleted,
]);
export type AgentMessage = z.infer<typeof AgentMessage>;

export const RegisterAccepted = z.object({
  type: z.literal("register_accepted"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  heartbeatIntervalSeconds: z.number().int().min(1).max(300),
  /** A lease the platform stops trusting if no heartbeat renews it. */
  leaseTtlSeconds: z.number().int().min(1).max(3_600),
  serverTime: IsoDateTime,
});
export type RegisterAccepted = z.infer<typeof RegisterAccepted>;

export const HeartbeatAck = z.object({
  type: z.literal("heartbeat_ack"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  nextIntervalSeconds: z.number().int().min(1).max(300),
  /** Leases the agent must abandon (revoked, or unknown to the platform). */
  revokedLeases: LeaseIds,
  serverTime: IsoDateTime,
});
export type HeartbeatAck = z.infer<typeof HeartbeatAck>;

/**
 * platform → agent: the jobs granted, and the kill-switch level in the SAME
 * reply.
 *
 * Bundling them is deliberate. A separate kill-switch poll can be the one
 * request that fails, and an agent that keeps pulling work because it could not
 * read the switch is exactly the failure M58 exists to prevent. Here the switch
 * arrives on the only path that hands out work: no jobs can be granted without
 * the level travelling beside them.
 */
export const PullGranted = z.object({
  type: z.literal("pull_reply"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  jobs: z.array(LeasedJob).max(16).default([]),
  killLevel: AgentKillLevel,
  serverTime: IsoDateTime,
});
export type PullGranted = z.infer<typeof PullGranted>;

/**
 * platform → agent: whether the lease is still the agent's, and the current
 * kill level.
 *
 * `granted: false` means STOP, not "retry": the platform has given the job to
 * somebody else, and a second executor is a double-run — two sandboxes writing
 * the same workspace, two PRs, two sets of comments. Carrying `killLevel` here
 * as well is what stops a long build mid-flight; the level read at pull time is
 * already stale by the time a twenty-minute compile finishes.
 */
export const LeaseRenewed = z.object({
  type: z.literal("lease_renew_reply"),
  protocolVersion: z.number().int(),
  leaseId: NonEmpty,
  granted: z.boolean(),
  leaseExpiresAt: IsoDateTime.optional(),
  killLevel: AgentKillLevel,
  serverTime: IsoDateTime,
});
export type LeaseRenewed = z.infer<typeof LeaseRenewed>;

export const PlatformReply = z.discriminatedUnion("type", [
  RegisterAccepted,
  HeartbeatAck,
  PullGranted,
  LeaseRenewed,
]);
export type PlatformReply = z.infer<typeof PlatformReply>;
