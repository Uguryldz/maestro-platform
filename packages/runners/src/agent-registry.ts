import { createHash, timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import {
  AGENT_PROTOCOL_VERSION,
  AgentBye,
  AgentHeartbeat,
  type AgentPlatform,
  AgentRegister,
  type HeartbeatAck,
  HeartbeatAck as HeartbeatAckSchema,
  type RegisterAccepted,
  RegisterAccepted as RegisterAcceptedSchema,
  SessionId,
} from "./agent-protocol.js";
import type { Clock, IdSource } from "./deps.js";
import { AgentProtocolError, RunnerCapacityError } from "./errors.js";

/**
 * Registration + heartbeat state for outbound agents (M22). Wave 3 wires a
 * transport to it; the rules live here so they can be tested without one:
 *
 * - **Identity is proven, not claimed.** Reaching the endpoint is not being the
 *   Mac mini: a registration authenticates, and taking over a LIVE session is
 *   something the message has to ask for explicitly (the displaced leases come
 *   back so the platform can reschedule them).
 * - **The platform owns the lease table.** A heartbeat DECLARES what the agent
 *   thinks it holds; capacity is decided by what the platform actually
 *   assigned. An agent reporting "no leases" used to look idle for ever and
 *   could be handed unlimited work.
 * - **The agent's clock is never trusted** for liveness, and silence means gone.
 */

export type AgentAuthenticator = (agentId: string, token: string) => boolean;

/**
 * Constant-time shared-secret check. Both sides are hashed first so the
 * comparison is over equal-length buffers — `timingSafeEqual` throws otherwise,
 * and the LENGTH of a secret should not be observable through an exception.
 */
export function sharedSecretAuthenticator(secrets: Readonly<Record<string, string>>): AgentAuthenticator {
  const digests = new Map<string, Buffer>();
  for (const [agentId, secret] of Object.entries(secrets)) {
    digests.set(agentId, createHash("sha256").update(secret, "utf8").digest());
  }
  return (agentId, token) => {
    const expected = digests.get(agentId);
    if (expected === undefined) return false;
    return timingSafeEqual(expected, createHash("sha256").update(token, "utf8").digest());
  };
}

export interface AgentSession {
  sessionId: string;
  agentId: string;
  platform: AgentPlatform;
  agentVersion: string;
  labels: string[];
  maxConcurrency: number;
  registeredAt: string;
  /** Server-side timestamp — the agent's own clock is never trusted for liveness. */
  lastSeenAt: string;
  /** Leases the PLATFORM assigned. The only list capacity is computed from. */
  activeLeases: string[];
  /** What the agent last claimed to hold. Diagnostic only. */
  declaredLeases: string[];
  healthy: boolean;
}

export interface AgentRegistryOptions {
  clock: Clock;
  newId: IdSource;
  /** Verifies the credential in `AgentRegister`. Required: there is no "no auth" mode. */
  authenticate: AgentAuthenticator;
  heartbeatIntervalSeconds?: number;
  /** Missed beats before a session is considered gone (default 3). */
  missedBeatsBeforeStale?: number;
  leaseTtlSeconds?: number;
}

/** What a registration produced, including the leases a takeover orphaned. */
export interface RegisterOutcome {
  reply: RegisterAccepted;
  displacedLeases: string[];
}

const DEFAULT_HEARTBEAT_SECONDS = 15;
const DEFAULT_MISSED_BEATS = 3;
const DEFAULT_LEASE_TTL_SECONDS = 300;

export class AgentRegistry {
  readonly #sessions = new Map<string, AgentSession>();
  readonly #byAgent = new Map<string, string>();
  readonly #options: AgentRegistryOptions;
  readonly #intervalSeconds: number;
  readonly #missedBeats: number;
  readonly #leaseTtlSeconds: number;

  constructor(options: AgentRegistryOptions) {
    this.#options = options;
    this.#intervalSeconds = options.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
    this.#missedBeats = options.missedBeatsBeforeStale ?? DEFAULT_MISSED_BEATS;
    this.#leaseTtlSeconds = options.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
  }

  /**
   * Registers (or, on request, takes over) an agent. Two live sessions for one
   * agent id would double-count its capacity, so the second one either replaces
   * the first — explicitly — or is refused.
   */
  register(message: unknown): RegisterOutcome {
    const parsed = this.#parse(AgentRegister, message);
    if (!this.#options.authenticate(parsed.agentId, parsed.authToken)) {
      // Deliberately says nothing about which half was wrong, and never quotes
      // the credential itself.
      throw new AgentProtocolError(parsed.agentId, "authentication failed");
    }
    this.expire();

    const displacedLeases: string[] = [];
    const previousId = this.#byAgent.get(parsed.agentId);
    const previous = previousId === undefined ? undefined : this.#sessions.get(previousId);
    if (previous !== undefined) {
      if (!parsed.takeover) {
        throw new AgentProtocolError(parsed.agentId, "agent already has a live session — send takeover to replace it");
      }
      displacedLeases.push(...previous.activeLeases);
      this.#sessions.delete(previous.sessionId);
    }

    const sessionId = SessionId.parse(this.#options.newId());
    const now = this.#options.clock().toISOString();
    this.#sessions.set(sessionId, {
      sessionId,
      agentId: parsed.agentId,
      platform: parsed.platform,
      agentVersion: parsed.agentVersion,
      labels: parsed.labels,
      maxConcurrency: parsed.maxConcurrency,
      registeredAt: now,
      lastSeenAt: now,
      activeLeases: [],
      declaredLeases: [],
      healthy: true,
    });
    this.#byAgent.set(parsed.agentId, sessionId);

    const reply = RegisterAcceptedSchema.parse({
      type: "register_accepted",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId,
      heartbeatIntervalSeconds: this.#intervalSeconds,
      leaseTtlSeconds: this.#leaseTtlSeconds,
      serverTime: now,
    });
    return { reply, displacedLeases };
  }

  /** Renews a session. An unknown, replaced or already-expired session is refused. */
  heartbeat(message: unknown): HeartbeatAck {
    const parsed = this.#parse(AgentHeartbeat, message);
    const session = this.#live(parsed.sessionId, parsed.agentId);

    // The declaration is COMPARED, never adopted: whatever the agent claims to
    // hold that the platform did not assign, it must drop.
    const revokedLeases = parsed.activeLeases.filter((lease) => !session.activeLeases.includes(lease));
    session.declaredLeases = [...parsed.activeLeases];
    session.healthy = parsed.healthy;
    session.lastSeenAt = this.#options.clock().toISOString();

    return HeartbeatAckSchema.parse({
      type: "heartbeat_ack",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId: session.sessionId,
      nextIntervalSeconds: this.#intervalSeconds,
      revokedLeases,
      serverTime: session.lastSeenAt,
    });
  }

  /** Orderly disconnect. Returns the leases the platform must reschedule. */
  bye(message: unknown): string[] {
    const parsed = this.#parse(AgentBye, message);
    const session = this.#sessions.get(parsed.sessionId);
    if (session === undefined || session.agentId !== parsed.agentId) {
      throw new AgentProtocolError(parsed.agentId, "session is unknown or expired");
    }
    this.#drop(session);
    return [...session.activeLeases];
  }

  /** Scheduler side of the lease table: capacity is enforced here, not by the agent. */
  assignLease(sessionId: string, leaseId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new AgentProtocolError(sessionId, "session is unknown or expired");
    if (session.activeLeases.includes(leaseId)) return;
    if (session.activeLeases.length >= session.maxConcurrency) {
      throw new RunnerCapacityError(session.platform, session.maxConcurrency);
    }
    session.activeLeases.push(leaseId);
  }

  /** Releases one assigned lease. False when the platform had no such lease. */
  completeLease(sessionId: string, leaseId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return false;
    const index = session.activeLeases.indexOf(leaseId);
    if (index < 0) return false;
    session.activeLeases.splice(index, 1);
    return true;
  }

  /**
   * Drops sessions that missed too many heartbeats and returns them, so the
   * caller can reschedule their leases. Silence means gone (fail-closed): a
   * disconnected Mac mini must not keep a ticket's slot forever.
   */
  expire(): AgentSession[] {
    const deadline = this.#options.clock().getTime() - this.#intervalSeconds * this.#missedBeats * 1_000;
    const stale = [...this.#sessions.values()].filter((session) => Date.parse(session.lastSeenAt) < deadline);
    for (const session of stale) this.#drop(session);
    return stale;
  }

  /** Live sessions, optionally for one platform. Expired ones are swept first. */
  sessions(platform?: AgentPlatform): AgentSession[] {
    this.expire();
    const all = [...this.#sessions.values()];
    return platform === undefined ? all : all.filter((session) => session.platform === platform);
  }

  /** Sessions that can take work right now: alive, healthy, below concurrency. */
  available(platform: AgentPlatform): AgentSession[] {
    return this.sessions(platform).filter(
      (session) => session.healthy && session.activeLeases.length < session.maxConcurrency,
    );
  }

  #live(sessionId: string, agentId: string): AgentSession {
    this.expire();
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new AgentProtocolError(agentId, "session is unknown or expired");
    if (session.agentId !== agentId) throw new AgentProtocolError(agentId, "session belongs to another agent");
    return session;
  }

  #drop(session: AgentSession): void {
    this.#sessions.delete(session.sessionId);
    if (this.#byAgent.get(session.agentId) === session.sessionId) this.#byAgent.delete(session.agentId);
  }

  #parse<T extends { agentId: string; protocolVersion: number }>(schema: z.ZodType<T>, message: unknown): T {
    const result = schema.safeParse(message);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      const agentId = (message as { agentId?: unknown } | null)?.agentId;
      throw new AgentProtocolError(typeof agentId === "string" ? agentId : "(unknown)", issues);
    }
    if (result.data.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      throw new AgentProtocolError(
        result.data.agentId,
        `protocol version ${result.data.protocolVersion} is not supported (expected ${AGENT_PROTOCOL_VERSION})`,
      );
    }
    return result.data;
  }
}
