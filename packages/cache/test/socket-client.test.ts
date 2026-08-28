import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SocketRedisClient } from "../src/socket-client.js";
import { parseRedisUrl } from "../src/client.js";
import { RedisCommandError, RedisConnectionError, RedisTimeoutError } from "../src/errors.js";

/**
 * The socket client, against a scripted server on loopback.
 *
 * No external network and no container: a `net.createServer` on 127.0.0.1 with
 * an ephemeral port. That is what lets these run in the gate while still
 * exercising the real code path — chunked reads, pipelining, reconnection and
 * timeouts are all things a mocked transport would let us assert about
 * ourselves rather than about the client.
 */

interface Harness {
  readonly port: number;
  readonly server: Server;
  readonly received: string[];
  /** Sockets the server accepted, so a test can cut one mid-flight. */
  readonly sockets: Socket[];
}

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(
      (harness) =>
        new Promise<void>((resolve) => {
          for (const socket of harness.sockets) socket.destroy();
          harness.server.close(() => resolve());
        }),
    ),
  );
});

/** A server that answers each inbound command with `reply(commandIndex)`. */
async function startServer(reply: (index: number, received: string) => string | null): Promise<Harness> {
  const received: string[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk: Buffer) => {
      // One test writes several commands in one packet; count them properly.
      const text = chunk.toString("utf8");
      for (const command of splitCommands(text)) {
        const index = received.length;
        received.push(command);
        const answer = reply(index, command);
        if (answer !== null) socket.write(answer);
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const harness: Harness = { port, server, received, sockets };
  harnesses.push(harness);
  return harness;
}

/** Split a RESP request stream into whole `*n\r\n...` commands. */
function splitCommands(text: string): string[] {
  const commands: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== "*") break;
    const headerEnd = text.indexOf("\r\n", cursor);
    const count = Number(text.slice(cursor + 1, headerEnd));
    let position = headerEnd + 2;
    for (let arg = 0; arg < count; arg += 1) {
      const lengthEnd = text.indexOf("\r\n", position);
      const length = Number(text.slice(position + 1, lengthEnd));
      position = lengthEnd + 2 + length + 2;
    }
    commands.push(text.slice(cursor, position));
    cursor = position;
  }
  return commands;
}

const clientFor = (port: number, overrides = {}): SocketRedisClient =>
  new SocketRedisClient({
    ...parseRedisUrl(`redis://127.0.0.1:${port}`),
    maxReconnectAttempts: 2,
    reconnectBaseDelayMs: 5,
    commandTimeoutMs: 500,
    connectTimeoutMs: 500,
    ...overrides,
  });

