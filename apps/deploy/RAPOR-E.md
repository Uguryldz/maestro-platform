# RAPOR — Dalga E (prod hardening)

Two independent pieces, both in the deploy composition root and its stores. The
BFF's `deps.ts` interfaces (`SessionStore`, `KillSwitchStore`, `IdentityProvider`)
and `packages/contracts`/`packages/ports` were NOT touched — every new store and
the identity switch implement the existing interfaces structurally, and every
logic file has an offline test (fake delegate / fake secrets, no live DB, no real
LDAP).

## 1. Durable sessions + durable kill switch

### New tables + migration

- **`Session`** — one row per live token. `token` (VARCHAR 128) is the primary
  key; `userId`, `username`, `rolesJson`/`groupsJson` (frozen at issue time),
  `delegated`, `issuedAt`, `expiresAt`. Indexed on `userId` (logout / off-boarding
  act on the account) and `expiresAt` (the TTL sweep). CHECK
  `expiresAt > issuedAt`.
- **`KillSwitch`** — single durable row. `id` VARCHAR(8) primary key, pinned to
  the sentinel `'ONLY'` by a CHECK so `get()` is a point lookup and never "the
  newest of several"; `level` (CHECK `IN ('off','intake_only','all')`), `actor`,
  `reason`, `at`.
- **Migration: `packages/db/prisma/migrations/0008_sessions_killswitch/migration.sql`**
  — hand-written (the three CHECKs have no Prisma syntax), same style as 0002/0006/0007.
  Delivered only; NOT applied against the live DB. `db.session` / `db.killSwitch`
  delegates exist after `prisma generate`.
- Schema models added to `packages/db/prisma/schema.prisma`. Both tables added to
  the reset "KEEPS" set in `packages/db/src/reset.ts` — a routine reset must not
  sign the operator out or, worse, RELEASE the brake.

### New Postgres stores (apps/deploy/src/stores/)

- **`PrismaSessionStore`** (`stores/sessions.ts`) — implements `SessionStore`
  (`create`/`get`/`delete`/`listByUser`/`deleteByUser`) over a structural
  `session` delegate. `delete` swallows Prisma `P2025` (a raced logout is a no-op,
  not a 500). Timing note documented: a PK lookup is not constant-time, but a
  256-bit CSPRNG token has nothing to enumerate, so the map-scan the in-memory
  store used is unnecessary here.
- **`PrismaKillSwitchStore`** (`stores/killswitch.ts`) — implements `KillSwitchStore`
  (`get`/`set`) as an UPSERT over the single sentinel row. A missing row reads OFF
  (fresh install); an unreadable `level` fails CLOSED (`all`) via `toLevel`, never
  open.

Both mirror `PrismaUserDirectory`: structural delegate, offline-testable with a
plain object, no `@prisma/client` in the type surface.

### VOLATILE_STORES change (apps/deploy/src/bin/bff.ts)

- **Removed** `killSwitch` (was the only FATAL entry) and `sessions`.
- **Kept** `params (pending proposals only)` — genuinely volatile and cannot be
  faked durable: a pending four-eyes proposal is a value with no approver, and the
  `ParamVersion` CHECK (migration 0002) refuses exactly that, so it has no row to
  live in. Losing one costs the first approver a second click (the value was never
  applied), so it is reported, not a refusal. Applied param VALUES are durable.
- Wiring: `sessions: new PrismaSessionStore(db.session)`,
  `killSwitch: new PrismaKillSwitchStore(db.killSwitch)`.
- `assertStoresDurable`/`FATAL_IF_VOLATILE` machinery left UNCHANGED on purpose:
  the guard still names the kill switch, so a future regression that fed a volatile
  one back in is still refused at boot. The deployment simply stopped tripping it.
  `durability.test.ts` (which uses its own local fixtures, not bff.ts's array)
  stays green.

**Legitimately still volatile:** only the pending four-eyes proposal queue, for
the reason above. Nothing else — sessions and the kill switch are now durable.

## 2. LDAP identity wiring

- **`apps/deploy/src/identity.ts`** — `selectIdentityProvider(env, { secrets, users })`
  picks the provider by `env.base.IDENTITY_DRIVER` (from `@maestro/config`'s
  `EnvSchema`, which already declared `IDENTITY_DRIVER=local|ldaps-bind` and the
  `LDAP_*` requirements). `local` (default) → `LocalIdentityProvider` + bcrypt over
  the Postgres user directory, unchanged. `ldaps-bind` →
  `createLdapIdentityProvider(ldapConfigFrom(env), { secrets, nodeEnv })`.
- `ldapConfigFrom` maps the deployment's `LDAP_*` vocabulary onto the adapter's
  config keys, resolving the service password from `LDAP_BIND_PASSWORD_REF` (a
  REFERENCE) and parsing `LDAP_ROLE_MAPPINGS` via the adapter's `parseRoleMappings`.
  Optional keys are omitted when unset so the adapter's defaults win; the real
  `LdapIdentityConfig` parse runs inside `createLdapIdentityProvider`.
- **No silent fallback** from LDAP to local: the adapter fails CLOSED on an
  unreachable directory, so `ldaps-bind` means the bank's directory IS the
  authority. Local stays the DEFAULT (unset/`local`), not a runtime fallback. The
  local provider is not weakened.
- `@maestro/adapter-ldap` added as a `apps/deploy` dependency.
- Session/kill-switch durability is composed independently in `bff.ts` and does
  not depend on which identity driver is active.
- `bff.ts`: `identity: selectIdentityProvider(env, { secrets, users })`; `secrets`
  is now destructured from `bootPlatform`.

## Tests

Offline only (no live DB, no real LDAP):

- `packages/db` — added the 0008 migration-text block (6 assertions) to
  `test/migration.test.ts`, live-guard behaviour to `test/live-guards.test.ts`
  (opt-in, skipped without `TEST_DATABASE_URL`), and Session/KillSwitch to the
  reset kept-set test. **193 passed | 10 skipped.**
- `apps/deploy` — new `test/sessions.test.ts` (10), `test/killswitch.test.ts` (7),
  `test/identity.test.ts` (7). **432 passed | 31 skipped.**
- Unchanged packages verified green: `@maestro/bff` 525, `@maestro/adapter-ldap`
  104.
- `pnpm -F @maestro/deploy typecheck && test` green; `pnpm -F @maestro/db
  typecheck && test` green; repo `pnpm lint` clean.

## Files

New: `packages/db/prisma/migrations/0008_sessions_killswitch/migration.sql`,
`apps/deploy/src/stores/sessions.ts`, `apps/deploy/src/stores/killswitch.ts`,
`apps/deploy/src/identity.ts`, and the three deploy test files.

Changed: `packages/db/prisma/schema.prisma`, `packages/db/src/reset.ts`,
`packages/db/test/{migration,live-guards,reset}.test.ts`,
`apps/deploy/src/bin/bff.ts`, `apps/deploy/src/stores/durability.ts`,
`apps/deploy/package.json`.
