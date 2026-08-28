import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { LdapConnection, LdapConnectionFactory } from "../src/client.js";
import { directoryReaderConfigFrom, LdapDirectoryReader } from "../src/directory-reader.js";
import { LdapUnavailableError } from "../src/errors.js";
import { LdapIdentityProvider } from "../src/identity.js";
import { config } from "./fixtures.js";

/**
 * Credentials must not reach any surface an operator or a log aggregator sees.
 *
 * This suite exists because a hands-on probe found a real leak in the first
 * version of `LdapUnavailableError`: it attached the underlying error as the
 * standard `cause`, and the underlying error came from a transport that had
 * been handed a password. `util.inspect` and every structured logger walk
 * `cause` by default, so the credential travelled straight into the log.
 *
 * The fix was to SUMMARISE the cause (type + message) instead of attaching it.
 * These tests pin that behaviour down.
 */

const SERVICE_PASSWORD = "UNIQUE-SERVICE-PW-9f3a2b7c";
const USER_PASSWORD = "UNIQUE-USER-PW-4d8e1a";

/** A transport that puts the credential on its own error, as libraries do. */
const leakyTransport: LdapConnectionFactory = {
  connect: () =>
    Promise.resolve({
      bindAs: (dn: string, password: string) => {
        const error = new Error(`transport failure while binding ${dn}`) as Error & {
          attemptedPassword?: string;
        };
        error.attemptedPassword = password;
        return Promise.reject(error);
      },
      search: () => Promise.resolve([]),
      unbind: () => Promise.resolve(),
    } satisfies LdapConnection),
};

const rejectingTransport: LdapConnectionFactory = {
  connect: () =>
    Promise.resolve({
      bindAs: () => Promise.resolve(false),
      search: () => Promise.resolve([]),
      unbind: () => Promise.resolve(),
    } satisfies LdapConnection),
};

/** Every surface a responder or a log pipeline could realistically read. */
function everySurface(value: unknown): string {
  const parts = [String(value), inspect(value, { depth: 10 })];
  try {
    parts.push(JSON.stringify(value) ?? "");
  } catch {
    parts.push("");
  }
  if (value instanceof Error) {
    parts.push(value.stack ?? "");
    parts.push(JSON.stringify(value, Object.getOwnPropertyNames(value)));
  }
  return parts.join("\n");
}

describe("secret hygiene", () => {
  it("does not carry a credential out of a leaky transport error", async () => {
    const provider = new LdapIdentityProvider(config(), {
      connections: leakyTransport,
      servicePassword: () => Promise.resolve(SERVICE_PASSWORD),
    });

    const error = await provider.authenticate("alice", USER_PASSWORD).catch((e: unknown) => e);
    const surfaces = everySurface(error);

    expect(surfaces).not.toContain(SERVICE_PASSWORD);
    expect(surfaces).not.toContain(USER_PASSWORD);
  });

  it("summarises the cause instead of attaching it", () => {
    const inner = new Error("inner failure") as Error & { attemptedPassword?: string };
    inner.attemptedPassword = SERVICE_PASSWORD;

    const wrapped = new LdapUnavailableError("something broke", inner);

    // The responder still learns the type and message...
    expect(wrapped.message).toContain("Error");
    expect(wrapped.message).toContain("inner failure");
    // ...but the object graph carrying the credential is gone.
    expect(wrapped.cause).toBeUndefined();
    expect(everySurface(wrapped)).not.toContain(SERVICE_PASSWORD);
  });

  it("keeps a credential out of the service-account error, but keeps the reference in", async () => {
    const provider = new LdapIdentityProvider(config(), {
      connections: rejectingTransport,
      servicePassword: () => Promise.resolve(SERVICE_PASSWORD),
    });

    const error = await provider.authenticate("alice", USER_PASSWORD).catch((e: unknown) => e);
    const surfaces = everySurface(error);

    expect(surfaces).not.toContain(SERVICE_PASSWORD);
    // The REFERENCE is what an operator needs to fix the deployment.
    expect(surfaces).toContain("kv/ldap#service-password");
  });

  it("does not expose the service password on the provider object itself", () => {
    const provider = new LdapIdentityProvider(config(), {
      connections: rejectingTransport,
      servicePassword: () => Promise.resolve(SERVICE_PASSWORD),
    });

    // The password is behind a closure, never a field: inspecting the live
    // driver (a heap dump, a debugger, a crash reporter) reveals nothing.
    expect(everySurface(provider)).not.toContain(SERVICE_PASSWORD);
  });

  it("does not expose the service password through the directory reader", async () => {
    const reader = new LdapDirectoryReader(directoryReaderConfigFrom(config()), {
      connections: leakyTransport,
      bindDn: config().bindDn,
      servicePassword: () => Promise.resolve(SERVICE_PASSWORD),
    });

    const error = await reader.membersOf("maestro-admins").catch((e: unknown) => e);

    expect(everySurface(error)).not.toContain(SERVICE_PASSWORD);
    expect(everySurface(reader)).not.toContain(SERVICE_PASSWORD);
  });

  it("never logs the user's password even on the success path", async () => {
    // The user password is passed to bindAs and nowhere else — it is not
    // stored, echoed in the result, or attached to the session shape.
    const captured: string[] = [];
    const recording: LdapConnectionFactory = {
      connect: () =>
        Promise.resolve({
          bindAs: (dn: string, password: string) => {
            captured.push(`${dn}:${password}`);
            return Promise.resolve(true);
          },
          search: () => Promise.resolve([]),
          unbind: () => Promise.resolve(),
        } satisfies LdapConnection),
    };

    const provider = new LdapIdentityProvider(config(), {
      connections: recording,
      servicePassword: () => Promise.resolve(SERVICE_PASSWORD),
    });
    const user = await provider.authenticate("alice", USER_PASSWORD);

    // No entry was found (search returns []), so no user object comes back...
    expect(user).toBeNull();
    // ...and the only place the user password appeared is the bind call itself.
    expect(captured.filter((c) => c.includes(USER_PASSWORD))).toHaveLength(0);
  });
});
