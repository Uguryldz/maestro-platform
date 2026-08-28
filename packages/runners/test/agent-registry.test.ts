import { describe, expect, it } from "vitest";
import { AGENT_PROTOCOL_VERSION, HeartbeatAck, RegisterAccepted } from "../src/agent-protocol.js";
import { sharedSecretAuthenticator } from "../src/agent-registry.js";
import { AgentProtocolError, RunnerCapacityError } from "../src/errors.js";
import { AGENT_TOKEN, byeMessage, heartbeatMessage, REGISTER, registryRig } from "./agent-helpers.js";

describe("registration is authenticated (M22)", () => {
  it("accepts an agent that proves who it is, and hands back a session", () => {
    const { agents } = registryRig();

    const { reply, displacedLeases } = agents.register(REGISTER);

    expect(RegisterAccepted.parse(reply)).toEqual(reply);
    expect(reply).toMatchObject({ sessionId: "session-00000001", heartbeatIntervalSeconds: 10 });
    expect(displacedLeases).toEqual([]);
    expect(agents.sessions("macos-xcode")).toHaveLength(1);
  });

  it("refuses a wrong credential, an unknown agent and a borrowed secret — and echoes none of them", () => {
    const { agents } = registryRig();
    const wrong = "wrong-token-but-the-right-length!!!!!";

    const failure = (() => {
      try {
        agents.register({ ...REGISTER, authToken: wrong });
      } catch (error) {
        return error as Error;
      }
    })();

    expect(failure).toBeInstanceOf(AgentProtocolError);
    expect(failure?.message).toMatch(/authentication/i);
    expect(failure?.message).not.toContain(wrong);
    expect(() => agents.register({ ...REGISTER, agentId: "mac-mini-99" })).toThrow(/authentication/i);
    expect(() => agents.register({ ...REGISTER, authToken: "another-secret-token-for-win-03" })).toThrow(
      /authentication/i,
    );
    expect(agents.sessions()).toHaveLength(0);
  });

  it("compares secrets of different lengths without blowing up", () => {
    const authenticate = sharedSecretAuthenticator({ a: "short-secret-value-0001" });

    expect(authenticate("a", "a-very-much-longer-secret-value-that-differs")).toBe(false);
    expect(authenticate("a", "short-secret-value-0001")).toBe(true);
    expect(authenticate("b", "short-secret-value-0001")).toBe(false);
  });

  it("refuses an unsupported protocol version instead of guessing the shape", () => {
    const { agents } = registryRig();

    expect(() => agents.register({ ...REGISTER, protocolVersion: 99 })).toThrow(/protocol version 99/);
  });

  it("refuses a malformed registration and names the offending field", () => {
    const { agents } = registryRig();

    expect(() => agents.register({ ...REGISTER, maxConcurrency: 99 })).toThrow(/maxConcurrency/);
  });
});

/**
 * O4, second half: `register` used to DELETE the previous session silently, so
 * a second registration was a free eviction of the real machine. Taking a live
 * session over is now something the message has to ask for.
 */
describe("taking a live session over is explicit", () => {
  it("refuses a second registration while the first session is alive", () => {
    const { agents } = registryRig();
    const first = agents.register(REGISTER);

    expect(() => agents.register(REGISTER)).toThrow(/already has a live session/);
    expect(agents.heartbeat(heartbeatMessage(first.reply.sessionId)).sessionId).toBe(first.reply.sessionId);
  });

  it("replaces the session when the agent asks for it, and reports the orphaned leases", () => {
    const { agents } = registryRig();
    const first = agents.register(REGISTER);
    agents.assignLease(first.reply.sessionId, "lease-a");

    const second = agents.register({ ...REGISTER, takeover: true });

    expect(second.reply.sessionId).not.toBe(first.reply.sessionId);
    expect(second.displacedLeases).toEqual(["lease-a"]);
    expect(agents.sessions()).toHaveLength(1);
    expect(() => agents.heartbeat(heartbeatMessage(first.reply.sessionId))).toThrow(AgentProtocolError);
  });

  it("lets a restarted agent re-register once its old session went stale", () => {
    const { agents, clock } = registryRig();
    agents.register(REGISTER);

    clock.advance(60_000);

    expect(() => agents.register(REGISTER)).not.toThrow();
    expect(agents.sessions()).toHaveLength(1);
  });
});

