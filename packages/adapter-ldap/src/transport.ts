import { LdapInsecureTransportError } from "./errors.js";

/**
 * Transport policy: is this URL allowed to carry a corporate password?
 *
 * Separated from the client so the rule can be tested without a socket, and so
 * there is exactly ONE place that answers the question. The MVP's lesson from
 * 22 audits is that a security rule spread across three call sites grows a
 * fourth call site that forgot it.
 */

export interface TransportDecision {
  /** True when the URL is `ldaps:` — TLS from the first byte. */
  readonly secure: boolean;
  readonly scheme: string;
  readonly host: string;
}

/**
 * Parse and vet the URL.
 *
 * Fail-closed in three ways, in this order:
 *
 *  1. An unparseable or non-LDAP scheme is refused outright. `ldap+tls://` and
 *     `https://` are not silently coerced into something workable — a URL the
 *     operator did not mean is a URL nobody has reviewed.
 *  2. `ldaps:` always passes.
 *  3. `ldap:` passes ONLY when the caller explicitly allowed insecure AND the
 *     process is not production. Both conditions, not either: a dev override
 *     that survives a deploy is how plaintext reaches a bank's network, and
 *     `NODE_ENV=production` is the one signal that outranks local config.
 *
 * StartTLS is deliberately not implemented rather than half-implemented. It
 * begins as a plaintext connection and upgrades, so a downgrade attack has a
 * window that `ldaps://` simply does not have; supporting it would mean
 * shipping a second, weaker path for no gain the bank asked for.
 */
export function decideTransport(
  url: string,
  options: { allowInsecure: boolean; nodeEnv: string },
): TransportDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LdapInsecureTransportError(
      `"${url}" is not a valid URL — expected ldaps://host:636`,
    );
  }

  const scheme = parsed.protocol.replace(/:$/, "");
  if (scheme === "ldaps") {
    return { secure: true, scheme, host: parsed.host };
  }

  if (scheme !== "ldap") {
    throw new LdapInsecureTransportError(
      `scheme "${scheme}" is not supported — use ldaps:// (StartTLS and non-LDAP schemes are refused)`,
    );
  }

  const production = options.nodeEnv === "production";
  if (production) {
    throw new LdapInsecureTransportError(
      "plain ldap:// is refused under NODE_ENV=production — a bind over it sends the user's " +
        "corporate password in cleartext. Use ldaps:// (M6 fail-closed)",
    );
  }
  if (!options.allowInsecure) {
    throw new LdapInsecureTransportError(
      "plain ldap:// requires allowInsecure to be set explicitly, and it is not. Use ldaps://, " +
        "or set LDAP_ALLOW_INSECURE=true for a local test directory only",
    );
  }

  return { secure: false, scheme, host: parsed.host };
}
