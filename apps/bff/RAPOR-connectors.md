# RAPOR — Connector Management Surface

Turns the platform's outbound connections (Jira, GitHub, LLM/OpenRouter,
Anthropic, Vault, ADO, SMTP, storage) from read-only *deployment facts* into a
**real, admin-editable connector management screen**. An admin enters a URL +
token from Studio, clicks **Test et** to verify the connection LIVE, tokens are
stored **AES-256-GCM encrypted** in the DB and shown **masked** (`****abcd`).

This is the editable counterpart to the existing read-only `ConnectionView`
(`StaticSettingsReader`/`EnvSettingsReader`), which stays untouched — those
report an endpoint + a Vault credential reference the platform was *deployed*
with. The new surface is a different concept and a different type, deliberately.

---

## Contract changes (the two approved interface additions)

### 1. `SecretPort.set(key, value)` — `packages/ports/src/secret.ts`
`SecretPort` had only `get`/`issueShortLived`. Added `set(key, value): Promise<void>`
so a connector UI can WRITE a secret. Blast radius (all updated):

- **Real drivers** (`packages/secrets`): `VaultSecretPort.set` and
  `EnvFileSecretPort.set` both **throw `CapabilityNotSupportedError`** — a
  console must NOT be able to rewrite the Vault mount / env an operator
  provisions. The only SecretPort whose `set` actually writes is the new
  DB-backed `EncryptedSecretStore`.
- **Test fakes** updated to add `set` (8 sites): notify, llm-gateway,
  runner-agent, workflows, publish, adapter-jira (×2), demo, deploy/identity.

### 2. `Connection` / `ConnectionInput` Zod schema — `packages/contracts/src/connection.ts` (new, exported from index)
- `ConnectionKind` = `jira_cloud | jira_dc | github | ado | openrouter |
  anthropic | vault | smtp | storage`
- `ConnectionAuthKind` = `basic | bearer | pat | api_key`
- `Connection` (READ shape): `id, kind, displayName, baseUrl, authKind, config
  (Record<string,string>), secretRef, secretMask, secretSet, enabled,
  createdAt, updatedAt, lastTestedAt, lastTestOk`. **No `token` field** — a GET
  cannot return the secret because the type has nowhere to put one.
- `ConnectionInput` (WRITE shape): the non-secret fields plus `token?`
  (write-only, optional, never echoed). Config values are string-only, so a
  token cannot be smuggled in as "config".

Everything else in contracts/ports stays frozen.

## Data model + migration 0010

`packages/db/prisma/schema.prisma` + `prisma/migrations/0010_connections/migration.sql`:

- **`Connection`** table: `id (PK), kind, displayName, baseUrl, authKind,
  configJson (JSONB), secretRef (nullable — points at ConnectorSecret, NEVER the
  token), secretMask (last-4, nullable), enabled, createdAt, updatedAt,
  lastTestedAt (nullable), lastTestOk (nullable Boolean)`. CHECK:
  `(lastTestedAt IS NULL) = (lastTestOk IS NULL)` so a test result and its
  timestamp move together. `kind`/`authKind` are text (schema's @map-free
  convention; the Zod unions validate).
- **`ConnectorSecret`** table: `ref (PK), iv, ciphertext, authTag, keyVersion,
  createdAt, updatedAt`. Separate table so a query that reads connections for a
  screen cannot select the ciphertext. The master key is NOT stored.

`Connection`/`ConnectorSecret` are KEPT (not cleared) on a routine reset — they
are platform configuration like Param/DocTemplate.

## Encryption approach

`apps/deploy/src/stores/encrypted-secret.ts` — `EncryptedSecretStore implements SecretPort`:
- **AES-256-GCM**, a **fresh random 12-byte IV per write** (GCM nonce reuse is a
  break), the **16-byte auth tag verified on decrypt** — a tampered ciphertext
  or a wrong key makes `final()` **throw**, never returns altered plaintext.
- `set` encrypts, `get` decrypts. The plaintext is a local buffer for the length
  of the cipher call and is **never logged**; no error this store throws carries
  the value (only the ref, which is a slot name).
- **Master key** from env `CONNECTOR_MASTER_KEY` (base64, 32 bytes). In **prod**
  it is REQUIRED — `resolveMasterKey` **throws** if missing. In **dev** a
  documented deterministic key is derived from `DEV_MASTER_KEY_SEED` **with a
  loud WARN** ("tokens are NOT securely encrypted") — never silent.

## BFF routes (`apps/bff/src/routes/connections.ts`, admin-gated)

Registered in `server.ts`; refuse **503 by name** (`unwired("connections")`)
when the store + encrypting SecretPort are not both wired.

- `GET /studio/connections` — list, masked (admin + tech-lead read).
- `POST /studio/connections` — create; Zod-validated; a new token is enciphered
  via `SecretPort.set`, only the ref+mask stored. (admin)
- `PUT /studio/connections/:id` — update; a new token rotates the ref, an absent
  token keeps the stored one (config-only edit). (admin)
- `POST /studio/connections/:id/test` — **LIVE test**, records `lastTestedAt`/`lastTestOk`. (admin)
- `DELETE /studio/connections/:id` — removes the connection AND its secret. (admin)

