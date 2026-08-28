/**
 * Where the demo listens (M7's port map: Studio 7000, BFF 7001).
 *
 * Loopback by default, for the same reason `@maestro/config`'s `EnvSchema`
 * defaults `BFF_HOST` to loopback: a process that binds `0.0.0.0` because
 * nobody set a variable is exposed by omission. That default matters MORE here
 * than in production — the demo ships known passwords in a README, so a demo
 * reachable from the network is a set of working credentials on the network.
 * Overriding it is possible and deliberate; it is never the default.
 */

export const DEMO_BFF_PORT = 7001;
export const DEMO_BFF_HOST = "127.0.0.1";
export const DEMO_STUDIO_PORT = 7000;

export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

export function listenAddress(
  source: Record<string, string | undefined> = process.env,
): ListenAddress {
  const rawPort = source["DEMO_BFF_PORT"];
  const parsed = rawPort === undefined ? Number.NaN : Number(rawPort);
  const port = Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : DEMO_BFF_PORT;
  const host = source["DEMO_BFF_HOST"];
  return { host: host !== undefined && host.length > 0 ? host : DEMO_BFF_HOST, port };
}
