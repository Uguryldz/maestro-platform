import {
  AGENT_PROTOCOL_VERSION,
  AgentBye,
  AgentHeartbeat,
  AgentRegister,
  HeartbeatAck,
  RegisterAccepted,
} from "@maestro/runners";
import type { z } from "zod";
import { PlatformHttpError, PlatformProtocolError } from "./errors.js";
import {
  JobCompletion,
  LeaseRenew,
  LeaseRenewReply,
  LogChunk,
  PullReply,
  PullRequest,
} from "./protocol.js";

/**
 * The agent's ONE outbound channel to the platform (M22).
 *
 * Every method here is the agent DIALLING OUT. There is no server, no
 * listener and no port in this app — that is the whole security property of
 * the runner agent, and this file is where it would be violated first.
 *
 * `fetch` is injected so the default test suite never touches the network.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PlatformClientOptions {
  baseUrl: string;
  fetch: FetchLike;
  requestTimeoutMs: number;
  /**
   * Resolves the shared secret. A FUNCTION, not a string, so the token is
   * fetched when it is used and this object never becomes a place where a
   * credential sits waiting to be logged by a careless `JSON.stringify`.
   */
  token: () => Promise<string>;
}

/** Endpoints. Kept together so the paths the agent can reach are enumerable. */
const ENDPOINTS = {
  register: "/agent/register",
  heartbeat: "/agent/heartbeat",
  bye: "/agent/bye",
  pull: "/agent/pull",
  renew: "/agent/lease/renew",
  logs: "/agent/logs",
  complete: "/agent/job/complete",
} as const;

export class PlatformClient {
  readonly #options: PlatformClientOptions;

  constructor(options: PlatformClientOptions) {
    this.#options = options;
  }

  register(message: Omit<AgentRegister, "protocolVersion" | "authToken">): Promise<RegisterAccepted> {
    // The token is attached HERE and nowhere else, so no caller ever holds a
    // message object with a live credential in it.
    return this.#send(ENDPOINTS.register, AgentRegister, RegisterAccepted, message, true);
  }

  heartbeat(message: Omit<AgentHeartbeat, "protocolVersion">): Promise<HeartbeatAck> {
    return this.#send(ENDPOINTS.heartbeat, AgentHeartbeat, HeartbeatAck, message, false);
  }

  async bye(message: Omit<AgentBye, "protocolVersion">): Promise<void> {
    await this.#post(ENDPOINTS.bye, AgentBye.parse({ ...message, protocolVersion: AGENT_PROTOCOL_VERSION }));
  }

  pull(message: Omit<PullRequest, "protocolVersion" | "type">): Promise<PullReply> {
    return this.#send(ENDPOINTS.pull, PullRequest, PullReply, { ...message, type: "pull" }, false);
  }

  renewLease(message: Omit<LeaseRenew, "protocolVersion" | "type">): Promise<LeaseRenewReply> {
    return this.#send(ENDPOINTS.renew, LeaseRenew, LeaseRenewReply, { ...message, type: "lease_renew" }, false);
  }

  async sendLog(message: Omit<LogChunk, "protocolVersion" | "type">): Promise<void> {
    const body = LogChunk.parse({ ...message, type: "log_chunk", protocolVersion: AGENT_PROTOCOL_VERSION });
    await this.#post(ENDPOINTS.logs, body);
  }

  async completeJob(message: Omit<JobCompletion, "protocolVersion" | "type">): Promise<void> {
    const body = JobCompletion.parse({
      ...message,
      type: "job_completed",
      protocolVersion: AGENT_PROTOCOL_VERSION,
    });
    await this.#post(ENDPOINTS.complete, body);
  }

  /** Builds, validates, posts and parses one request/reply pair. */
  async #send<TOut, TIn>(
    endpoint: string,
    request: z.ZodType<TOut>,
    reply: z.ZodType<TIn>,
    payload: unknown,
    withToken: boolean,
  ): Promise<TIn> {
    const draft = {
      ...(payload as Record<string, unknown>),
      protocolVersion: AGENT_PROTOCOL_VERSION,
      ...(withToken ? { authToken: await this.#options.token() } : {}),
    };
    const parsed = request.safeParse(draft);
    if (!parsed.success) {
      // Never echoes the payload: for `register` it holds the shared secret.
      throw new PlatformProtocolError(
        endpoint,
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
      );
    }
    const body = await this.#post(endpoint, parsed.data);
    const answer = reply.safeParse(body);
    if (!answer.success) {
      throw new PlatformProtocolError(
        endpoint,
        `reply is not usable: ${answer.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ")}`,
      );
    }
    return answer.data;
  }

  async #post(endpoint: string, body: unknown): Promise<unknown> {
    const url = `${this.#options.baseUrl.replace(/\/+$/, "")}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#options.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#options.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // The cause is named by TYPE only — a fetch error can stringify the URL
      // and, on some runtimes, the request body with it.
      throw new PlatformProtocolError(endpoint, error instanceof Error ? error.name : "request failed");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new PlatformHttpError(response.status, endpoint);
    // `bye` and the fire-and-forget posts answer 204 with no body.
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new PlatformProtocolError(endpoint, "reply is not valid JSON");
    }
  }
}