Writes go through `assertWritable` (kill switch) and audit as `PARAM_CHANGED`
(subject `connection:<id>`, meta = verb only — never the token or the URL).

## Test-et behaviour per kind (injected fetch — offline in tests, real `fetch` live)

The URL is built from the **stored** `baseUrl` + the kind's probe path (never a
request body → no SSRF), using the **stored** token (never a caller-supplied one
→ a viewer cannot exfiltrate via a crafted test; they also can't reach the
admin-gated route):

| kind | probe | ok signal |
|---|---|---|
| `jira_cloud` | `GET /rest/api/3/myself` (Basic email:token) | 200 → displayName |
| `jira_dc` | `GET /rest/api/2/myself` (Bearer) | 200 → displayName |
| `github` | `GET /user` (Bearer) | 200 → login |
| `openrouter` | `GET /models` (Bearer) | 200 |
| `anthropic` | `GET /models` (x-api-key + version) | 200 |
| `vault` | `GET /v1/auth/token/lookup-self` (x-vault-token) | 200 |
| `ado` | `GET /_apis/connectionData` (Basic :token) | 200 → providerDisplayName |
| `smtp`, `storage` | — | honest `connections.test.not_implemented` |

Outcomes are catalog KEYS (M104): `ok`, `ok_as`, `no_token`, `http_error`,
`unreachable`, `not_implemented`. A failure is reported as a failure — never a
fake green — and a thrown fetch is swallowed to `unreachable` so no error
message (which could carry the URL/headers) reaches the screen.

## How the token is kept secret

- Read side (`Connection`) has **no token field** → no GET can return it.
- `POST`/`PUT` store the enciphered **ref** + a **4-char mask**; the raw token
  is absent from the connection row (verified by tests).
- The token is decrypted **only** inside the test handler, passed to the probe,
  **never logged, never returned**.
- Every write/test/delete is **admin-only** at the BFF, independent of the UI.

## Studio (`apps/studio/src/screens/settings/ConnectorsPanel.tsx`, wired into `Settings.tsx`)

A real **Bağlantılar** section: a table with tri-state status (● bağlı / ✕ hata
/ ⚪ test edilmedi), **➕ Bağlantı ekle** modal (kind/URL/auth/token), per-row
**Düzenle · 🔌 Test et · Sil**. Token shows `****abcd` when set with a
**değiştir** to enter a new one; **Test et** calls the live endpoint and renders
the result inline in Turkish. Admin-gated (viewer sees no write control). New
`connections.*` and `error.*` catalog keys added to tr + en.

## Demo-stack

Not wired into the demo-stack launcher (follow-up note): the primary deliverable
is BFF + Studio + DB, and the launcher wiring risked scope creep. The composition
root (`apps/deploy/src/bin/bff.ts`) wires the real stores, so a real deployment
has the feature live.

---

## Tests (all offline: injected fetch + fake DB)

| suite | file | count |
|---|---|---|
| contracts | `packages/contracts/test/connection.test.ts` | 11 |
| encryption round-trip / tamper / wrong-key / dev-key WARN / prod-refuse | `apps/deploy/test/encrypted-secret.test.ts` | 14 |
| Prisma connection store round-trip / restart / mask-not-token | `apps/deploy/test/connections-store.test.ts` | 8 |
| BFF routes: mask, encrypt-on-store, per-kind test URL+token, admin-gate, no-leak, unwired-503 | `apps/bff/test/connections.test.ts` | 17 |
| Studio panel: mask, tri-state, viewer-hidden, live test inline, config-only edit omits token | `apps/studio/test/screens-connectors.test.tsx` | 6 |

Full gate green: `@maestro/bff` (594), `@maestro/studio` (248), `@maestro/deploy`
typecheck+test (457), `@maestro/contracts` (44), `@maestro/ports` (5),
`@maestro/db` typecheck+test (197), `@maestro/secrets` (197). `pnpm lint` clean
for these files (only pre-existing warnings in an untouched demo-stack file).

---

## doğrulayıcı düzeltmeleri (verifier round 2)

The security core (AES-GCM, type-level token secrecy, tamper→throw, test-endpoint
can't exfiltrate) PASSED and was left untouched. Four fixes applied:

1. **CRITICAL — secret-ref collision on token rotation.** The ref was
   `connector:${id}:${Date.now().toString(36)}`; two rotations in the same
   millisecond would collide and the second `SecretPort.set` would overwrite the
   first secret's slot instead of taking a new one. Now
   `connector:${id}:${randomBytes(6).toString("hex")}` — a fresh, unguessable
   slot per rotation. (`routes/connections.ts`)
2. **Studio catalog — 4 missing error codes.** `invalid_connection_id`,
   `invalid_connection_body`, `connection_exists`, `no_such_connection` added to
   `apps/studio/src/api/errors.ts` and to tr+en locales, so the
   `api-client.test.ts > covers every error code the BFF throws` guard passes.
3. **Deploy typecheck — missing fake.** `apps/deploy/test/identity.test.ts`
   SecretPort fake got its `set` method.
4. **Studio screen (was backend-only).** Added `ConnectorsPanel.tsx` +
   `ManagedConnection*` api types + api-client get/create/update/test/delete +
   a 6-test component suite, and wired the panel into `Settings.tsx`.
