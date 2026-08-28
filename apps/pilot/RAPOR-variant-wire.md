# RAPOR — the last wire: LIVE pilot reads its model from the variant DB

**Goal.** `resolveVariantModel` + the `VariantModelReader` port existed and were
tested, but the *running* pilot (`apps/pilot/src/main.ts` → `bootPilot({ startDiscovery: true })`)
passed **no** `variantReader`, so it fell back to env `PILOT_MODEL` with a loud
warning. This change wires a real Postgres-backed reader into the pilot's boot so
the DB-first path (the model an admin set in Studio) is actually used at runtime.

## What was built

1. **`apps/deploy/src/stores/variant-model-reader.ts` — `PrismaVariantModelReader`.**
   Implements the pilot's `VariantModelReader` shape *structurally*
   (`activeModel(variantId): Promise<string | null>`). Given a variant id it reads
   the **active** (highest-numbered, newest published) `VariantVersion` and returns
   its `model` — the same "newest is active" rule `PrismaVariantCatalog` uses,
   kept narrow because the pilot binds a role only to a model (persona/knowledge
   are resolved elsewhere). Blank/whitespace model → `null` (a real "no published
   model" answer the pilot falls back on); a throwing delegate (Postgres
   unreachable) **propagates** rather than degrading to env. Structural
   `VariantVersionModelDelegate` (the generated Prisma delegate satisfies it), so
   it is offline-testable with a fake — no live DB.

2. **`apps/deploy/src/bin/pilot.ts` — the LIVE, DB-first pilot launcher.**
   Lives in the composition root (`apps/deploy`), the one app that may talk to
   Postgres. It builds a `PrismaVariantModelReader` over the real `variantVersion`
   delegate and calls `bootPilot({ startDiscovery: true, variantReader })`. With
   the reader wired, `bootPilot` resolves each role's model from its variant's
   active version (the DB) and the env-fallback warning is **not** emitted.
   Exposed as `pnpm -F @maestro/deploy start:pilot`.
   - `variantReaderFromEnv(env, makeDb=createDb)` is extracted so the
     DB-first-vs-fail decision is unit-testable without Postgres (`createDb`
     injected). It **fails closed** (M6) when `DATABASE_URL` is absent/blank — a
     deployment with no database is meant to run the standalone `main.ts`, so
     picking this binary without a URL is a config error, not a silent degrade.

3. **`apps/pilot/src/index.ts` + `exports` in `apps/pilot/package.json`.** A tiny
   barrel exposing `bootPilot`, `BootOptions`, `PilotStage`, and the
   `VariantModelReader` / `ResolvedVariantModel` **types** so a launcher can boot
   the pilot. Only the port *type* crosses the boundary.

## What stays DB-free (the constraint)

`apps/pilot` gained **no** `@maestro/db` dependency (verified: no dep in its
`package.json`, no `@maestro/db` import in `src/` — the only mention is a
comment). `apps/pilot/src/main.ts` is unchanged: it still boots the pilot with no
reader → env `PILOT_MODEL` fallback + warning, which is correct for an
offline/dev pilot. The DB dependency lives entirely in `apps/deploy`, which
already binds every real Postgres store. The pilot only ever sees the injectable
port.

## The DB-first-at-runtime proof

- `apps/pilot/test/boot-variant.test.ts` (**+2**) drives the *whole* `bootPilot`:
  - **reader wired** → `store.snapshot().model` and `settings.snapshot().model`
    are the **variant's** model (`studio/analyst-model`), and the
    `"varyant deposu bağlı değil"` fallback warning is **never** logged.
  - **no reader (DB-free, = main.ts)** → model falls back to the bootstrap
    `PILOT_MODEL` (asserted as `defaultSettings().model` so it holds under a clean
    *and* a polluted `PILOT_MODEL` shell), and the warning fires **once per role**
    (analyst + engineer).
- `apps/deploy/test/pilot-launcher.test.ts` (**+3**) proves the wiring with a fake
  `createDb`: the env `DATABASE_URL` reaches `createDb`, the reader resolves the
  **active** (newest) version's model DB-first, and an absent/blank URL fails
  closed without ever constructing a client.
- `apps/deploy/test/variant-model-reader.test.ts` (**+5**) pins the reader:
  newest-version model, no-version → `null`, blank model → `null`, trimming, and
  a throwing delegate propagates.

## Verification

- `pnpm -F @maestro/pilot typecheck` — clean.
- `pnpm -F @maestro/pilot test` — **86 passed** (was 84) on a **clean** shell AND
  a **polluted** shell (`PILOT_SCM=github GITHUB_TOKEN=… PILOT_MODEL=polluted/model
  DATABASE_URL=…`). ≥ 79. ✔
- `pnpm -F @maestro/deploy typecheck` — clean (touched).
- `pnpm -F @maestro/deploy test` — 471 passed / 31 skipped (my 8 new tests
  included).
- `pnpm lint` — clean.
- Contracts/ports **frozen**: no change to `apps/pilot/src/variant.ts` (the
  `VariantModelReader` interface) or to `boot.ts`'s `variantReader?` option — this
  is purely the missing *wiring*.

**Pre-existing, unrelated:** `packages/publish` typecheck fails on
`test/confluence-driver.test.ts` (a `SecretPort` mock missing `set`) — present on
pristine `main`, not touched here.

## Test count

- pilot: 84 → **86** (+2).
- deploy: +8 (5 reader + 3 launcher).
