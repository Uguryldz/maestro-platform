import { Agent, fetch as undiciFetch } from "undici";
import type { FetchLike } from "./http.js";

/**
 * TLS verification for self-hosted model servers — the wendoc parity module.
 *
 * The measured difference between wendoc reaching the user's on-prem OpenShift
 * model server and Maestro not: wendoc skips certificate verification for
 * endpoints that are demonstrably INSIDE (localhost / RFC1918 / `.local`) and
 * offers a per-model `skipTlsVerify` switch for the rest, and it applies the
 * SAME rule in its connection test and its real document processing. Maestro
 * verified everywhere, so a corporate/self-signed certificate failed the probe
 * and the run alike — with (before this packet) no message naming why.
 *
 * The rule is deliberately narrow:
 *  · Only `https` — plain HTTP has no certificate to skip.
 *  · Auto-skip only for addresses that cannot be an internet host: loopback,
 *    RFC1918 private ranges, and the `.local` suffix. A public hostname NEVER
 *    auto-skips; for those the operator must either introduce the corporate
 *    root CA (`NODE_EXTRA_CA_CERTS` — the durable fix) or explicitly flip the
 *    connection's `skipTlsVerify` switch and own the trade-off.
 *  · The probe and the runtime driver consult the SAME predicate
 *    (`shouldSkipTlsVerify`), so a test that goes green is evidence about the
 *    exact handshake the run will perform — wendoc's test=run symmetry.
 *
 * THE TRADE-OFF, said plainly: skipping verification opens the connection to
 * address spoofing (MITM) on the path to the server. That is why auto-skip is
 * limited to addresses that never leave the building's routing, and why the
 * explicit switch's UI hint says to use it only on the internal network.
 */
export function needsTlsSkip(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    // WHATWG URL keeps the brackets ON an IPv6 hostname; both spellings are
    // accepted so a hand-built string cannot dodge the rule.
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  );
}

/**
 * The one decision both the panel probe and the run's driver ask: skip
 * verification for THIS dial? Explicit operator switch first (the connection's
 * `config.skipTlsVerify`), then the internal-address auto rule.
 */
export function shouldSkipTlsVerify(url: string, skipTlsVerify: boolean): boolean {
  return skipTlsVerify || needsTlsSkip(url);
}

/**
 * One shared insecure agent, created lazily. Undici agents hold a connection
 * pool; minting one per request would leak sockets on a path that is by
 * definition talking to the same one or two internal servers.
 */
let agent: Agent | null = null;
function insecureAgent(): Agent {
  agent ??= new Agent({ connect: { rejectUnauthorized: false } });
  return agent;
}

/**
 * A `FetchLike` that dials WITHOUT certificate verification.
 *
 * It goes through undici's OWN `fetch`, not the injected/global one, and that
 * is a constraint rather than a choice: `rejectUnauthorized: false` can only
 * ride on an undici `Agent` dispatcher, an arbitrary injected `FetchLike` has
 * no seam to accept one through, and Node's built-in fetch is not guaranteed
 * to honour a dispatcher from the npm `undici` package. wendoc's model test
 * uses exactly this pair (`import { Agent, fetch } from "undici"`) against
 * the same class of server, which is the compatibility evidence.
 *
 * The undici types disagree structurally with the DOM lib's `RequestInit` /
 * `Response`, hence the casts; at runtime the shapes are the same web-standard
 * objects (Node's global fetch IS undici).
 */
export const insecureFetch: FetchLike = (url, init) =>
  undiciFetch(url, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: insecureAgent(),
  }) as unknown as Promise<Response>;

/**
 * A `FetchLike` that decides PER URL whether to verify, so the composition
 * roots can hand one transport to an adapter and have every dial follow the
 * same rule the panel's probe applies.
 *
 * `flagFor` answers "did an admin explicitly flag this host's connection with
 * `skipTlsVerify`?" — the deployment binds it to a connection-table lookup
 * (`tlsSkipFlagFrom`), the same per-call-read idiom as `resolveModel`, so a
 * switch flipped in the panel is live on the next request with no restart.
 * Absent (or throwing), only the internal-address auto rule applies: a lookup
 * failure must fail CLOSED onto full verification, never open.
 */
export function tlsAwareFetchWith(
  flagFor?: (url: string) => boolean | Promise<boolean>,
): FetchLike {
  return async (url, init) => {
    let flagged = false;
    if (flagFor !== undefined) {
      try {
        flagged = await flagFor(url);
      } catch {
        flagged = false;
      }
    }
    return shouldSkipTlsVerify(url, flagged)
      ? insecureFetch(url, init)
      : globalThis.fetch(url, init);
  };
}
