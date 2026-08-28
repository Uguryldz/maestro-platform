-- Listening rules — status/issuetype → flow-type routing (UI-managed).
--
-- Turns Maestro's discovery from a hard-coded, single-project, type-blind JQL
-- (`apps/pilot/src/config.ts` discoveryJql) into rows an admin edits from
-- Studio: "in project X, a ticket assigned to the bot whose <matchKind> is
-- <matchValue> runs as <flowType>". Modelled on RoutingRule (its own table, not
-- a Param, not a contract change).
--
-- Hand-written alongside the generated DDL so the guard CHECKs have a home —
-- `flowType` and `matchKind` are constrained string domains, not Prisma enums,
-- so adding a flow type later needs no enum migration.

CREATE TABLE "ListeningRule" (
    "ruleId"            VARCHAR(64)  NOT NULL,
    "projectKey"        VARCHAR(32)  NOT NULL,
    -- The account a ticket must be assigned to (the Maestro Bot accountId).
    "assigneeAccountId" VARCHAR(128) NOT NULL,
    -- "status" | "issuetype": which ticket field matchValue is compared to.
    "matchKind"         VARCHAR(16)  NOT NULL,
    -- The status name or issue-type name that triggers this rule.
    "matchValue"        VARCHAR(128) NOT NULL,
    -- "analiz" | "duzeltme" | "gelistirme": the flow Maestro runs.
    "flowType"          VARCHAR(16)  NOT NULL,
    "priority"          INTEGER      NOT NULL DEFAULT 100,
    "enabled"           BOOLEAN      NOT NULL DEFAULT true,

    CONSTRAINT "ListeningRule_pkey" PRIMARY KEY ("ruleId")
);

-- matchKind is a closed domain — a typo like "issue-type" must fail at write
-- time, not silently match nothing at discovery.
ALTER TABLE "ListeningRule"
  ADD CONSTRAINT "ListeningRule_matchKind_domain"
  CHECK ("matchKind" IN ('status', 'issuetype'));

-- flowType is a closed domain — the three flows Maestro knows. A new flow type
-- is a deliberate change here, not an accidental free-text value the UI could
-- write and the pilot could not interpret.
ALTER TABLE "ListeningRule"
  ADD CONSTRAINT "ListeningRule_flowType_domain"
  CHECK ("flowType" IN ('analiz', 'duzeltme', 'gelistirme'));

-- One rule per (project, assignee, match target): a trigger maps to exactly one
-- flow. A second rule for the same trigger is a mistake, not an ambiguity the
-- runtime must resolve.
CREATE UNIQUE INDEX "ListeningRule_trigger_key"
  ON "ListeningRule" ("projectKey", "assigneeAccountId", "matchKind", "matchValue");

CREATE INDEX "ListeningRule_projectKey_enabled_idx"
  ON "ListeningRule" ("projectKey", "enabled");
