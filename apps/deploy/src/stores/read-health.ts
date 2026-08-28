import type { HealthReader, ServiceHealth } from "@maestro/bff";

/**
 * The Postgres-backed `HealthReader` (M6).
 *
 * Health is the one read model with no table to read, and that is correct: a
 * service's health is not a stored fact, it is a fact you establish by asking
 * the service. So this probes rather than queries — and it reports what the
 * probe actually established, including "I could not reach it".
 *
 * What it deliberately does NOT do is report a service it never contacted. A
 * health screen that lists Temporal as `healthy` because Temporal is in a
 * config file is worse than one that omits it: it answers the operator's
 * question wrongly at the moment they are asking it because something is
 * broken.
 */

/** One probe: a service name and a way to establish whether it answers. */
export interface ServiceProbe {
  readonly service: string;
  readonly version: string;
  /** Resolves when the service answered; rejects when it did not. */
  check(): Promise<void>;
}

/** The clock, so a test can assert `checkedAt` without racing the wall. */
export interface HealthClock {
  now(): Date;
}

/**
 * A probe over a Postgres connection.
 *
 * `SELECT 1` is the whole check, and it is a real one: it proves the pool can
 * hand out a connection and the server can answer on it, which is exactly what
 * every other read model needs to be true.
 */
export function postgresProbe(
  db: { $queryRawUnsafe<R = unknown>(query: string): Promise<R> },
  version = "postgres",
): ServiceProbe {
  return {
    service: "postgres",
    version,
    async check(): Promise<void> {
      await db.$queryRawUnsafe("SELECT 1");
    },
  };
}

/**
 * A probe over the Temporal gateway's own readiness check.
 *
 * Reuses `RunGateway.ping` rather than opening a second check, so the health
 * screen and the write paths agree on what "Temporal is up" means. That ping
 * describes the deployment's OWN namespace: a bare TCP connect would pass
 * against a namespace that does not exist, while every start and signal
 * failed.
 */
export function temporalProbe(
  gateway: { ping(): Promise<void> },
  version = "temporal",
): ServiceProbe {
  return {
    service: "temporal",
    version,
    async check(): Promise<void> {
      await gateway.ping();
    },
  };
}

/**
 * A probe over a plain HTTP endpoint (a sibling service's own liveness URL).
 *
 * The check is a real GET: a 2xx/3xx/4xx response proves the process is up and
 * answering (even a 404 means "the server is there"), while a network error —
 * connection refused, DNS failure, timeout — means it is not. A 5xx is treated
 * as down: the service answered but is failing. The URL is a fixed deployment
 * fact, never caller-supplied, so this is not an SSRF surface.
 */
export function httpProbe(
  service: string,
  url: string,
  options: {
    version?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    /** Extra request headers — e.g. a Basic-auth header to probe an authenticated endpoint. */
    headers?: Record<string, string>;
    /**
     * When true, a 401/403 counts as UP: the server answered and rejected us,
     * which still proves it is reachable. Use for an unauthenticated liveness
     * ping against an endpoint that would otherwise demand auth. Default false —
     * an authenticated probe (with `headers`) wants a 401 to read as "auth
     * broke", i.e. down.
     */
    authOptional?: boolean;
  } = {},
): ServiceProbe {
  const { version = service, timeoutMs = 3_000, fetchImpl = fetch, headers, authOptional = false } = options;
  return {
    service,
    version,
    async check(): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: "GET",
          signal: controller.signal,
          ...(headers ? { headers } : {}),
        });
        if (res.status >= 500) throw new Error(`http ${res.status}`);
        if (!authOptional && (res.status === 401 || res.status === 403)) {
          throw new Error(`http ${res.status} (auth)`);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export class ProbeHealthReader implements HealthReader {
  constructor(
    private readonly probes: readonly ServiceProbe[],
    private readonly clock: HealthClock = { now: () => new Date() },
  ) {}

  /**
   * Every probe, in parallel, each one's failure isolated.
   *
   * `allSettled` rather than `all` is the point: one unreachable service must
   * not take down the page that exists to say which service is unreachable.
   */
  async services(): Promise<readonly ServiceHealth[]> {
    const checkedAt = this.clock.now().toISOString();
    const results = await Promise.allSettled(this.probes.map((probe) => probe.check()));

    return this.probes.map((probe, index) => {
      const result = results[index];
      if (result?.status === "fulfilled") {
        return {
          service: probe.service,
          state: "healthy" as const,
          version: probe.version,
          checkedAt,
          note: null,
        };
      }
      return {
        service: probe.service,
        state: "down" as const,
        version: probe.version,
        checkedAt,
        // The reason, scrubbed. A failed connection carries the DSN — user,
        // host, sometimes the password — and this string reaches an HTTP body
        // and a log aggregator. The operator needs to know it is down; they do
        // not need the credential in their browser.
        note: safeNote(result?.reason),
      };
    });
  }
}

/**
 * A probe failure as a short, secret-free note.
 *
 * Only the error's NAME is kept. A driver's message routinely embeds the
 * connection string it failed to open, and there is no reliable way to redact
 * one out of arbitrary text — so the message is dropped whole rather than
 * filtered, which is the only version of this that cannot leak by accident.
 */
export function safeNote(reason: unknown): string {
  const name = reason instanceof Error ? reason.name : "Error";
  return `probe failed (${name}); details in the service log, withheld here so a connection string cannot reach a screen`;
}
