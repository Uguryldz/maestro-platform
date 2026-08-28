/**
 * Injected runtime collaborators (insa-plani §2.3). Everything a driver cannot
 * compute by itself — network, TCP socket, wall clock, sleep, message id —
 * arrives through these, so every test in this package is offline and
 * deterministic.
 */

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Narrowed `fetch`; the platform fetch (or an egress-proxy wrapper) fits. */
export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

/** Wall clock. Injected so `Date:` headers and ladder maths are reproducible. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/** Injected so retry backoff is instant in tests. */
export type Sleep = (ms: number) => Promise<void>;

export const systemSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What the transport must be able to PROVE about an encrypted connection.
 *
 * A `startTls()` that returns nothing is indistinguishable from a `startTls()`
 * that does nothing — and a do-nothing implementation sends the relay password
 * in cleartext while `send()` resolves happily. So the contract is: the socket
 * reports the handshake facts, and the SMTP client refuses to continue unless
 * they are acceptable. Writing the adapter is the composition root's job; this
 * shape is what it MUST answer (all of it comes off a `tls.TLSSocket`).
 */
export interface TlsInfo {
  /** `tlsSocket.authorized` — the peer chain verified against the trust store. */
  authorized: boolean;
  /** `tlsSocket.authorizationError`, when `authorized` is false. */
  authorizationError?: string | undefined;
  /** `tlsSocket.getProtocol()` — e.g. "TLSv1.2", "TLSv1.3". */
  protocol: string;
  /** The SNI/servername the handshake was actually performed against. */
  servername: string;
}

/**
 * Byte-stream socket the SMTP client talks over. Deliberately pull-based:
 * `read()` resolves the next chunk (or null at EOF), which makes a scripted
 * fake socket a dozen lines and keeps the protocol tests network-free.
 *
 * `startTls()` upgrades the SAME connection in place (STARTTLS, RFC 3207) and
 * resolves with the facts about the resulting session; `tlsInfo()` reports the
 * current state (null = cleartext) and is how an implicit-TLS connection is
 * verified before a single command is written.
 */
export interface SocketLike {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  startTls(): Promise<TlsInfo>;
  tlsInfo(): Promise<TlsInfo | null>;
  close(): Promise<void>;
}

export interface SocketTarget {
  host: string;
  port: number;
  /** true = TLS from the first byte (implicit TLS, usually port 465). */
  tls: boolean;
  timeoutMs: number;
}

export type SocketFactory = (target: SocketTarget) => Promise<SocketLike>;
