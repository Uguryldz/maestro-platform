import type { LdapConnection, LdapConnectionFactory, LdapEntry, SearchRequest } from "../src/client.js";
import { eq, matchesFilter, parseFilter } from "./filter-engine.js";

/**
 * A fake LDAP directory: an in-memory server that actually PARSES the filter
 * the driver sends (see `filter-engine.ts`), so the injection tests assert on
 * real behaviour rather than on a canned response.
 *
 * `bindAs` models RFC 4513 §5.1.2 faithfully, including the trap: a zero-length
 * password is an unauthenticated bind and returns SUCCESS. If the driver ever
 * stops rejecting empty passwords up front, the empty-password test fails here
 * rather than in production.
 */

export interface FakeAccount {
  readonly dn: string;
  readonly password: string;
  readonly attributes: Record<string, readonly string[]>;
}

export interface FakeGroup {
  readonly dn: string;
  readonly attributes: Record<string, readonly string[]>;
  /** DNs of member entries. */
  readonly members: readonly string[];
}

export interface FakeDirectoryOptions {
  readonly accounts: readonly FakeAccount[];
  readonly groups?: readonly FakeGroup[];
  /** Service account DN → password. */
  readonly serviceAccounts?: Record<string, string>;
  /** When set, every operation rejects with this — models an outage. */
  readonly failWith?: Error;
}

export interface RecordedBind {
  readonly dn: string;
  readonly password: string;
}

export class FakeDirectory implements LdapConnectionFactory {
  readonly binds: RecordedBind[] = [];
  readonly searches: SearchRequest[] = [];
  connectCount = 0;

  constructor(private readonly options: FakeDirectoryOptions) {}

  connect(): Promise<LdapConnection> {
    this.connectCount += 1;
    if (this.options.failWith !== undefined) return Promise.reject(this.options.failWith);
    return Promise.resolve(new FakeConnection(this.options, this));
  }
}

class FakeConnection implements LdapConnection {
  constructor(
    private readonly options: FakeDirectoryOptions,
    private readonly recorder: FakeDirectory,
  ) {}

  bindAs(dn: string, password: string): Promise<boolean> {
    this.recorder.binds.push({ dn, password });
    if (this.options.failWith !== undefined) return Promise.reject(this.options.failWith);

    /**
     * RFC 4513 §5.1.2 — the anonymous/unauthenticated bind. A real directory
     * answers success to an empty password, which is precisely why the driver
     * must never reach this call with one.
     */
    if (password.length === 0) return Promise.resolve(true);

    const service = this.options.serviceAccounts?.[dn];
    if (service !== undefined) return Promise.resolve(service === password);

    const account = this.options.accounts.find((a) => eq(a.dn, dn));
    if (account === undefined) return Promise.resolve(false);
    return Promise.resolve(account.password === password);
  }

  search(request: SearchRequest): Promise<readonly LdapEntry[]> {
    this.recorder.searches.push(request);
    if (this.options.failWith !== undefined) return Promise.reject(this.options.failWith);

    const node = parseFilter(request.filter);
    const groups = this.options.groups ?? [];
    const candidates: LdapEntry[] = [
      ...this.options.accounts.map((a) => ({ dn: a.dn, attributes: lower(a.attributes) })),
      ...groups.map((g) => ({
        dn: g.dn,
        attributes: lower({ ...g.attributes, member: g.members }),
      })),
    ];

    const matched = candidates.filter(
      (entry) => inScope(entry.dn, request.baseDn) && matchesFilter(entry, node, { groups }),
    );
    return Promise.resolve(matched.map((entry) => project(entry, request.attributes)));
  }

  unbind(): Promise<void> {
    return Promise.resolve();
  }
}

function inScope(dn: string, baseDn: string): boolean {
  return dn.trim().toLowerCase().endsWith(baseDn.trim().toLowerCase());
}

function lower(attributes: Record<string, readonly string[]>): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(attributes)) out[key.toLowerCase()] = value;
  return out;
}

function project(entry: LdapEntry, attributes: readonly string[]): LdapEntry {
  const wanted = new Set(attributes.map((a) => a.toLowerCase()));
  const out: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(entry.attributes)) {
    if (wanted.has(key)) out[key] = value;
  }
  return { dn: entry.dn, attributes: out };
}
