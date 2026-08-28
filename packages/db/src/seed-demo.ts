import type { Prisma, PrismaClient } from "@prisma/client";
import { AUDIT_LOG_ROWS } from "./demo/decisions.js";
import { EVIDENCE_PACKAGES } from "./demo/evidence.js";
import { LLM_CALLS, SUBSCRIPTION_ACCOUNTS, VARIANTS, VARIANT_VERSIONS } from "./demo/gateway.js";
import { JOURNAL } from "./demo/journal.js";
import { DEMO_PARAM_VERSIONS } from "./demo/params.js";
import { APPLICATIONS, KNOWLEDGE_DOCS, REPO_CARDS, USERS } from "./demo/registry.js";
import { BINDINGS, ROUTING_RULES } from "./demo/routing.js";
import { STEP_EVENTS } from "./demo/step-events.js";
import { RUNS } from "./demo/tickets.js";

/**
 * Demo dataset — the mock's data, as rows.
 *
 * Wave 1 requirement (insa-plani.md): the seed *is* the mock dataset, so a
 * fresh install opens Studio already populated (5 applications + repo cards,
 * 4 bound Jira projects + routing rules, 22 tickets in a realistic status
 * spread, journal entries, signed gate decisions and a verifiable audit
 * chain). Nothing is migrated from v1.
 *
 * The data lives in `src/demo/**`; this file only assembles it and writes it.
 */

export interface DemoDataset {
  users: Prisma.UserCreateManyInput[];
  applications: Prisma.ApplicationCreateManyInput[];
  repoCards: Prisma.RepoCardCreateManyInput[];
  bindings: Prisma.JiraProjectBindingCreateManyInput[];
  routingRules: Prisma.RoutingRuleCreateManyInput[];
  runs: Prisma.WorkflowRunCreateManyInput[];
  stepEvents: Prisma.StepEventCreateManyInput[];
  journal: Prisma.JournalEntryCreateManyInput[];
  auditLog: Prisma.AuditLogCreateManyInput[];
  paramVersions: Prisma.ParamVersionCreateManyInput[];
  llmCalls: Prisma.LlmCallCreateManyInput[];
  variants: Prisma.VariantCreateManyInput[];
  variantVersions: Prisma.VariantVersionCreateManyInput[];
  subscriptionAccounts: Prisma.SubscriptionAccountCreateManyInput[];
  knowledgeDocs: Prisma.KnowledgeDocCreateManyInput[];
  evidencePackages: Prisma.EvidencePackageRowCreateManyInput[];
}

/** The complete demo dataset. Pure and deterministic. */
export function buildDemoDataset(): DemoDataset {
  return {
    users: USERS,
    applications: APPLICATIONS,
    repoCards: REPO_CARDS,
    bindings: BINDINGS,
    routingRules: ROUTING_RULES,
    runs: RUNS,
    stepEvents: STEP_EVENTS,
    journal: JOURNAL,
    auditLog: AUDIT_LOG_ROWS,
    paramVersions: DEMO_PARAM_VERSIONS,
    llmCalls: LLM_CALLS,
    variants: VARIANTS,
    variantVersions: VARIANT_VERSIONS,
    subscriptionAccounts: SUBSCRIPTION_ACCOUNTS,
    knowledgeDocs: KNOWLEDGE_DOCS,
    evidencePackages: EVIDENCE_PACKAGES,
  };
}

/** The delegates `seedDemo` writes through. */
export type SeedDemoDelegates = Pick<
  PrismaClient,
  | "user"
  | "application"
  | "repoCard"
  | "jiraProjectBinding"
  | "routingRule"
  | "workflowRun"
  | "stepEvent"
  | "journalEntry"
  | "auditLog"
  | "paramVersion"
  | "llmCall"
  | "variant"
  | "variantVersion"
  | "subscriptionAccount"
  | "knowledgeDoc"
  | "evidencePackageRow"
>;

export type SeedDemoDb = SeedDemoDelegates & Pick<PrismaClient, "$transaction">;

/**
 * Insert the demo dataset in one transaction, in foreign-key order.
 *
 * Two deliberate asymmetries:
 *
 *  · **One transaction.** Sixteen independent `createMany` calls could leave a
 *    half-seeded database behind — runs without their journal, an audit chain
 *    truncated mid-link — and the operator would have no way to tell.
 *  · **`skipDuplicates` for master data, never for the append-only tables.**
 *    Re-running the seed must not stamp on an installation's applications or
 *    users; but a duplicate `AuditLog` or `JournalEntry` row means the chain
 *    is being written twice, and swallowing that quietly is precisely the
 *    fail-open M33 forbids. On a populated database the whole transaction
 *    aborts loudly and nothing is written twice.
 */
export async function seedDemo(db: SeedDemoDb): Promise<Record<string, number>> {
  const data = buildDemoDataset();

  return db.$transaction(async (tx) => {
    const counts: Record<string, number> = {};
    const write = async (
      name: string,
      run: () => Promise<{ count: number }>,
    ): Promise<void> => {
      counts[name] = (await run()).count;
    };

    await write("users", () => tx.user.createMany({ data: data.users, skipDuplicates: true }));
    await write("applications", () => tx.application.createMany({ data: data.applications, skipDuplicates: true }));
    await write("repoCards", () => tx.repoCard.createMany({ data: data.repoCards, skipDuplicates: true }));
    await write("bindings", () => tx.jiraProjectBinding.createMany({ data: data.bindings, skipDuplicates: true }));
    await write("routingRules", () => tx.routingRule.createMany({ data: data.routingRules, skipDuplicates: true }));
    await write("runs", () => tx.workflowRun.createMany({ data: data.runs, skipDuplicates: true }));
    await write("stepEvents", () => tx.stepEvent.createMany({ data: data.stepEvents, skipDuplicates: true }));
    await write("journal", () => tx.journalEntry.createMany({ data: data.journal }));
    await write("evidencePackages", () => tx.evidencePackageRow.createMany({ data: data.evidencePackages, skipDuplicates: true }));
    await write("auditLog", () => tx.auditLog.createMany({ data: data.auditLog }));
    await write("paramVersions", () => tx.paramVersion.createMany({ data: data.paramVersions, skipDuplicates: true }));
    await write("llmCalls", () => tx.llmCall.createMany({ data: data.llmCalls, skipDuplicates: true }));
    await write("variants", () => tx.variant.createMany({ data: data.variants, skipDuplicates: true }));
    await write("variantVersions", () => tx.variantVersion.createMany({ data: data.variantVersions, skipDuplicates: true }));
    await write("subscriptionAccounts", () => tx.subscriptionAccount.createMany({ data: data.subscriptionAccounts, skipDuplicates: true }));
    await write("knowledgeDocs", () => tx.knowledgeDoc.createMany({ data: data.knowledgeDocs, skipDuplicates: true }));

    return counts;
  });
}
