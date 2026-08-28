import type { ConnectionModelDelegate, ConnectionModelRow } from "./connection-model.js";

/**
 * The explicit half of the TLS-skip rule, bound to the connection table — the
 * third member of the `connection-secrets.ts` / `connection-model.ts` family,
 * and present for the same reason.
 *
 * Those two closed the gap for the model's credential and address: what an
 * admin typed into "Ayarlar & bağlantılar" is what a RUN uses. This one closes
 * it for the HANDSHAKE. The panel's probe honours a connection's
 * `config.skipTlsVerify` switch (and the internal-address auto rule) when it
 * tests a corporate/self-signed endpoint green; the runtime transports —
 * `postJson` for the LLM, and the `tlsAwareFetchWith` fetch the composition
 * root hands the ado/jira/github adapters — must ask the SAME question, or a
 * green test is a promise the first real run breaks (test=run symmetry, the
 * measured difference between wendoc reaching the user's on-prem server and
 * Maestro not).
 *
 * The answer is per URL and by HOSTNAME: the flag is an admin's assertion
 * about a server, so every API path and probe URL on that host inherits it,
 * whichever kind's adapter is dialling. Read per call — the `resolveModel`
 * idiom, one indexed query over a handful of rows on a path already about to
 * cross the network — so a switch flipped in the panel is live on the next
 * request with no restart. Any read failure answers `false`: TLS verification
 * fails CLOSED, never open.
 */
export function tlsSkipFlagFrom(db: {
  connection: ConnectionModelDelegate;
}): (url: string) => Promise<boolean> {
  return async (url) => {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    let rows: readonly ConnectionModelRow[];
    try {
      rows = await db.connection.findMany({ orderBy: { id: "asc" } });
    } catch {
      return false;
    }
    return rows.some((row) => {
      if (!row.enabled || !skipTlsVerifySet(row.configJson)) return false;
      try {
        return new URL(row.baseUrl).hostname === host;
      } catch {
        return false;
      }
    });
  };
}

/**
 * `config.skipTlsVerify === "true"` — the string form `ConnectionConfig`
 * (string→string by contract) stores; anything else reads as off.
 */
function skipTlsVerifySet(configJson: unknown): boolean {
  if (typeof configJson !== "object" || configJson === null) return false;
  return (configJson as Record<string, unknown>)["skipTlsVerify"] === "true";
}
