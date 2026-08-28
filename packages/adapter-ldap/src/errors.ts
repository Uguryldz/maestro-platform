/**
 * Errors this driver may raise — and, more importantly, what they may CARRY.
 *
 * The service-account password is resolved from `@maestro/secrets` and passed
 * to a bind call. The obvious failure mode is an operator pasting the wrong
 * one, getting `invalidCredentials`, and finding the credential itself in the
 * stack trace their log aggregator indexed. So no error in this package takes a
 * credential, and the client that has one never puts it in a message.
 *
 * `LdapAuthError` is deliberately NOT thrown for a failed user login: a wrong
 * password returns `null` from `authenticate`, indistinguishable from an
 * unknown account (see `identity.ts`). These errors are for the driver being
 * broken or the directory being unreachable — conditions the OPERATOR must see
 * and the end user must not be able to provoke a distinguishing message from.
 */

export class LdapConfigError extends Error {
  constructor(message: string) {
    super(`ldap config: ${message}`);
    this.name = "LdapConfigError";
  }
}

/**
 * The directory could not be reached, or answered in a way that means "I cannot
 * tell you whether this login is valid".
 *
 * The caller MUST treat this as a refusal, never as a reason to try another
 * identity source. That is the fail-closed rule (M6) and it is enforced at the
 * call site in `identity.ts`, which lets this propagate rather than catching it
 * and returning `null` — `null` means "the directory said no", and a network
 * partition is not the directory saying no.
 */
export class LdapUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    // The cause is SUMMARISED, never attached whole.
    //
    // Attaching it was the first version of this class, and a leak probe caught
    // it: the errors on this path come from a transport that was handed a
    // password, and nothing stops such a library from putting the credential on
    // its own error object (`attemptedPassword`, `options`, a request snapshot).
    // `util.inspect` and structured loggers both walk `cause` by default, so an
    // attached cause carries whatever the library chose to attach straight into
    // the log aggregator. Type and message are what a responder actually needs.
    super(`ldap unavailable: ${message} (cause: ${summarise(cause)})`);
    this.name = "LdapUnavailableError";
  }
}

/**
 * A one-line, allocation-free summary of a cause: its constructor name and its
 * message, and nothing else. Deliberately does NOT recurse into the cause's own
 * cause, and never touches arbitrary own-properties — those are exactly where a
 * credential would be hiding.
 */
function summarise(cause: unknown): string {
  if (cause === undefined || cause === null) return "none";
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    const codePart = typeof code === "string" || typeof code === "number" ? ` [${String(code)}]` : "";
    return `${cause.name}${codePart}: ${cause.message}`;
  }
  return typeof cause === "string" ? cause : typeof cause;
}

/**
 * The service account itself could not bind — a deployment fault, not a user
 * fault. Separate from `LdapUnavailableError` so an operator reading a log can
 * tell "the directory is down" from "our own credential is wrong or expired",
 * which are different pages at 3am.
 */
export class LdapServiceAccountError extends Error {
  constructor(message: string) {
    super(`ldap service account: ${message}`);
    this.name = "LdapServiceAccountError";
  }
}

/**
 * TLS was not in force and the configuration did not explicitly allow that.
 *
 * Its own type because it is the one misconfiguration whose blast radius is
 * every password that will ever be typed into this system: a plaintext LDAP
 * bind puts the user's corporate password on the wire in the clear.
 */
export class LdapInsecureTransportError extends Error {
  constructor(message: string) {
    super(`ldap insecure transport: ${message}`);
    this.name = "LdapInsecureTransportError";
  }
}
