import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  DEFAULT_CONNECTION,
  endpoint,
  parseRedisUrl,
  type RedisClient,
  type RedisConnectionOptions,
} from "./client.js";
import { RedisCommandError, RedisConnectionError, RedisTimeoutError } from "./errors.js";
import { decodeReply, encodeCommand, RespError, type RespValue } from "./resp.js";

/**
 * The one file in this package that opens a socket (M44: this is the driver).
 *
 * Commands are pipelined onto a single connection and matched to replies BY
 * ORDER — Redis answers a single connection strictly in the order it received
 * commands, which is what makes a FIFO of pending promises correct without any
 * request id. It also means a decode desync is unrecoverable: reply n would be
 * handed to caller n+1 forever after. So a protocol error tears the connection
 * down rather than trying to resynchronise on the next `\r\n`.
 */

interface Pending {
  readonly command: string;
  resolve(value: RespValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createRedisClient(url: string, overrides: Partial<RedisConnectionOptions> = {}): RedisClient {
  return new SocketRedisClient({ ...parseRedisUrl(url), ...overrides });
}

export class SocketRedisClient implements RedisClient {
  readonly #options: RedisConnectionOptions;
  readonly #pending: Pending[] = [];
  #socket: Socket | null = null;
  #connecting: Promise<Socket> | null = null;
  #buffer: Buffer = Buffer.alloc(0);
  #closed = false;

  constructor(options: RedisConnectionOptions) {
    this.#options = { ...DEFAULT_CONNECTION, ...options };
  }

  async send(args: readonly (string | number)[]): Promise<RespValue> {
    if (this.#closed) throw new RedisConnectionError(endpoint(this.#options), "client is closed");
    const name = String(args[0] ?? "");
    let lastError: Error | undefined;

    // The retry loop covers CONNECTION failures only. A command that reached
    // the server and came back `-ERR` is not retried: EVAL is not idempotent,
    // and re-running a token-bucket take because its reply was rejected would
    // charge the bucket twice.
    for (let attempt = 0; attempt <= this.#options.maxReconnectAttempts; attempt += 1) {
      if (attempt > 0) await this.#backoff(attempt);
      let socket: Socket;
      try {
        socket = await this.#connection();
      } catch (cause) {
        lastError = cause as Error;
        continue;
      }
      try {
        return await this.#dispatch(socket, args, name);
      } catch (cause) {
        // Anything the server ANSWERED is final; only a broken pipe is retried.
        if (cause instanceof RedisCommandError || cause instanceof RedisTimeoutError) throw cause;
        // A close() that landed while this command was in flight is also final.
        // Retrying it would reopen the socket the caller just asked us to shut,
        // and the caller would see a timeout instead of "closed".
        if (this.#closed) throw cause;
        lastError = cause as Error;
        this.#drop(cause as Error);
      }
    }
    throw lastError ?? new RedisConnectionError(endpoint(this.#options), "unreachable");
  }

  async close(): Promise<void> {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = null;
    this.#connecting = null;
    // The listeners go before anything is settled. `socket.end()` below fires
    // `close`, which would otherwise reach `#drop` and reject the same pending
    // commands a second time — and the second rejection has no `await` on it,
    // so it surfaces as an unhandled rejection that fails the process.
    socket?.removeAllListeners("close");
    socket?.removeAllListeners("error");
    socket?.on("error", () => undefined);
    // Callers waiting on a reply are rejected rather than left hanging: a
    // shutdown that silently abandoned promises would hold the process open.
    this.#settleAll(new RedisConnectionError(endpoint(this.#options), "client closed"));
    // Yield once so a `send` already suspended on `#dispatch` resumes and
    // attaches its own handler to the rejection before this method returns.
    await Promise.resolve();
    if (socket === null) return;
    await new Promise<void>((resolve) => {
      socket.end(() => resolve());
      socket.once("error", () => resolve());
      // A peer that never FINs must not block shutdown.
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 1_000).unref?.();
    });
  }

  #dispatch(socket: Socket, args: readonly (string | number)[], name: string): Promise<RespValue> {
    return new Promise<RespValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out command's reply may still arrive, and it would then be
        // matched to the NEXT caller. The connection goes with it.
        this.#drop(new RedisTimeoutError(name, this.#options.commandTimeoutMs));
      }, this.#options.commandTimeoutMs);
      timer.unref?.();
      this.#pending.push({ command: name, resolve, reject, timer });
      socket.write(Buffer.from(encodeCommand(args)), (error) => {
        if (error) this.#drop(error);
      });
    });
  }

  #connection(): Promise<Socket> {
    if (this.#socket !== null && !this.#socket.destroyed) return Promise.resolve(this.#socket);
    // One in-flight connect, shared: a burst of concurrent `send` calls on a
    // cold client must open one socket, not fifty.
    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #open(): Promise<Socket> {
    const { host, port, tls, connectTimeoutMs } = this.#options;
    const socket = await new Promise<Socket>((resolve, reject) => {
      const created = tls
        ? tlsConnect({ host, port, servername: host })
        : netConnect({ host, port });
      const onReady = (): void => {
        created.setNoDelay(true);
        cleanup();
        resolve(created);
      };
      const onError = (error: Error): void => {
        cleanup();
        created.destroy();
        reject(new RedisConnectionError(endpoint(this.#options), error.message));
      };
      const timer = setTimeout(() => {
        onError(new Error(`connect timed out after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
      timer.unref?.();
      const cleanup = (): void => {
        clearTimeout(timer);
        created.off("error", onError);
      };
      created.once(tls ? "secureConnect" : "connect", onReady);
      created.once("error", onError);
    });

    socket.on("data", (chunk: Buffer) => this.#consume(chunk));
    socket.on("error", (error: Error) => this.#drop(error));
    socket.on("close", () => this.#drop(new RedisConnectionError(endpoint(this.#options), "connection closed")));
    this.#socket = socket;

    // Handshake on the raw socket, before this connection serves any queued
    // command: AUTH and SELECT must be the first things it sees, or a command
    // pipelined ahead of them runs unauthenticated or against database 0.
    await this.#handshake(socket);
    return socket;
  }

  async #handshake(socket: Socket): Promise<void> {
    const { password, username, db } = this.#options;
    if (password !== undefined) {
      // Two-argument AUTH only when a username is set (Redis 6 ACLs); the
      // one-argument form is what a `requirepass` server expects.
      const args = username === undefined ? ["AUTH", password] : ["AUTH", username, password];
      await this.#dispatch(socket, args, "AUTH");
    }
    if (db !== 0) await this.#dispatch(socket, ["SELECT", db], "SELECT");
  }

  #consume(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      let decoded;
      try {
        decoded = decodeReply(this.#buffer);
      } catch (error) {
        this.#drop(error as Error);
        return;
      }
      if (decoded === null) return; // partial reply; wait for more bytes
      this.#buffer = this.#buffer.subarray(decoded.consumed);
      const waiter = this.#pending.shift();
      if (waiter === undefined) continue; // reply to a command already timed out
      clearTimeout(waiter.timer);
      if (decoded.value instanceof RespError) {
        waiter.reject(new RedisCommandError(waiter.command, decoded.value.message));
      } else {
        waiter.resolve(decoded.value);
      }
    }
  }

  /** Tear down the connection and fail everything waiting on it. */
  #drop(error: Error): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#buffer = Buffer.alloc(0);
    socket?.destroy();
    this.#settleAll(error);
  }

  #settleAll(error: Error): void {
    while (this.#pending.length > 0) {
      const waiter = this.#pending.shift();
      if (waiter === undefined) break;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #backoff(attempt: number): Promise<void> {
    const { reconnectBaseDelayMs, reconnectMaxDelayMs } = this.#options;
    const delay = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * 2 ** (attempt - 1));
    return new Promise((resolve) => setTimeout(resolve, delay).unref?.());
  }
}
