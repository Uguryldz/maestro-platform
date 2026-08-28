import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL_VERSION,
  AgentBye,
  AgentHeartbeat,
  AgentMessage,
  AgentRegister,
  HeartbeatAck,
  PlatformReply,
} from "../src/agent-protocol.js";
import { AGENT_TOKEN, REGISTER, heartbeatMessage } from "./agent-helpers.js";

describe("message schemas", () => {
  it("accepts a well-formed registration and applies its defaults", () => {
    const parsed = AgentRegister.parse({ ...REGISTER, labels: undefined, takeover: undefined });

    expect(parsed.labels).toEqual([]);
    expect(parsed.takeover).toBe(false);
    expect(AgentHeartbeat.parse(heartbeatMessage("session-00000001")).activeLeases).toEqual([]);
  });

  it("refuses ids, platforms and concurrencies outside the grammar", () => {
    expect(AgentRegister.safeParse({ ...REGISTER, agentId: "MAC-01" }).success).toBe(false);
    expect(AgentRegister.safeParse({ ...REGISTER, platform: "linux-node" }).success).toBe(false);
    expect(AgentRegister.safeParse({ ...REGISTER, maxConcurrency: 0 }).success).toBe(false);
    expect(AgentRegister.safeParse({ ...REGISTER, startedAt: "yesterday" }).success).toBe(false);
  });

  /**
   * O4: M22 had NO authentication at all. Whoever reached the endpoint could
   * register as `mac-mini-07`, take the real machine's place and be handed its
   * work — so the credential is part of the message, and long enough not to be
   * guessed.
   */
  it("requires a registration to carry a credential", () => {
    const { authToken: _omitted, ...withoutToken } = REGISTER;

    expect(AgentRegister.safeParse(withoutToken).success).toBe(false);
    expect(AgentRegister.safeParse({ ...REGISTER, authToken: "short" }).success).toBe(false);
    expect(AgentRegister.safeParse({ ...REGISTER, authToken: AGENT_TOKEN }).success).toBe(true);
  });

  it("bounds the lease list an agent may claim", () => {
    const many = Array.from({ length: 65 }, (_, index) => `lease-${index}`);

    expect(AgentHeartbeat.safeParse(heartbeatMessage("session-00000001", { activeLeases: many })).success).toBe(false);
  });

  it("discriminates the agent→platform union by type, and rejects a foreign type", () => {
    expect(AgentMessage.parse(REGISTER).type).toBe("register");
    expect(AgentMessage.parse(heartbeatMessage("session-00000001")).type).toBe("heartbeat");
    expect(AgentMessage.safeParse({ ...REGISTER, type: "job_result" }).success).toBe(false);
  });

  it("discriminates the platform→agent union the same way", () => {
    const reply = {
      type: "heartbeat_ack",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId: "session-00000001",
      nextIntervalSeconds: 10,
      revokedLeases: [],
      serverTime: "2026-08-08T14:20:00.000Z",
    };

    expect(PlatformReply.parse(reply).type).toBe("heartbeat_ack");
    expect(HeartbeatAck.parse(reply).revokedLeases).toEqual([]);
    expect(PlatformReply.safeParse({ ...reply, type: "job_offer" }).success).toBe(false);
  });

  it("keeps the credential out of every message the platform sends back", () => {
    expect(Object.keys(HeartbeatAck.shape)).not.toContain("authToken");
    expect(Object.keys(AgentBye.shape)).not.toContain("authToken");
  });

  it("keeps user-facing text out of the wire format (M104)", () => {
    const fields = Object.keys(AgentHeartbeat.shape);

    expect(fields).toContain("reasonKey");
    expect(fields).not.toContain("reason");
    expect(fields).not.toContain("message");
  });
});
