-- HAND-WRITTEN MIGRATION.
--
-- "Bota atanan her ticket": a listening rule may now trigger on the ASSIGNMENT
-- alone, with no second condition. `matchKind` gains a third member,
-- `assigned`, beside the `status` and `issuetype` the 0011 CHECK has allowed
-- since the table was created.
--
-- WHY IT EXISTS. Until now every rule had to name an issue type or a status,
-- which forced an operator to answer a question they often do not have an
-- answer to. The way this bank actually works is simpler and was unsayable:
-- "whatever the ticket is, if a human hands it to the Maestro bot, work it."
-- The wizard's third step made that gap concrete — it presents two choices and
-- neither of them is the one most first-time operators want, so they picked a
-- type at random and then wondered why half their tickets were ignored.
--
-- WHY A THIRD matchKind AND NOT A WILDCARD matchValue. A sentinel value
-- (`matchValue = '*'`) was the smaller diff and is the wrong shape. The row
-- would still claim `matchKind = 'issuetype'`, i.e. it would say it matches an
-- issue type while matching none, and every reader — `flow-decision.ts`, the
-- pilot's own `ruleFor`, the Studio table, the help screen — would need the
-- same special case anyway, only with the value column now carrying a meaning
-- the column comment denies. Worse, `*` is a legal Jira status name: a project
-- that ever creates one gets a rule that silently means something else. A named
-- kind says what it is, and the CHECK below is what keeps the domain closed.
--
-- `matchValue` STAYS NOT NULL and keeps its `min(1)` shape on the write path.
-- An `assigned` rule stores the fixed literal `*` — not as a wildcard anyone
-- interprets, but because the UNIQUE index on
-- (projectKey, assigneeAccountId, matchKind, matchValue) is what makes "one
-- 'any assigned ticket' rule per (project, bot)" a database fact rather than a
-- convention the UI is trusted to keep. Making the column nullable would take
-- that guarantee away, because NULLs do not collide in a Postgres unique index
-- and a project could accumulate a hundred identical catch-all rules.
--
-- ADDITIVE AND SAFE ON A LIVE TABLE. No existing row is touched: every one of
-- them already satisfies the wider domain, so the constraint swap validates
-- without rewriting the table and without a backfill. The DROP/ADD pair is the
-- only way to widen a CHECK in Postgres; it takes an ACCESS EXCLUSIVE lock for
-- the duration of the validation scan, which on this table (tens of rows, a
-- projected ceiling in the thousands) is milliseconds. There is no window in
-- which the column is unconstrained that a concurrent writer could exploit,
-- because both statements run in the one implicit transaction of this file.
--
-- REVERSIBLE. The down direction is the same pair with the original two-member
-- list — but only after any `assigned` rows are re-pointed or deleted, which is
-- the honest cost of a widened domain and is stated here rather than discovered
-- during a rollback.
--
-- `IF EXISTS` / re-runnable by construction: migrations 0008-0016 were
-- half-applied on this deployment historically, so a migration here must be
-- safe to re-apply against a database that already has the new constraint.
-- Dropping a constraint that is not there is a no-op rather than a failure that
-- blocks every later migration.

ALTER TABLE "ListeningRule"
  DROP CONSTRAINT IF EXISTS "ListeningRule_matchKind_domain";

ALTER TABLE "ListeningRule"
  ADD CONSTRAINT "ListeningRule_matchKind_domain"
  CHECK ("matchKind" IN ('status', 'issuetype', 'assigned'));

COMMENT ON COLUMN "ListeningRule"."matchKind" IS
  'Which ticket field matchValue is compared to: "status" | "issuetype", or "assigned" for a rule that triggers on the assignment alone (matchValue is then the fixed literal ''*'', carried only so the unique trigger index keeps one such rule per project+bot).';
