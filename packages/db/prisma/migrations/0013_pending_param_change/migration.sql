-- Open four-eyes proposals, made durable.
--
-- Until now the pending queue lived in a process-local Map (PrismaParamStore),
-- so a BFF restart discarded every open proposal — a guarded parameter change
-- awaiting its second approver, and (M93) an onboarding binding awaiting an
-- admin's sign-off — forcing the first proposer to start over. This table holds
-- them across restarts.
--
-- Deliberately its OWN table, not a row in ParamVersion: that table's CHECK
-- (migration 0002) refuses a guarded version with no approver, which is exactly
-- what an open proposal IS. There is no FK to Param either — an
-- "onboarding.binding" proposal is not a parameter, it only shares this queue so
-- one admin watches a single list.
--
-- Primary key is (key, scopeRef): at most one open proposal per key and scope,
-- matching the in-memory `slot(key, scopeRef)` it replaces. scopeRef defaults to
-- '' for the global scope (same convention as ParamVersion).

CREATE TABLE "PendingParamChange" (
    "key"        VARCHAR(64) NOT NULL,
    "scopeRef"   VARCHAR(64) NOT NULL DEFAULT '',
    "valueJson"  JSONB       NOT NULL,
    "proposedBy" TEXT        NOT NULL,
    "at"         TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PendingParamChange_pkey" PRIMARY KEY ("key", "scopeRef")
);