describe("heartbeat", () => {
  it("renews the session and echoes the interval", () => {
    const { agents } = registryRig();
    const { reply } = agents.register(REGISTER);

    const ack = agents.heartbeat(heartbeatMessage(reply.sessionId));

    expect(HeartbeatAck.parse(ack)).toEqual(ack);
    expect(ack.revokedLeases).toEqual([]);
  });

  it("uses the server clock, not the agent's, for liveness", () => {
    const { agents, clock } = registryRig("2026-08-08T14:20:00.000Z");
    const { reply } = agents.register(REGISTER);
    clock.advance(5_000);

    agents.heartbeat(heartbeatMessage(reply.sessionId, { at: "2019-01-01T00:00:00.000Z" }));

    expect(agents.sessions()[0]?.lastSeenAt).toBe("2026-08-08T14:20:05.000Z");
  });

  it("refuses a heartbeat for an unknown session", () => {
    const { agents } = registryRig();
    agents.register(REGISTER);

    expect(() => agents.heartbeat(heartbeatMessage("session-99999999"))).toThrow(/unknown or expired/);
  });

  it("refuses a session id borrowed by another agent", () => {
    const { agents } = registryRig();
    const { reply } = agents.register(REGISTER);

    expect(() => agents.heartbeat(heartbeatMessage(reply.sessionId, { agentId: "win-build-03" }))).toThrow(
      /another agent/,
    );
  });
});

/**
 * O5: the agent's own `activeLeases` list used to BE the platform's record of
 * what it was running. An agent that reported an empty list therefore looked
 * idle for ever and could be handed unlimited work. The platform's own table
 * decides now; the declaration is compared against it and nothing else.
 */
describe("the platform owns the lease table, the agent only declares", () => {
  it("keeps counting an assigned lease even when the agent claims to be idle", () => {
    const { agents } = registryRig();
    const { reply } = agents.register(REGISTER);
    agents.assignLease(reply.sessionId, "lease-a");
    agents.assignLease(reply.sessionId, "lease-b");

    agents.heartbeat(heartbeatMessage(reply.sessionId, { activeLeases: [] }));

    expect(agents.sessions()[0]?.activeLeases).toEqual(["lease-a", "lease-b"]);
    expect(agents.available("macos-xcode")).toHaveLength(0);
  });

  it("tells the agent to abandon a lease the platform never gave it", () => {
    const { agents } = registryRig();
    const { reply } = agents.register(REGISTER);
    agents.assignLease(reply.sessionId, "lease-a");

    const ack = agents.heartbeat(heartbeatMessage(reply.sessionId, { activeLeases: ["lease-a", "lease-ghost"] }));

    expect(ack.revokedLeases).toEqual(["lease-ghost"]);
    expect(agents.sessions()[0]?.activeLeases).toEqual(["lease-a"]);
  });

  it("keeps the declaration for diagnosis without letting it decide anything", () => {
    const { agents } = registryRig();
    const { reply } = agents.register(REGISTER);
    agents.assignLease(reply.sessionId, "lease-a");

    agents.heartbeat(heartbeatMessage(reply.sessionId, { activeLeases: [] }));

    expect(agents.sessions()[0]?.declaredLeases).toEqual([]);
    expect(agents.sessions()[0]?.activeLeases).toEqual(["lease-a"]);
  });

  it("refuses to assign past the agent's declared concurrency", () => {
    const { agents } = registryRig();
    const { reply } = agents.register(REGISTER);
    agents.assignLease(reply.sessionId, "lease-a");
    agents.assignLease(reply.sessionId, "lease-b");

    expect(() => agents.assignLease(reply.sessionId, "lease-c")).toThrow(RunnerCapacityError);
  });

  it("frees capacity when a lease completes, and ignores one it never had", () => {
    const { agents } = registryRig();
    const { reply } = agents.register(REGISTER);
    agents.assignLease(reply.sessionId, "lease-a");

    expect(agents.completeLease(reply.sessionId, "lease-a")).toBe(true);
    expect(agents.completeLease(reply.sessionId, "lease-a")).toBe(false);
    expect(agents.available("macos-xcode")).toHaveLength(1);
  });

  it("refuses to assign onto a session that is gone", () => {
    const { agents } = registryRig();

    expect(() => agents.assignLease("session-00000009", "lease-a")).toThrow(AgentProtocolError);
  });
});

