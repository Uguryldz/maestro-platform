/**
 * @maestro/db — the platform's single Prisma surface: schema, migrations,
 * seed, the typed client factory, and the row↔contract mappers. Nothing else
 * in the monorepo imports `@prisma/client` directly.
 */
export { createDb, assertPostgresUrl, InvalidDatabaseUrlError, DB_NULL } from "./client.js";
export type { CreateDbOptions, Db, DbLogLevel, DbNull } from "./client.js";

// Append-only surfaces (M30/M33) — the type-level half of the trigger guard.
export { appendOnly, APPEND_ONLY_METHODS } from "./append-only.js";
export type { AppendOnlyDb, AppendOnlyDelegate, AppendOnlyMethod } from "./append-only.js";

// Row -> contract mappers: the documented BigInt/Decimal/Date conversion point.
export {
  bigIntToNumber,
  decimalToNumber,
  toApplicationRecord,
  toAuditEvent,
  toEvidencePackage,
  toJiraProjectBinding,
  toJournalEntry,
  toLlmCallLog,
  toParamChange,
  toRoutingRule,
  toWorkflowRunState,
  BigIntRangeError,
} from "./mappers.js";
export type {
  ApplicationRow,
  AuditLogRow,
  JiraProjectBindingRow,
  JournalEntryRow,
  LlmCallRow,
  ParamVersionRow,
  RoutingRuleRow,
  WorkflowRunRow,
} from "./mappers.js";

// RoutingRule.projectKey: contract `"*"` <-> stored NULL.
export {
  isOrgWideRule,
  ORG_WIDE_PROJECT_KEY,
  toColumnProjectKey,
  toContractProjectKey,
  InvalidRuleProjectKeyError,
} from "./routing-map.js";

// Parameters (M71).
export {
  DEFAULT_PARAM_DEFINITIONS,
  findParamDefinition,
  GLOBAL_SCOPE_REF,
  SEED_ACTOR,
} from "./params-defaults.js";
export {
  bootstrapParamVersionData,
  writeParamVersion,
  GuardedParamError,
  UnknownParamError,
} from "./params-write.js";
export type { ParamWriteDb, ParamVersionWritten, WriteParamVersionInput } from "./params-write.js";
export { seedParams } from "./seed.js";
export type { SeedParamsOptions, SeedParamsResult } from "./seed.js";

// The first-run bootstrap admin (banking standard): an `admin` account planted
// with a RANDOM, one-time-logged password and forced to change it on first
// login (M8). The generator is exported for the operator reset flow too
// (apps/deploy/src/reset-admin.ts).
export {
  seedFirstAdmin,
  firstAdminDbOf,
  FIRST_ADMIN_USERNAME,
  FIRST_ADMIN_DISPLAY_NAME,
  FIRST_ADMIN_GROUP,
} from "./seed-first-admin.js";
export type {
  PasswordHashFn,
  SeedFirstAdminDb,
  SeedFirstAdminOptions,
  SeedFirstAdminResult,
} from "./seed-first-admin.js";
export { generateBootstrapPassword, BOOTSTRAP_PASSWORD_LENGTH } from "./bootstrap-password.js";
export type { RandomIntFn } from "./bootstrap-password.js";

// The analysis template a fresh install starts with (M108).
export { seedAnalysisTemplate } from "./seed-template.js";
export type { SeedTemplateOptions, SeedTemplateResult } from "./seed-template.js";
export {
  DEFAULT_ANALYSIS_TEMPLATE_NAME,
  DEFAULT_ANALYSIS_TEMPLATE_SECTIONS,
} from "./template-defaults.js";
export type { DefaultTemplateSection } from "./template-defaults.js";

// The default agent variants a fresh install starts with (M38): one per
// thinking role, model bootstrapped from PILOT_MODEL, editable from Studio.
export { seedDefaultVariants } from "./seed-variants.js";
export type {
  SeedVariantsDb,
  SeedVariantsOptions,
  SeedVariantsResult,
} from "./seed-variants.js";
export {
  DEFAULT_VARIANT_MODEL,
  DEFAULT_VARIANTS,
} from "./variant-defaults.js";
export type { DefaultVariant } from "./variant-defaults.js";

// Demo dataset (insa-plani Dalga 1: the seed *is* the mock's data).
export { buildDemoDataset, seedDemo } from "./seed-demo.js";
export { resetRuntimeData, RESET_TABLES } from "./reset.js";
export type { ResetDb } from "./reset.js";
export type { DemoDataset, SeedDemoDb, SeedDemoDelegates } from "./seed-demo.js";
export { ago, DEMO_NOW, demoRunId, ist } from "./demo/clock.js";
export { DEMO_TICKETS } from "./demo/tickets.js";
export type { DemoTicket } from "./demo/tickets.js";
export { DEMO_GATE_INTENTS, gatesOfRun, verifyGateSod } from "./demo/gates.js";
export type { DemoGateIntent } from "./demo/gates.js";
export {
  AUDIT_LOG_ROWS,
  DEMO_AUDIT_EVENTS,
  DEMO_GATE_DECISIONS,
  decisionsOfRun,
  signatureSeqOf,
} from "./demo/decisions.js";
export type { DemoGateDecision } from "./demo/decisions.js";
export { DEMO_PARAM_VERSIONS } from "./demo/params.js";
export { NO_PASSWORD_SET } from "./demo/registry.js";

// Pure schema-text parsers (drift guards used by the test-suite).
export {
  parseDateTimeFields,
  parseEnums,
  parseModels,
  parseNativeTypes,
} from "./schema-facts.js";
export type { SchemaEnum, SchemaModel } from "./schema-facts.js";

/** Package-relative path of the schema — resolved by tooling and tests. */
export const PRISMA_SCHEMA_RELATIVE_PATH = "prisma/schema.prisma";

/** Package-relative paths of the committed migrations, in apply order. */
export const MIGRATION_RELATIVE_PATHS = [
  "prisma/migrations/0001_init/migration.sql",
  "prisma/migrations/0002_append_only_and_guards/migration.sql",
] as const;

/** Package-relative path of the generated initial migration. */
export const INITIAL_MIGRATION_RELATIVE_PATH = MIGRATION_RELATIVE_PATHS[0];

/** Package-relative path of the hand-written guard migration. */
export const GUARDS_MIGRATION_RELATIVE_PATH = MIGRATION_RELATIVE_PATHS[1];
