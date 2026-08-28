import type { DirectoryReader } from "@maestro/workflows";

/**
 * The database-backed `DirectoryReader` (M8/M71).
 *
 * Group -> the corporate addresses a notification goes to. The MVP's directory
 * is the local `User` table (`groupsJson`), which is what the platform has
 * before an LDAPS bind exists. The interface is one method wide precisely so
 * the LDAPS driver can replace this one without any caller knowing — see
 * {@link firstAvailableDirectory} for the composition that lets both run at
 * once during a migration.
 */

export interface DirectoryUserRow {
  email: string;
  groupsJson: unknown;
  active: boolean;
}

export interface DirectoryUserDelegate {
  findMany(args: { where: { active: boolean } }): Promise<DirectoryUserRow[]>;
}

export class PrismaDirectoryReader implements DirectoryReader {
  /**
   * @param resolveRole role -> directory group. Optional: the local `User`
   * table has no notion of a workflow role, and a deployment whose groups are
   * already named `product-owners` needs no mapping. Omitting it means "the
   * role IS the group", which is what the tests assume.
   */
  constructor(
    private readonly users: DirectoryUserDelegate,
    private readonly resolveRole: (role: string) => string = (role) => role,
  ) {}

  /** See {@link DirectoryReader.groupForRole} for why this exists. */
  groupForRole(role: string): Promise<string> {
    return Promise.resolve(this.resolveRole(role));
  }

  /**
   * Members of `group`, by e-mail.
   *
   * Filtering happens in this process rather than in the query: `groupsJson`
   * is a JSON array column, and a `has`-style predicate over it would only be
   * correct for values that are genuinely arrays of strings. The column can
   * hold anything, so the parse is the filter — the same reasoning
   * `PrismaUserDirectory.parseGroups` follows, and the reason both refuse to
   * treat a malformed value as a membership.
   *
   * Deactivated users are excluded at the query. A departed approver's row is
   * kept as evidence (their name is on closed gates), but they must not
   * receive a gate reminder for a gate they can no longer close.
   *
   * An empty result is NOT an error here, and that is deliberate: a group with
   * no members is a real, reportable state ("nobody holds this gate"), and the
   * caller — the notifier — is the one that decides what to do about it. What
   * would be wrong is inventing an address, which this never does.
   */
  async membersOf(group: string): Promise<string[]> {
    const rows = await this.users.findMany({ where: { active: true } });
    return rows
      .filter((row) => parseGroups(row.groupsJson).includes(group))
      .map((row) => row.email)
      .sort();
  }
}

/**
 * Chain several directories, first non-empty answer wins.
 *
 * This is the seam the LDAPS driver plugs into. During a migration both are
 * live: LDAPS is asked first and the local table answers for the service
 * accounts and break-glass users that are not in the corporate directory.
 *
 * A reader that THROWS does not end the chain — a directory that is down must
 * not silently empty a distribution list, so the next one is asked and the
 * failure is only fatal if every reader failed. Ending the chain on the first
 * error would turn an LDAPS outage into "this gate has no approvers", which
 * reads exactly like a correctly-empty group.
 */
export function firstAvailableDirectory(
  readers: readonly DirectoryReader[],
): DirectoryReader {
  if (readers.length === 0) {
    throw new Error("directory: at least one reader is required");
  }
  return {
    async membersOf(group: string): Promise<string[]> {
      const failures: unknown[] = [];
      for (const reader of readers) {
        try {
          const members = await reader.membersOf(group);
          if (members.length > 0) return members;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === readers.length) {
        throw new AggregateError(
          failures,
          `directory: every reader failed to resolve group ${group}`,
        );
      }
      return [];
    },
    /**
     * The FIRST reader answers, without the fallback loop `membersOf` uses.
     *
     * Role naming is deployment configuration, not data that a directory might
     * be missing: "no answer" is not a state here, and asking a second reader
     * would only mean a second opinion on the same static mapping. During an
     * LDAPS migration the primary reader is the one carrying the config.
     */
    groupForRole: (role: string): Promise<string> => {
      const [primary] = readers;
      // Guarded above, but the compiler does not know that.
      return primary === undefined ? Promise.resolve(role) : primary.groupForRole(role);
    },
  };
}

function parseGroups(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
