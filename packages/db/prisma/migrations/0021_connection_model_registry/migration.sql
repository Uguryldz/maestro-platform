-- HAND-WRITTEN MIGRATION.
--
-- "Modeli panelden bağla": a model server's ADDRESS, MODEL NAME and ON-PREM
-- standing become row facts an admin edits, instead of `LLM_BASE_URL`,
-- `LLM_MODEL` and `LLM_ON_PREM` read out of `.env` at boot. `Connection` gains
-- `onPrem` and `isDefault`; the address, the credential and the model id it
-- already carried.
--
-- WHY IT EXISTS. The panel has collected all three of these since the
-- `openai_compat` kind was added: the operator typed an address, typed a model
-- name, pressed Test, watched `/v1/models` go green — and every run then dialled
-- whatever `.env` said, because `llmConfig` read those variables synchronously
-- while composing the port. The screen even said so out loud
-- (`connections.onprem.env_note`), which is the tell: a form that has to warn
-- you it will ignore what you typed is not a form. This is the third report of
-- the same complaint, and the two earlier rounds each moved only the API key.
--
-- WHY `Connection` AND NOT A NEW `AIModel` TABLE. A separate table was the
-- obvious mirror of the reference product and it is the wrong shape HERE,
-- because four of the columns it would need already exist on this one and carry
-- exactly the right meanings: `baseUrl` (the endpoint), `secretRef`/`secretMask`
-- (the credential, already enciphered in `ConnectorSecret` under
-- `CONNECTOR_MASTER_KEY`), `enabled`, and the `lastTestedAt`/`lastTestOk`/
-- `lastTestNote` trio that records a LIVE verdict. The model id is already
-- round-tripped in `configJson.model` and is already what `modelServedNote`
-- checks the server's catalogue against. A parallel table would duplicate all
-- of that, need a second encrypted-secret path, a second test button, a second
-- audit subject — and would split "where does this install connect to" across
-- two screens, which is the thing the connections panel was built to end.
--
-- So the registry is the connections table, and a "model" is a connection whose
-- kind speaks an inference protocol. What was genuinely missing is only the two
-- columns below: which model answers by default, and whether it is inside the
-- building.
--
-- WHY `onPrem` IS A COLUMN AND NOT DERIVED FROM THE URL. Deriving it was
-- considered and refused. An RFC1918 address is evidence about routing, not a
-- claim about custody: a private IP can be a tunnel to a vendor, and a public
-- hostname can resolve to a rack in the basement. M18 makes this flag the ONLY
-- thing standing between the confidential class and an outside endpoint, so it
-- has to be something an operator ASSERTS and an auditor can read, not something
-- a regex inferred. It defaults to false so an unanswered question fails closed.
--
-- WHY A PARTIAL UNIQUE INDEX FOR THE DEFAULT. `isDefault` alone would let two
-- enabled model rows both claim it, and the resolver would then return whichever
-- row id ordering surfaced first — an install whose answering model depends on a
-- query plan. The index makes "at most one default" a database fact. It is
-- PARTIAL (`WHERE "isDefault"`) because Postgres treats every `false` as
-- distinct only under a full unique index, which would instead forbid a second
-- NON-default row; the predicate constrains exactly the one case that matters
-- and leaves the rest of the table alone.
--
-- ADDITIVE AND SAFE ON A LIVE TABLE. Both columns are `NOT NULL DEFAULT false`,
-- which on Postgres 11+ is a catalogue-only change: no table rewrite, no
-- backfill, no long lock, on a table that holds a handful of rows in any case.
-- Every existing connection keeps working untouched — a Jira or GitHub row
-- simply carries two flags it has no use for, exactly as it already carries a
-- `configJson` whose keys differ by kind.
--
-- NO EXISTING INSTALL IS MIGRATED AUTOMATICALLY, AND THAT IS DELIBERATE. This
-- migration does NOT invent a model connection out of the current `LLM_BASE_URL`
-- / `LLM_MODEL`, because SQL cannot see the process environment and a migration
-- that guessed would write a row nobody tested. A stack that still names those
-- variables keeps running on them unchanged — the runtime falls back to the
-- static config whenever no row claims the default — so this is safe to apply
-- to a live deployment before anyone opens the panel. The one manual step, when
-- an operator wants the panel to own it, is to add the connection and press
-- Test; that is the step that proves the endpoint before it serves a run, which
-- an automatic seed would have skipped.
--
-- REVERSIBLE. The down direction drops the index and the two columns; nothing
-- else refers to them, and an install that reverts falls back to the `.env`
-- values it never stopped being able to read.
--
-- `IF NOT EXISTS` / re-runnable by construction: migrations 0008-0016 were
-- half-applied on this deployment historically, so a migration here must be safe
-- to re-apply against a database that already has these columns.

ALTER TABLE "Connection"
  ADD COLUMN IF NOT EXISTS "onPrem" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Connection"
  ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- At most one row may be the default model. Partial, so it constrains only the
-- rows that claim it — see the note above on why a full unique index is wrong.
CREATE UNIQUE INDEX IF NOT EXISTS "Connection_one_default_model"
  ON "Connection" ("isDefault")
  WHERE "isDefault";

COMMENT ON COLUMN "Connection"."onPrem" IS
  'Whether this endpoint runs inside the institution. The M18 confidential rule leans on this and nothing else — never on a guess made from the URL. Defaults false so an unanswered question fails closed and "gizli" work degrades rather than leaving the premises.';

COMMENT ON COLUMN "Connection"."isDefault" IS
  'The model this install dials when a run does not name one. At most one row may hold it (partial unique index Connection_one_default_model), so the answering model is never decided by row order.';
