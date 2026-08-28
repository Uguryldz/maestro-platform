import type { LdapConnectionFactory } from "./client.js";
import type { LdapIdentityConfig } from "./config.js";
import { LdapServiceAccountError, LdapUnavailableError } from "./errors.js";
import { escapeFilterValue } from "./filter.js";

/**
 * `DirectoryReader` (`packages/workflows/src/impl/deps.ts:109`), LDAPS-backed:
 * a group name in, corporate addresses out, so a gate notification reaches the
 * people who can actually close it.
 *
 * Structurally implements the workflows interface without importing it — the
 * same M44 reason as `identity.ts`. A different agent is writing the DB-backed
 * reader against the same seam; the composition root picks one (see RAPOR.md).
 */

export interface LdapDirectoryReaderDeps {
  readonly connections: LdapConnectionFactory;
  /** The service account DN — the SAME one the identity driver binds with. */
  readonly bindDn: string;
  readonly servicePassword: () => Promise<string>;
}

export interface LdapDirectoryReaderConfig {
  readonly groupBaseDn: string;
  readonly userBaseDn: string;
  /** Attribute holding a member's address. AD: `mail`. */
  readonly mailAttribute: string;
  /** Group lookup by name, carrying `{{group}}`. */
  readonly groupLookupFilter: string;
  /** Members of a group DN, carrying `{{dn}}`. */
  readonly memberFilter: string;
  readonly timeoutMs: number;
}

export const DEFAULT_DIRECTORY_READER_CONFIG = {
  mailAttribute: "mail",
  groupLookupFilter: "(&(objectClass=group)(cn={{group}}))",
  /**
   * Members of a group, followed through nesting (1.2.840.113556.1.4.1941).
   * A notification that skipped nested groups would silently miss the very
   * approvers an escalation ladder depends on.
   */
  memberFilter: "(&(objectClass=user)(memberOf:1.2.840.113556.1.4.1941:={{dn}}))",
} as const;

/** Build the reader's config from the identity driver's, so one deployment configures both. */
export function directoryReaderConfigFrom(
  config: LdapIdentityConfig,
  overrides: Partial<LdapDirectoryReaderConfig> = {},
): LdapDirectoryReaderConfig {
  return {
    groupBaseDn: config.groupBaseDn ?? config.userBaseDn,
    userBaseDn: config.userBaseDn,
    mailAttribute: DEFAULT_DIRECTORY_READER_CONFIG.mailAttribute,
    groupLookupFilter: DEFAULT_DIRECTORY_READER_CONFIG.groupLookupFilter,
    memberFilter: DEFAULT_DIRECTORY_READER_CONFIG.memberFilter,
    timeoutMs: config.timeoutMs,
    ...overrides,
  };
}

export class LdapDirectoryReader {
  constructor(
    private readonly config: LdapDirectoryReaderConfig,
    private readonly deps: LdapDirectoryReaderDeps,
  ) {}

  /**
   * Addresses of everyone in `group`.
   *
   * An unknown group returns `[]` rather than throwing: the caller is composing
   * a notification, and a missing group is a configuration gap, not a reason to
   * fail a workflow step that has already done its work. An unreachable
   * DIRECTORY does throw — that is an outage, and a notification silently sent
   * to nobody is the failure mode operators never notice.
   */
  async membersOf(group: string): Promise<string[]> {
    // `connect()` is INSIDE the try: a refused socket is the most likely way
    // this fails, and it must surface as LdapUnavailableError like every other
    // outage rather than as whatever raw errno the transport happened to throw.
    let connection: Awaited<ReturnType<LdapConnectionFactory["connect"]>> | undefined;
    try {
      connection = await this.deps.connections.connect();
      const password = await this.deps.servicePassword();
      if (password.trim().length === 0) {
        throw new LdapServiceAccountError("resolved an empty service password — refusing anonymous bind");
      }
      if (!(await connection.bindAs(this.deps.bindDn, password))) {
        throw new LdapServiceAccountError(
          `service bind rejected for ${this.deps.bindDn} while reading group members`,
        );
      }

      const groupDn = await this.resolveGroupDn(connection, group);
      if (groupDn === null) return [];

      const entries = await connection.search({
        baseDn: this.config.userBaseDn,
        filter: this.config.memberFilter.split("{{dn}}").join(escapeFilterValue(groupDn)),
        attributes: [this.config.mailAttribute],
        scope: "sub",
        sizeLimit: 2_000,
      });

      const addresses: string[] = [];
      for (const entry of entries) {
        const mail = entry.attributes[this.config.mailAttribute.toLowerCase()]?.[0];
        if (mail !== undefined && mail.length > 0) addresses.push(mail);
      }
      return [...new Set(addresses)].sort();
    } catch (error) {
      if (error instanceof LdapServiceAccountError) throw error;
      throw new LdapUnavailableError(`group member lookup failed for "${group}"`, error);
    } finally {
      // Never let a close failure mask the real outcome.
      if (connection !== undefined) await connection.unbind().catch(() => undefined);
    }
  }

  /** Group name → DN. The name is escaped: it reaches a filter. */
  private async resolveGroupDn(
    connection: Awaited<ReturnType<LdapConnectionFactory["connect"]>>,
    group: string,
  ): Promise<string | null> {
    if (group.trim().length === 0) return null;
    const entries = await connection.search({
      baseDn: this.config.groupBaseDn,
      filter: this.config.groupLookupFilter.split("{{group}}").join(escapeFilterValue(group)),
      attributes: ["cn"],
      scope: "sub",
      sizeLimit: 2,
    });
    if (entries.length !== 1) return null;
    return entries[0]?.dn ?? null;
  }
}
