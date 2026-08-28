import type { SecretPort } from "@maestro/ports";
import { LdapIdentityConfig } from "./config.js";
import { directoryReaderConfigFrom, LdapDirectoryReader } from "./directory-reader.js";
import { LdapConfigError } from "./errors.js";
import { LdapIdentityProvider } from "./identity.js";
import { LdaptsConnectionFactory } from "./ldapts-client.js";

/**
 * Composition helpers (M44 clean-room DI): the core never imports this package,
 * the composition root calls these once.
 *
 * `IdentityProvider` is not a registered PORT — it lives in the BFF's `deps.ts`
 * rather than `@maestro/ports`, so there is no `PortRegistry` entry to make and
 * these are plain factories instead. See the interface request in RAPOR.md.
 */

export interface LdapDriverDeps {
  readonly secrets: SecretPort;
  readonly nodeEnv: string;
}

function parseConfig(input: unknown): LdapIdentityConfig {
  const parsed = LdapIdentityConfig.safeParse(input);
  if (!parsed.success) {
    throw new LdapConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

/**
 * The identity driver, wired to Vault for the service password.
 *
 * The password is resolved per call rather than captured at construction: a
 * rotated service credential then takes effect at the next login instead of at
 * the next restart, and nothing in this process holds a long-lived copy of it.
 */
export function createLdapIdentityProvider(input: unknown, deps: LdapDriverDeps): LdapIdentityProvider {
  const config = parseConfig(input);
  const connections = new LdaptsConnectionFactory({ config, nodeEnv: deps.nodeEnv });
  return new LdapIdentityProvider(config, {
    connections,
    servicePassword: () => deps.secrets.get(config.bindPasswordRef),
  });
}

/** The LDAPS-backed `DirectoryReader`, sharing the identity driver's connection settings. */
export function createLdapDirectoryReader(input: unknown, deps: LdapDriverDeps): LdapDirectoryReader {
  const config = parseConfig(input);
  const connections = new LdaptsConnectionFactory({ config, nodeEnv: deps.nodeEnv });
  return new LdapDirectoryReader(directoryReaderConfigFrom(config), {
    connections,
    bindDn: config.bindDn,
    servicePassword: () => deps.secrets.get(config.bindPasswordRef),
  });
}