describe("SocketRedisClient", () => {
  it("sends a command and decodes its reply", async () => {
    const harness = await startServer(() => "+PONG\r\n");
    const client = clientFor(harness.port);
    expect(await client.send(["PING"])).toBe("PONG");
    expect(harness.received[0]).toBe("*1\r\n$4\r\nPING\r\n");
    await client.close();
  });

  it("matches pipelined replies to callers by order", async () => {
    let counter = 0;
    const harness = await startServer(() => `:${counter++}\r\n`);
    const client = clientFor(harness.port);
    // All ten in flight at once — the FIFO is the only thing pairing them up.
    const replies = await Promise.all(Array.from({ length: 10 }, () => client.send(["INCR", "k"])));
    expect(replies).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await client.close();
  });

  it("reassembles a reply that arrives in several TCP chunks", async () => {
    const harness = await startServer(() => null);
    const client = clientFor(harness.port);
    const pending = client.send(["GET", "k"]);
    // Wait for the command to land, then dribble the reply out byte-wise.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const socket = harness.sockets[0];
    for (const byte of "$5\r\nhello\r\n") {
      socket?.write(byte);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(await pending).toBe("hello");
    await client.close();
  });

  it("turns an error reply into a RedisCommandError carrying the server's text", async () => {
    const harness = await startServer(() => "-WRONGTYPE Operation against a key\r\n");
    const client = clientFor(harness.port);
    await expect(client.send(["GET", "k"])).rejects.toThrow(RedisCommandError);
    await expect(client.send(["GET", "k"])).rejects.toThrow(/WRONGTYPE/);
    await client.close();
  });

  it("does not retry a command the server answered with an error", async () => {
    // EVAL is not idempotent: re-running a take because its reply was an error
    // would charge the bucket twice.
    const harness = await startServer(() => "-ERR nope\r\n");
    const client = clientFor(harness.port);
    await expect(client.send(["EVAL", "x", 0])).rejects.toThrow(RedisCommandError);
    expect(harness.received.length).toBe(1);
    await client.close();
  });

  it("reconnects after the server drops the connection", async () => {
    let connections = 0;
    const received: string[] = [];
    const server = createServer((socket) => {
      connections += 1;
      const mine = connections;
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        received.push(chunk.toString());
        // The first connection dies mid-command; the second answers.
        if (mine === 1) socket.destroy();
        else socket.write("+PONG\r\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const client = clientFor(port);

    expect(await client.send(["PING"])).toBe("PONG");
    expect(connections).toBe(2);
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("gives up after its reconnect budget rather than retrying forever", async () => {
    // An unbounded retry inside a rate limiter turns a Redis outage into
    // activities blocked indefinitely, which Temporal cannot tell from slow work.
    const client = new SocketRedisClient({
      ...parseRedisUrl("redis://127.0.0.1:1"),
      maxReconnectAttempts: 2,
      reconnectBaseDelayMs: 1,
      connectTimeoutMs: 100,
    });
    await expect(client.send(["PING"])).rejects.toThrow(RedisConnectionError);
    await client.close();
  });

  it("times a command out instead of hanging when no reply ever comes", async () => {
    const harness = await startServer(() => null);
    const client = clientFor(harness.port, { commandTimeoutMs: 100, maxReconnectAttempts: 0 });
    await expect(client.send(["BLPOP", "k", 0])).rejects.toThrow(RedisTimeoutError);
    await client.close();
  });

  it("authenticates and selects the database before serving any command", async () => {
    const harness = await startServer(() => "+OK\r\n");
    const client = new SocketRedisClient({
      ...parseRedisUrl("redis://user:pw@127.0.0.1:1/3"),
      host: "127.0.0.1",
      port: harness.port,
      commandTimeoutMs: 500,
    });
    await client.send(["PING"]);
    // Order matters: a command pipelined ahead of AUTH runs unauthenticated,
    // and one ahead of SELECT runs against database 0.
    expect(harness.received[0]).toContain("AUTH");
    expect(harness.received[0]).toContain("user");
    expect(harness.received[1]).toContain("SELECT");
    expect(harness.received[2]).toContain("PING");
    await client.close();
  });

  it("rejects everything still in flight when it is closed", async () => {
    const harness = await startServer(() => null);
    const client = clientFor(harness.port);
    const pending = client.send(["GET", "k"]);
    // The assertion is attached BEFORE close(), not after: `close` rejects the
    // pending promise synchronously, and a rejection with no handler yet
    // attached is reported as unhandled even though the test goes on to await
    // it. Attaching first is also what a real caller does — it is already
    // awaiting `send` when the shutdown arrives.
    const asserted = expect(pending).rejects.toThrow(/closed/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // A shutdown that abandoned promises would hold the process open.
    await client.close();
    await asserted;
  });

  it("refuses new commands once closed", async () => {
    const harness = await startServer(() => "+PONG\r\n");
    const client = clientFor(harness.port);
    await client.send(["PING"]);
    await client.close();
    await expect(client.send(["PING"])).rejects.toThrow(/closed/);
  });

  it("is safe to close twice", async () => {
    const harness = await startServer(() => "+PONG\r\n");
    const client = clientFor(harness.port);
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("opens one socket for a burst of concurrent commands on a cold client", async () => {
    let connections = 0;
    let counter = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        for (const _command of splitCommands(chunk.toString())) socket.write(`:${counter++}\r\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const client = clientFor(port);

    await Promise.all(Array.from({ length: 20 }, () => client.send(["PING"])));
    expect(connections).toBe(1);
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
