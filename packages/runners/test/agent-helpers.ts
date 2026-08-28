import { AGENT_PROTOCOL_VERSION } from "../src/agent-protocol.js";
import { AgentRegistry, sharedSecretAuthenticator } from "../src/agent-registry.js";
import { fakeClock, sequentialIds } from "./helpers.js";

/** Shared rig for the M22 protocol tests: schemas here, registry behaviour next door. */

export const AGENT_TOKEN = "s3cret-token-for-the-mac-mini-pool-0001";

export const REGISTER = {
  type: "register" as const,
  protocolVersion: AGENT_PROTOCOL_VERSION,
  agentId: "mac-mini-07",
  platform: "macos-xcode" as const,
  agentVersion: "0.1.0",
  labels: ["xcode-16", "ios-simulator"],
  maxConcurrency: 2,
  startedAt: "2026-08-08T14:00:00.000Z",
  authToken: AGENT_TOKEN,
};

export function heartbeatMessage(sessionId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "heartbeat",
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId,
    agentId: REGISTER.agentId,
    at: "2026-08-08T14:20:00.000Z",
    activeLeases: [],
    healthy: true,
    ...overrides,
  };
}

export function byeMessage(sessionId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "bye",
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId,
    agentId: REGISTER.agentId,
    at: "2026-08-08T14:25:00.000Z",
    ...overrides,
  };
}

export function registryRig(startIso?: string) {
  const clock = fakeClock(startIso);
  const agents = new AgentRegistry({
    clock: clock.clock,
    newId: sequentialIds("session"),
    heartbeatIntervalSeconds: 10,
    authenticate: sharedSecretAuthenticator({ [REGISTER.agentId]: AGENT_TOKEN, "win-build-03": "another-secret-token-for-win-03" }),
  });
  return { clock, agents };
}
