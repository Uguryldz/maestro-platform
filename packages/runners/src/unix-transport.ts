import { connect } from "node:net";
import type { DockerTransport } from "./deps.js";

/**
 * The one place in this package that touches a socket. Everything above it
 * works on bytes, which is why the default test suite never opens a
 * connection; this file is exercised only by the opt-in smoke test
 * (`MAESTRO_DOCKER_IT=1`).
 *
 * M24: the unix socket is the Runner Service's privilege. It is never handed
 * to a workflow worker, and it is never mounted into a job container.
 */
export function createUnixSocketTransport(socketPath: string): DockerTransport {
  return {
    exchange(request, options) {
      return new Promise<Uint8Array>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const socket = connect({ path: socketPath });
        let settled = false;

        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (error) reject(error);
          else resolve(Buffer.concat(chunks));
        };

        socket.setTimeout(options.timeoutMs, () => {
          finish(new Error(`docker socket ${socketPath} timed out after ${options.timeoutMs}ms`));
        });
        // `write`, never `end`: half-closing the write side makes the daemon
        // treat the request as abandoned and answer HTTP 499 (verified against
        // Engine 29.4). `Connection: close` is what ends the response instead.
        socket.on("connect", () => socket.write(Buffer.from(request)));
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("error", (error: Error) => finish(error));
        // `end` (peer closed) and `close` both mean "no more bytes are coming".
        socket.on("end", () => finish());
        socket.on("close", () => finish());
      });
    },
  };
}
