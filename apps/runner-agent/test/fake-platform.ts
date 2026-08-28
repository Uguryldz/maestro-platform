import { AGENT_PROTOCOL_VERSION } from "@maestro/runners";
import { PlatformClient, type FetchLike } from "../src/platform-client.js";
import type { AgentKillLevel, LeasedJob } from "../src/protocol.js";

/**
 * An in-memory platform, driven through the REAL `PlatformClient` over a fake
 * `fetch`. Going through the real client on purpose: it means the tests also
 * cover request building, schema validation and reply parsing, rather than
 * asserting against a hand-written stub that could drift from the wire format.
 */

export interface RecordedRequest {
  endpoint: string;
  body: Record<string, unknown>;
}

export class FakePlatform {
  readonly requests: RecordedRequest[] = [];
  /** Jobs handed out on the next `pull`. Consumed, so a second pull gets nothing. */
  queue: LeasedJob[] = [];
  killLevel: AgentKillLevel = "off";
  sessionId = "sess-abcdefgh";
  heartbeatIntervalSeconds = 15;
  leaseTtlSeconds = 300;
  revokedLeases: string[] = [];
  /** Leases the platform refuses to renew — the reassignment case. */
  refuseRenewal = new Set<string>();
  renewExtendsToIso?: string;
  /** Endpoints that must fail, to exercise the degraded paths. */
  failing = new Set<string>();
  serverTime = "2026-01-01T00:00:00.000Z";

  readonly fetch: FetchLike = async (url, init) => {
    const endpoint = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    this.requests.push({ endpoint, body });

    if (this.failing.has(endpoint)) {
      return await Promise.resolve(new Response("", { status: 503 }));
    }
    const reply = this.#reply(endpoint, body);
    if (reply === undefined) return await Promise.resolve(new Response(null, { status: 204 }));
    return await Promise.resolve(
      new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };

  /** Requests recorded for one endpoint. */
  sent(endpoint: string): Record<string, unknown>[] {
    return this.requests.filter((entry) => entry.endpoint === endpoint).map((entry) => entry.body);
  }

  client(options: { requestTimeoutMs?: number; token?: () => Promise<string> } = {}): PlatformClient {
    return new PlatformClient({
      baseUrl: "https://maestro.internal",
      fetch: this.fetch,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      token: options.token ?? (() => Promise.resolve("a".repeat(32))),
    });
  }

  #reply(endpoint: string, body: Record<string, unknown>): Record<string, unknown> | undefined {
    switch (endpoint) {
      case "/agent/register":
        return {
          type: "register_accepted",
          protocolVersion: AGENT_PROTOCOL_VERSION,
          sessionId: this.sessionId,
          heartbeatIntervalSeconds: this.heartbeatIntervalSeconds,
          leaseTtlSeconds: this.leaseTtlSeconds,
          serverTime: this.serverTime,
        };
      case "/agent/heartbeat":
        return {
          type: "heartbeat_ack",
          protocolVersion: AGENT_PROTOCOL_VERSION,
          sessionId: this.sessionId,
          nextIntervalSeconds: this.heartbeatIntervalSeconds,
          revokedLeases: this.revokedLeases,
          serverTime: this.serverTime,
        };
      case "/agent/pull": {
        const max = Number(body["max"]);
        const jobs = this.queue.splice(0, max);
        return {
          type: "pull_reply",
          protocolVersion: AGENT_PROTOCOL_VERSION,
          sessionId: this.sessionId,
          jobs,
          killLevel: this.killLevel,
          serverTime: this.serverTime,
        };
      }
      case "/agent/lease/renew": {
        const leaseId = String(body["leaseId"]);
        return {
          type: "lease_renew_reply",
          protocolVersion: AGENT_PROTOCOL_VERSION,
          leaseId,
          granted: !this.refuseRenewal.has(leaseId),
          ...(this.renewExtendsToIso === undefined ? {} : { leaseExpiresAt: this.renewExtendsToIso }),
          killLevel: this.killLevel,
          serverTime: this.serverTime,
        };
      }
      default:
        // logs, job completion, bye — 204, no body.
        return undefined;
    }
  }
}
