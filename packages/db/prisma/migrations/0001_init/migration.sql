-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('running', 'gate', 'queued', 'fail', 'handover', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "WorkModeE" AS ENUM ('full_auto', 'ai_assist', 'human_lead', 'human_only');

-- CreateEnum
CREATE TYPE "RiskTierE" AS ENUM ('dusuk', 'orta', 'kritik');

-- CreateEnum
CREATE TYPE "DataClassE" AS ENUM ('acik', 'dahili', 'gizli');

-- CreateEnum
CREATE TYPE "BindingStateE" AS ENUM ('draft', 'dry_run', 'active', 'paused', 'unbound');

-- CreateEnum
CREATE TYPE "TriggerModeE" AS ENUM ('auto', 'label', 'command');

-- CreateEnum
CREATE TYPE "ParamScopeE" AS ENUM ('global', 'project', 'application');

-- CreateEnum
CREATE TYPE "ParamTypeE" AS ENUM ('string', 'number', 'boolean', 'enum', 'json');

-- CreateEnum
CREATE TYPE "JournalActorE" AS ENUM ('ai', 'human', 'system');

-- CreateEnum
CREATE TYPE "JournalKindE" AS ENUM ('intake', 'clarification', 'discovery', 'analysis', 'gate', 'engineering', 'scan', 'review', 'test_design', 'test_review', 'test_run', 'ci', 'pr', 'handover', 'pii', 'quota', 'closure', 'other');

-- CreateEnum
CREATE TYPE "AuditActionE" AS ENUM ('RUN_STARTED', 'GATE_OPEN', 'GATE_APPROVE', 'GATE_REJECT', 'CLARIFICATION_ASKED', 'CLARIFICATION_ANSWERED', 'PII_MASKED', 'SECURITY_SCAN_PASS', 'SECURITY_SCAN_FAIL', 'SANDBOX_CREATE', 'SANDBOX_DESTROY', 'TEST_RUN_COMPLETE', 'CI_RESULT', 'PR_OPENED', 'PR_MERGED', 'MODE_CHANGED', 'HANDOVER', 'ASSIGN_APP', 'PARAM_CHANGED', 'BINDING_CHANGED', 'KILL_SWITCH', 'QUOTA_WARN', 'RETENTION_ARCHIVE', 'RESTORE_DRILL', 'RUN_CLOSED');

-- CreateEnum
CREATE TYPE "LlmRoleE" AS ENUM ('intake', 'analyst', 'engineer', 'dev_reviewer', 'test_designer', 'test_reviewer', 'test_engineer');

-- CreateEnum
CREATE TYPE "SubscriptionStateE" AS ENUM ('ready', 'cooling', 'exhausted', 'disabled');

-- CreateEnum
CREATE TYPE "StepKindE" AS ENUM ('system', 'ai', 'human_gate', 'human_wait', 'auto_gate');

-- CreateEnum
CREATE TYPE "CreatedViaE" AS ENUM ('onboarding', 'import');

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" VARCHAR(128) NOT NULL,
    "ticketKey" VARCHAR(64) NOT NULL,
    "appId" VARCHAR(64),
    "mode" "WorkModeE" NOT NULL,
    "risk" "RiskTierE",
    "dataClass" "DataClassE" NOT NULL,
    "step" VARCHAR(8) NOT NULL,
    "status" "RunStatus" NOT NULL,
    "matchJson" JSONB,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepEvent" (
    "id" BIGSERIAL NOT NULL,
    "runId" VARCHAR(128) NOT NULL,
    "step" VARCHAR(8) NOT NULL,
    "kind" "StepKindE" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "dataJson" JSONB,

    CONSTRAINT "StepEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "runId" VARCHAR(128) NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "actor" "JournalActorE" NOT NULL,
    "kind" "JournalKindE" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "costJson" JSONB,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("runId","seq")
);

-- CreateTable
CREATE TABLE "Application" (
    "appId" VARCHAR(64) NOT NULL,
    "displayName" TEXT NOT NULL,
    "adoProject" TEXT NOT NULL,
    "adoRepo" TEXT NOT NULL,
    "platform" VARCHAR(32) NOT NULL,
    "jiraComponent" VARCHAR(128),
    "maestroYamlPresent" BOOLEAN NOT NULL DEFAULT false,
    "createdVia" "CreatedViaE" NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("appId")
);

-- CreateTable
CREATE TABLE "RepoCard" (
    "appId" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL,
    "modulesJson" JSONB NOT NULL,
    "generatedFromSha" VARCHAR(40) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RepoCard_pkey" PRIMARY KEY ("appId","version")
);

-- CreateTable
CREATE TABLE "JiraProjectBinding" (
    "projectKey" VARCHAR(32) NOT NULL,
    "trigger" "TriggerModeE" NOT NULL,
    "triggerLabel" VARCHAR(64) NOT NULL DEFAULT 'maestro',
    "defaultsJson" JSONB NOT NULL,
    "state" "BindingStateE" NOT NULL,
    "dryRunSampleSize" INTEGER NOT NULL DEFAULT 20,
    "lastDryRunAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "JiraProjectBinding_pkey" PRIMARY KEY ("projectKey")
);

