import { readFile } from "node:fs/promises";
import { Client } from "ldapts";
import type { LdapConnection, LdapConnectionFactory, LdapEntry, SearchRequest } from "./client.js";
import type { LdapIdentityConfig } from "./config.js";
import { LdapUnavailableError } from "./errors.js";
import { decideTransport } from "./transport.js";

/**
 * The one file that talks to a socket, and the only one that imports `ldapts`.
 *
 * Everything above it works against `LdapConnection`, so the entire test suite
 * runs offline against a fake directory. That is not only a testing
 * convenience: it means the security logic is verified independently of
 * whether a library version changed its error shapes.
 *
 * Why a library at all, rather than hand-rolled BER/ASN.1 (the rest of the repo
 * prefers zero new runtime dependencies — `adapter-jira` uses bare `fetch`):
 * LDAP is not HTTP. A bind request is ASN.1 BER, and a hand-written encoder on
 * the authentication path is a large, subtle attack surface of exactly the kind
 * these 22 audits keep finding. `ldapts` is MIT, TypeScript-native, actively
 * maintained, and pulls in ONE tiny transitive dependency
 * (`strict-event-emitter-types`, zero deps of its own). Borrowing a reviewed
 * protocol encoder is the smaller risk. See RAPOR.md §4.
 */

export interface LdaptsFactoryOptions {
  readonly config: LdapIdentityConfig;
  readonly nodeEnv: string;
  /** Injected for tests; defaults to reading the configured CA from disk. */
  readonly readCaCert?: (path: string) => Promise<string>;
}

export class LdaptsConnectionFactory implements LdapConnectionFactory {
  constructor(private readonly options: LdaptsFactoryOptions) {
    // Vet the URL at CONSTRUCTION, not at first login: a deployment pointed at
    // plain ldap:// should fail while someone is watching the boot, not at 2am
    // when the first user tries to sign in.
    decideTransport(options.config.url, {
      allowInsecure: options.config.allowInsecure,
      nodeEnv: options.nodeEnv,
    });
  }

  async connect(): Promise<LdapConnection> {
    const { config } = this.options;
    const tlsOptions = await this.tlsOptions();
    const client = new Client({
      url: config.url,
      timeout: config.timeoutMs,
      connectTimeout: config.timeoutMs,
      tlsOptions,
    });
    return new LdaptsConnection(client);
  }

  /**
   * TLS options: the bank's CA when configured, Node's defaults otherwise.
   *
   * `rejectUnauthorized` is never set here. Node defaults it to `true`, and the
   * way to keep it true is to have no code path that writes it — a config flag
   * for it would be set to `false` in production within a quarter, by someone
   * with a self-signed cert and a deadline, and LDAPS with an unverified peer
   * is a channel an attacker can sit in the middle of while it still looks
   * encrypted.
   */
  private async tlsOptions(): Promise<Record<string, unknown> | undefined> {
    const path = this.options.config.caCertPath;
    if (path === undefined) return undefined;
    const read = this.options.readCaCert ?? ((p: string) => readFile(p, "utf8"));
    try {
      return { ca: await read(path) };
    } catch (error) {
      // A CA that cannot be read must stop the deployment. Continuing without
      // it would fall back to the public trust store, which will not contain
      // the bank's internal root — so every bind fails anyway, but with a
      // certificate error nobody traces back to this file.
      throw new LdapUnavailableError(`CA certificate at ${path} could not be read`, error);
    }
  }
}

class LdaptsConnection implements LdapConnection {
  constructor(private readonly client: Client) {}

  /**
   * `true` / `false` for credential outcomes, throw for everything else.
   *
   * `ldapts` raises `InvalidCredentialsError` (LDAP result 49) for a wrong
   * password, which is an ANSWER; a socket reset is a FAILURE. Collapsing the
   * two would let an outage read as "wrong password" and hide it behind
   * password-reset tickets, so the codes are separated explicitly rather than
   * by catching everything.
   */
  async bindAs(dn: string, password: string): Promise<boolean> {
    try {
      await this.client.bind(dn, password);
      return true;
    } catch (error) {
      if (isCredentialRejection(error)) return false;
      throw new LdapUnavailableError("bind failed for a non-credential reason", error);
    }
  }

  async search(request: SearchRequest): Promise<readonly LdapEntry[]> {
    try {
      const { searchEntries } = await this.client.search(request.baseDn, {
        filter: request.filter,
        scope: request.scope ?? "sub",
        attributes: [...request.attributes],
        sizeLimit: request.sizeLimit,
      });
      return searchEntries.map(toEntry);
    } catch (error) {
      throw new LdapUnavailableError("search failed", error);
    }
  }

  async unbind(): Promise<void> {
    await this.client.unbind();
  }
}

/**
 * LDAP result code 49 (`invalidCredentials`) and its relatives mean the
 * directory answered. Matched on code first and name second, so a library
 * refactor that renames the class does not silently turn a rejected password
 * into an exception (which would fail the login closed — safe, but it would
 * also break every wrong-password test, which is how we would find out).
 */
function isCredentialRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 49) return true;
  const name = (error as { name?: unknown } | null)?.name;
  return name === "InvalidCredentialsError";
}

/** `ldapts` returns attribute values as `string | string[] | Buffer`; normalise. */
function toEntry(raw: Record<string, unknown>): LdapEntry {
  const attributes: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "dn") continue;
    attributes[key.toLowerCase()] = normaliseValues(value);
  }
  return { dn: String(raw["dn"] ?? ""), attributes };
}

function normaliseValues(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map(toStringValue);
  if (value === undefined || value === null) return [];
  return [toStringValue(value)];
}

function toStringValue(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}
