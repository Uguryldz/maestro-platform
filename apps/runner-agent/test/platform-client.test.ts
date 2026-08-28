import { describe, expect, it } from "vitest";
import { PlatformHttpError, PlatformProtocolError } from "../src/errors.js";
import { PlatformClient, type FetchLike } from "../src/platform-client.js";
import { FakePlatform } from "./fake-platform.js";

/**
 * The one outbound channel (M22). The direction is the security property, so
 * the tests assert on the requests the agent MAKES — this app never listens.
 */

function registerMessage(): Parameters<PlatformClient["register"]>[0] {
  return {
    type: "register",
    agentId: "mac-mini-07",
    platform: "macos-xcode",
    agentVersion: "0.1.0",
    labels: [],
    maxConcurrency: 2,
    startedAt: "2026-01-01T00:00:00.000Z",
    takeover: false,
  };
}

describe("PlatformClient — requests", () => {
  it("POSTs to the platform base URL and parses the reply", async () => {
    const platform = new FakePlatform();
    const client = platform.client();

    const reply = await client.register(registerMessage());

    expect(reply.sessionId).toBe(platform.sessionId);
    expect(platform.requests[0]?.endpoint).toBe("/agent/register");
  });

  it("attaches the shared secret to register and to nothing else", async () => {
    const platform = new FakePlatform();
    const client = platform.client({ token: () => Promise.resolve("t".repeat(32)) });

    await client.register(registerMessage());
    await client.heartbeat({
      type: "heartbeat",
      sessionId: platform.sessionId,
      agentId: "mac-mini-07",
      at: "2026-01-01T00:00:00.000Z",
      activeLeases: [],
      healthy: true,
    });

    expect(platform.sent("/agent/register")[0]).toHaveProperty("authToken", "t".repeat(32));
    expect(platform.sent("/agent/heartbeat")[0]).not.toHaveProperty("authToken");
  });

  it("stamps the protocol version on every message", async () => {
    const platform = new FakePlatform();
    const client = platform.client();

    await client.register(registerMessage());

    expect(platform.sent("/agent/register")[0]).toHaveProperty("protocolVersion", 1);
  });

  it("tolerates a 204 reply on the fire-and-forget paths", async () => {
    const platform = new FakePlatform();
    const client = platform.client();

    await expect(
      client.sendLog({
        sessionId: platform.sessionId,
        agentId: "mac-mini-07",
        leaseId: "lease-1",
        runId: "run-00000001",
        stream: "stdout",
        text: "hello",
        at: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("PlatformClient — failures never leak the payload", () => {
  it("raises a typed error carrying the status, not the body", async () => {
    const platform = new FakePlatform();
    platform.failing.add("/agent/register");
    const client = platform.client();

    await expect(client.register(registerMessage())).rejects.toThrow(PlatformHttpError);
  });

  it("a transport failure names the error TYPE, never the request", async () => {
    const secret = "s".repeat(32);
    const exploding: FetchLike = () => Promise.reject(new TypeError("connect ECONNREFUSED"));
    const client = new PlatformClient({
      baseUrl: "https://maestro.internal",
      fetch: exploding,
      requestTimeoutMs: 1_000,
      token: () => Promise.resolve(secret),
    });

    const error = await client.register(registerMessage()).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PlatformProtocolError);
    // The shared secret was in the request body; it must not be in the message.
    expect(String(error)).not.toContain(secret);
    expect(String(error)).toContain("TypeError");
  });

  it("rejects a malformed request without echoing it", async () => {
    const secret = "s".repeat(32);
    const platform = new FakePlatform();
    const client = platform.client({ token: () => Promise.resolve(secret) });

    // maxConcurrency is out of the schema's range.
    const error = await client
      .register({ ...registerMessage(), maxConcurrency: 999 })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PlatformProtocolError);
    expect(String(error)).not.toContain(secret);
    // Nothing reached the wire.
    expect(platform.requests).toEqual([]);
  });

  it("rejects a reply that does not match the schema", async () => {
    const nonsense: FetchLike = () =>
      Promise.resolve(
        new Response(JSON.stringify({ type: "register_accepted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = new PlatformClient({
      baseUrl: "https://maestro.internal",
      fetch: nonsense,
      requestTimeoutMs: 1_000,
      token: () => Promise.resolve("t".repeat(32)),
    });

    await expect(client.register(registerMessage())).rejects.toThrow(/not usable/);
  });

  it("rejects a reply that is not JSON", async () => {
    const html: FetchLike = () => Promise.resolve(new Response("<html>proxy error</html>", { status: 200 }));
    const client = new PlatformClient({
      baseUrl: "https://maestro.internal",
      fetch: html,
      requestTimeoutMs: 1_000,
      token: () => Promise.resolve("t".repeat(32)),
    });

    await expect(client.register(registerMessage())).rejects.toThrow(/not valid JSON/);
  });

  it("aborts a request that outlives its timeout", async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const client = new PlatformClient({
      baseUrl: "https://maestro.internal",
      fetch: hanging,
      requestTimeoutMs: 10,
      token: () => Promise.resolve("t".repeat(32)),
    });

    await expect(client.register(registerMessage())).rejects.toThrow(PlatformProtocolError);
  });
});