-- CreateTable
CREATE TABLE "RoutingRule" (
    "ruleId" VARCHAR(64) NOT NULL,
    "projectKey" VARCHAR(32),
    "conditionJson" JSONB NOT NULL,
    "effectJson" JSONB NOT NULL,
    "priority" INTEGER NOT NULL,

    CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("ruleId")
);

-- CreateTable
CREATE TABLE "Param" (
    "key" VARCHAR(64) NOT NULL,
    "scope" "ParamScopeE" NOT NULL,
    "type" "ParamTypeE" NOT NULL,
    "guarded" BOOLEAN NOT NULL,
    "defJson" JSONB NOT NULL,

    CONSTRAINT "Param_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ParamVersion" (
    "key" VARCHAR(64) NOT NULL,
    "scopeRef" VARCHAR(64) NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "valueJson" JSONB NOT NULL,
    "guarded" BOOLEAN NOT NULL,
    "changedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ParamVersion_pkey" PRIMARY KEY ("key","scopeRef","version")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "seq" BIGINT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "actor" TEXT NOT NULL,
    "action" "AuditActionE" NOT NULL,
    "subject" VARCHAR(128) NOT NULL,
    "prevHash" VARCHAR(64) NOT NULL,
    "hash" VARCHAR(64) NOT NULL,
    "metaJson" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "runId" VARCHAR(128),
    "role" "LlmRoleE" NOT NULL,
    "variantId" VARCHAR(64) NOT NULL,
    "driver" VARCHAR(32) NOT NULL,
    "model" VARCHAR(128) NOT NULL,
    "tokensIn" INTEGER NOT NULL,
    "tokensOut" INTEGER NOT NULL,
    "cachePct" DOUBLE PRECISION,
    "usd" DECIMAL(12,6),
    "dataClass" "DataClassE" NOT NULL,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionAccount" (
    "accountId" VARCHAR(64) NOT NULL,
    "driver" VARCHAR(32) NOT NULL,
    "state" "SubscriptionStateE" NOT NULL,
    "windowsJson" JSONB NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SubscriptionAccount_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" VARCHAR(64) NOT NULL,
    "role" "LlmRoleE" NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantVersion" (
    "variantId" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL,
    "model" VARCHAR(128) NOT NULL,
    "configJson" JSONB NOT NULL,
    "evalScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VariantVersion_pkey" PRIMARY KEY ("variantId","version")
);

-- CreateTable
CREATE TABLE "KnowledgeDoc" (
    "id" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "title" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentRef" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "KnowledgeDoc_pkey" PRIMARY KEY ("id","version")
);

-- CreateTable
CREATE TABLE "EvidencePackageRow" (
    "runId" VARCHAR(128) NOT NULL,
    "ticketKey" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "manifestJson" JSONB NOT NULL,
    "storageKey" TEXT NOT NULL,

    CONSTRAINT "EvidencePackageRow_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "User" (
    "id" VARCHAR(64) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "groupsJson" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowRun_status_idx" ON "WorkflowRun"("status");

-- CreateIndex
CREATE INDEX "WorkflowRun_appId_status_idx" ON "WorkflowRun"("appId", "status");

-- CreateIndex
CREATE INDEX "WorkflowRun_updatedAt_idx" ON "WorkflowRun"("updatedAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_ticketKey_idx" ON "WorkflowRun"("ticketKey");

-- CreateIndex
CREATE INDEX "StepEvent_runId_at_idx" ON "StepEvent"("runId", "at");

-- CreateIndex
CREATE INDEX "RoutingRule_projectKey_priority_idx" ON "RoutingRule"("projectKey", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_prevHash_key" ON "AuditLog"("prevHash");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_hash_key" ON "AuditLog"("hash");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_subject_idx" ON "AuditLog"("subject");

-- CreateIndex
CREATE INDEX "LlmCall_runId_idx" ON "LlmCall"("runId");

-- CreateIndex
CREATE INDEX "LlmCall_at_idx" ON "LlmCall"("at");

-- CreateIndex
CREATE INDEX "LlmCall_driver_at_idx" ON "LlmCall"("driver", "at");

-- CreateIndex
CREATE INDEX "SubscriptionAccount_driver_state_idx" ON "SubscriptionAccount"("driver", "state");

-- CreateIndex
CREATE INDEX "KnowledgeDoc_kind_idx" ON "KnowledgeDoc"("kind");

-- CreateIndex
CREATE INDEX "EvidencePackageRow_createdAt_idx" ON "EvidencePackageRow"("createdAt");

-- CreateIndex
CREATE INDEX "EvidencePackageRow_ticketKey_idx" ON "EvidencePackageRow"("ticketKey");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Application"("appId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepEvent" ADD CONSTRAINT "StepEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepoCard" ADD CONSTRAINT "RepoCard_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Application"("appId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParamVersion" ADD CONSTRAINT "ParamVersion_key_fkey" FOREIGN KEY ("key") REFERENCES "Param"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantVersion" ADD CONSTRAINT "VariantVersion_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