describe("expiry — silence means gone (fail-closed)", () => {
  it("drops a session that missed the allowed number of beats", () => {
    const { agents, clock } = registryRig();
    agents.register(REGISTER);

    clock.advance(29_000);
    expect(agents.sessions()).toHaveLength(1);

    clock.advance(2_000);
    const stale = agents.expire();

    expect(stale).toHaveLength(1);
    expect(agents.sessions()).toHaveLength(0);
  });

  it("returns the leases of an expired session so they can be rescheduled", () => {
    const { agents, clock } = registryRig();
    const { reply } = agents.register(REGISTER);
    agents.assignLease(reply.sessionId, "lease-a");

    clock.advance(60_000);

    expect(agents.expire()[0]?.activeLeases).toEqual(["lease-a"]);
  });

  it("lets a heartbeat inside the window keep the session alive", () => {
    const { agents, clock } = registryRig();
    const { reply } = agents.register(REGISTER);

    for (let beat = 0; beat < 5; beat += 1) {
      clock.advance(10_000);
      agents.heartbeat(heartbeatMessage(reply.sessionId));
    }

    expect(agents.sessions()).toHaveLength(1);
  });
});

describe("availability and shutdown", () => {
  it("hides unhealthy and fully-loaded agents from the available list", () => {
    const { agents } = registryRig();
    const { reply } = agents.register(REGISTER);

    expect(agents.available("macos-xcode")).toHaveLength(1);

    agents.assignLease(reply.sessionId, "a");
    agents.assignLease(reply.sessionId, "b");
    expect(agents.available("macos-xcode")).toHaveLength(0);

    agents.completeLease(reply.sessionId, "a");
    agents.completeLease(reply.sessionId, "b");
    agents.heartbeat(heartbeatMessage(reply.sessionId, { healthy: false, reasonKey: "disk_full" }));
    expect(agents.available("macos-xcode")).toHaveLength(0);
  });

  it("does not offer an agent of another platform", () => {
    const { agents } = registryRig();
    agents.register(REGISTER);

    expect(agents.available("windows-dotnet")).toHaveLength(0);
  });

  it("frees the leases of an agent that says goodbye", () => {
    const { agents } = registryRig();
    const { reply } = agents.register(REGISTER);
    agents.assignLease(reply.sessionId, "lease-a");

    const orphaned = agents.bye(byeMessage(reply.sessionId));

    expect(orphaned).toEqual(["lease-a"]);
    expect(agents.sessions()).toHaveLength(0);
  });

  it("refuses a goodbye for a session that is not the sender's", () => {
    const { agents } = registryRig();
    agents.register(REGISTER);

    expect(() => agents.bye(byeMessage("session-00000009"))).toThrow(AgentProtocolError);
  });

  it("refuses a goodbye whose protocol version is not ours", () => {
    const { agents } = registryRig();
    const { reply } = agents.register(REGISTER);

    expect(() => agents.bye(byeMessage(reply.sessionId, { protocolVersion: AGENT_PROTOCOL_VERSION + 1 }))).toThrow(
      AgentProtocolError,
    );
  });

  it("never keeps the credential on the session record", () => {
    const { agents } = registryRig();
    agents.register(REGISTER);

    expect(JSON.stringify(agents.sessions())).not.toContain(AGENT_TOKEN);
  });
});
