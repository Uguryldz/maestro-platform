-- Managed connectors (the connector-management surface).
--
-- Turns the platform's outbound connections (Jira, GitHub, LLM, Vault, …) from
-- read-only deployment facts into rows an admin edits from Studio. Two tables:
--
--   1. Connection      — the editable connection: URL, auth kind, non-secret
--                        config, and a REFERENCE to the encrypted token. The
--                        token is never a column here — a row an operator reads
--                        must not be able to leak a PAT (M9).
--   2. ConnectorSecret — the AES-256-GCM ciphertext of one token. Its own
--                        table so a query that reads connections for a screen
--                        cannot select the ciphertext by accident. Nothing here
--                        is plaintext; the master key lives in the environment
--                        (`CONNECTOR_MASTER_KEY`), not in the database, so a
--                        dump alone cannot recover a token.
--
-- Hand-written alongside the generated table DDL so the guard CHECKs below have
-- a home — the tri-state `lastTestOk` and the empty-config refusal have no
-- Prisma syntax.

-- ---------------------------------------------------------------------------
-- 1. Connection
-- ---------------------------------------------------------------------------
CREATE TABLE "Connection" (
    "id" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "baseUrl" VARCHAR(2048) NOT NULL,
    "authKind" VARCHAR(16) NOT NULL,
    "configJson" JSONB NOT NULL,
    -- Points at ConnectorSecret.ref; NULL until a token is entered. NEVER the
    -- token. A config-only connection may exist before it has a credential.
    "secretRef" VARCHAR(256),
    -- The last four characters of the stored token, for recognition only. Four
    -- chars is not a secret; the value it belongs to never lives on this table.
    "secretMask" VARCHAR(4),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastTestedAt" TIMESTAMPTZ(3),
    -- Tri-state: NULL = never tested, true/false = the last live test's real
    -- verdict. A default of false would erase the "never checked" state, and a
    -- screen has to tell "not yet checked" from "checked and broken".
    "lastTestOk" BOOLEAN,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- A test result with no timestamp, or a timestamp with no result, is an
-- inconsistency a screen would render as a lie ("tested, but when?" / "checked
-- at 10:00, but ok?"). The two move together or not at all.
ALTER TABLE "Connection"
  ADD CONSTRAINT "Connection_test_pair"
  CHECK (("lastTestedAt" IS NULL) = ("lastTestOk" IS NULL));

-- ---------------------------------------------------------------------------
-- 2. ConnectorSecret
-- ---------------------------------------------------------------------------
CREATE TABLE "ConnectorSecret" (
    "ref" VARCHAR(256) NOT NULL,
    -- Per-secret GCM nonce (base64). Fresh on every write; GCM nonce reuse
    -- under one key is a confidentiality break, so this is never reused.
    "iv" VARCHAR(64) NOT NULL,
    -- The enciphered token (base64). Never the plaintext.
    "ciphertext" TEXT NOT NULL,
    -- The 16-byte GCM auth tag (base64), verified on decrypt: a tampered
    -- ciphertext throws rather than decrypting to garbage.
    "authTag" VARCHAR(64) NOT NULL,
    -- Which key version enciphered this, for a future rotation. `v1` today.
    "keyVersion" VARCHAR(16) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ConnectorSecret_pkey" PRIMARY KEY ("ref")
);
