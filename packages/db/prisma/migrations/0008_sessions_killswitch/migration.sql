-- Durable sessions and a durable kill switch (Dalga E — prod hardening).
--
-- Two stores in the BFF were still process-local, and the composition root's
-- `assertStoresDurable` refused a prod boot because of the second:
--
--   1. Session    — a restart signed every logged-in user out at once. Not a
--                   data loss, but a support storm on every redeploy of a
--                   process that runs under `restart: unless-stopped`.
--   2. KillSwitch — a restart RELEASED the emergency brake (M58) silently. An
--                   operator sets `all` during an incident, the container
--                   restarts, and the write paths are open again with nobody
--                   told. "The platform is stopped" was a belief, not a fact.
--
-- Hand-written rather than generated for the same reason as 0002 and the
-- table migrations after it: the two guards below (the single-row CHECK, the
-- level CHECK) have no Prisma syntax, and `0001_init` is generated from an
-- empty schema and never edited by hand.

-- ---------------------------------------------------------------------------
-- 1. Session
-- ---------------------------------------------------------------------------
-- The token is the whole credential and the primary key: a lookup is one
-- indexed read, and two logins can never write the same row. `rolesJson` and
-- `groupsJson` freeze what the token was granted at issue time — a role change
-- re-issues rather than mutates, so what the guard reads back is what was
-- granted, not what the account happens to hold now.
CREATE TABLE "Session" (
    "token" VARCHAR(128) NOT NULL,
    "userId" VARCHAR(128) NOT NULL,
    "username" TEXT NOT NULL,
    "rolesJson" JSONB NOT NULL,
    "groupsJson" JSONB NOT NULL,
    "delegated" BOOLEAN NOT NULL DEFAULT false,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("token")
);

-- Logout and off-boarding act on every session an ACCOUNT holds, not on the
-- one token that made the request — a stolen token will not log itself out
-- (M8/M32). Without this index that is a full scan on every logout.
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- The TTL sweep drops rows whose `expiresAt` has passed. Indexed so the sweep
-- is a range scan rather than a walk of every live and dead session.
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- A session that expires before it was issued is a clock or a caller bug, and
-- it would read as already-dead the instant it was written. The issuer sets
-- both from one `now()`; this only fires on a client that wrote them apart.
ALTER TABLE "Session"
  ADD CONSTRAINT "Session_expiry_after_issue" CHECK ("expiresAt" > "issuedAt");

-- ---------------------------------------------------------------------------
-- 2. KillSwitch
-- ---------------------------------------------------------------------------
-- One brake, one row. `id` is a fixed sentinel and the CHECK below refuses any
-- other value, so "the kill switch" is a point lookup and never "the newest of
-- several" — a state that a clock skew between two writers could otherwise
-- answer wrong at the exact moment it must be answered right.
CREATE TABLE "KillSwitch" (
    "id" VARCHAR(8) NOT NULL,
    "level" VARCHAR(16) NOT NULL,
    "actor" VARCHAR(128) NOT NULL,
    "reason" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "KillSwitch_pkey" PRIMARY KEY ("id")
);

-- Exactly one row, forever. Without this a second INSERT would create a second
-- brake, and `get()` would have to choose between them — the ambiguity this
-- table exists to remove. The application only ever UPSERTs the sentinel id.
ALTER TABLE "KillSwitch"
  ADD CONSTRAINT "KillSwitch_single_row" CHECK ("id" = 'ONLY');

-- `level` is the KillSwitchLevel union (M58). The store maps it, but a psql
-- session or a bad restore must not be able to set the brake to a level the
-- platform cannot read — which would fail OPEN, the one direction a brake must
-- never fail. The database agrees with the contract here.
ALTER TABLE "KillSwitch"
  ADD CONSTRAINT "KillSwitch_level_valid" CHECK ("level" IN ('off', 'intake_only', 'all'));
