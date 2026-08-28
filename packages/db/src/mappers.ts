import type {
  ApplicationRecord,
  AuditEvent,
  EvidencePackage,
  JiraProjectBinding,
  JournalEntry,
  LlmCallLog,
  ParamChange,
  RoutingRule,
  WorkflowRunState,
} from "@maestro/contracts";
import { toContractProjectKey } from "./routing-map.js";

/**
 * Row -> contract mappers: the one documented conversion point between the
 * physical model and `@maestro/contracts`.
 *
 * Three column types cannot be handed to a contract as they are:
 *
 *  · **BigInt** (`AuditLog.seq`, `StepEvent.id`, `LlmCall.id`) — Postgres
 *    `bigserial`/`bigint`. The contracts say `z.number().int()`, and BigInt is
 *    not JSON-serialisable, so every BFF response would `TypeError` on it. It
 *    is converted here, and only here, with an explicit range check: a silent
 *    precision loss above 2^53 in an *audit sequence* is exactly the kind of
 *    quiet corruption this platform exists to prevent.
 *  · **Decimal** (`LlmCall.usd`) — money is stored as `numeric(12,6)`, never a
 *    float (M55). `.toNumber()` happens here.
 *  · **Date** — the contracts carry offset-aware ISO strings (M33/M56), the
 *    driver hands back `Date`. `.toISOString()` happens here.
 *
 * These functions do not parse with zod: they are the *producers* of contract
 * shapes, and the callers that need validation run the schema themselves (the
 * test-suite does exactly that for every mapper).
 */

export class BigIntRangeError extends Error {
  constructor(field: string, value: bigint) {
    super(`${field} = ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be a contract number`);
    this.name = "BigIntRangeError";
  }
}

/** BigInt column -> contract `number`, refusing values that would lose precision. */
export function bigIntToNumber(field: string, value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new BigIntRangeError(field, value);
  }
  return Number(value);
}

/** Prisma `Decimal | null` -> contract `number | null`. */
export function decimalToNumber(value: { toNumber(): number } | null | undefined): number | null {
  return value === null || value === undefined ? null : value.toNumber();
}

type Json = unknown;

export interface AuditLogRow {
  seq: bigint;
  at: Date;
  actor: string;
  action: AuditEvent["action"];
  subject: string;
  prevHash: string;
  hash: string;
  metaJson: Json;
}

/** `AuditLog` row -> `AuditEvent`, the shape `@maestro/audit` verifies. */
export function toAuditEvent(row: AuditLogRow): AuditEvent {
  return {
    seq: bigIntToNumber("AuditLog.seq", row.seq),
    at: row.at.toISOString(),
    actor: row.actor,
    action: row.action,
    subject: row.subject,
    prevHash: row.prevHash,
    hash: row.hash,
    meta: (row.metaJson ?? {}) as Record<string, unknown>,
  };
}

export interface LlmCallRow {
  at: Date;
  runId: string | null;
  role: LlmCallLog["role"];
  variantId: string;
  driver: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachePct: number | null;
  usd: { toNumber(): number } | null;
  dataClass: LlmCallLog["dataClass"];
}

/** `LlmCall` row -> `LlmCallLog`; this is where `Decimal` becomes `number`. */
export function toLlmCallLog(row: LlmCallRow): LlmCallLog {
  return {
    at: row.at.toISOString(),
    runId: row.runId,
    role: row.role,
    variantId: row.variantId,
    driver: row.driver as LlmCallLog["driver"],
    model: row.model,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    cachePct: row.cachePct,
    usd: decimalToNumber(row.usd),
    dataClass: row.dataClass,
  };
}

export interface JournalEntryRow {
  runId: string;
  seq: number;
  at: Date;
  actor: JournalEntry["actor"];
  kind: JournalEntry["kind"];
  title: string;
  detail: string;
  costJson: Json;
}

export function toJournalEntry(row: JournalEntryRow): JournalEntry {
  const cost = row.costJson as JournalEntry["cost"] | null | undefined;
  return {
    runId: row.runId,
    seq: row.seq,
    at: row.at.toISOString(),
    actor: row.actor,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    ...(cost === null || cost === undefined ? {} : { cost }),
  };
}

export interface WorkflowRunRow {
  id: string;
  ticketKey: string;
  step: string;
  status: WorkflowRunState["status"];
  risk: WorkflowRunState["risk"] | null;
  startedAt: Date;
  updatedAt: Date;
}

export function toWorkflowRunState(row: WorkflowRunRow): WorkflowRunState {
  return {
    runId: row.id,
    ticketKey: row.ticketKey,
    step: row.step as WorkflowRunState["step"],
    status: row.status,
    ...(row.risk === null ? {} : { risk: row.risk }),
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ParamVersionRow {
  key: string;
  scopeRef: string;
  version: number;
  valueJson: Json;
  changedBy: string;
  approvedBy: string | null;
  at: Date;
}

/** `ParamVersion` row -> `ParamChange`; `""` scopeRef becomes contract `null`. */
export function toParamChange(row: ParamVersionRow): ParamChange {
  return {
    key: row.key,
    scopeRef: row.scopeRef === "" ? null : row.scopeRef,
    value: row.valueJson,
    version: row.version,
    changedBy: row.changedBy,
    approvedBy: row.approvedBy,
    at: row.at.toISOString(),
  };
}

export interface RoutingRuleRow {
  ruleId: string;
  projectKey: string | null;
  conditionJson: Json;
  effectJson: Json;
  priority: number;
}

/** `RoutingRule` row -> contract rule; `NULL` projectKey becomes `"*"`. */
export function toRoutingRule(row: RoutingRuleRow): RoutingRule {
  return {
    ruleId: row.ruleId,
    projectKey: toContractProjectKey(row.projectKey),
    condition: row.conditionJson as RoutingRule["condition"],
    priority: row.priority,
    effect: row.effectJson as RoutingRule["effect"],
  };
}

export interface JiraProjectBindingRow {
  projectKey: string;
  trigger: JiraProjectBinding["trigger"];
  triggerLabel: string;
  defaultsJson: Json;
  state: JiraProjectBinding["state"];
  dryRunSampleSize: number;
  lastDryRunAt: Date | null;
  version: number;
}

/**
 * `JiraProjectBinding` row + its rules -> contract binding.
 *
 * `ruleIds` is an *ordered* array in the contract, and order is what decides
 * which rule wins. There is no array column: the order is `RoutingRule.priority`
 * ascending (ties broken by ruleId, so the result is total). Org-wide rules
 * (`projectKey IS NULL`) apply to every binding and are folded in here, which is
 * the only place that knows both halves.
 */
export function toJiraProjectBinding(
  row: JiraProjectBindingRow,
  rules: readonly RoutingRuleRow[],
): JiraProjectBinding {
  const applicable = rules
    .filter((rule) => rule.projectKey === null || rule.projectKey === row.projectKey)
    .sort((a, b) => a.priority - b.priority || a.ruleId.localeCompare(b.ruleId));

  return {
    projectKey: row.projectKey,
    trigger: row.trigger,
    triggerLabel: row.triggerLabel,
    ruleIds: applicable.map((rule) => rule.ruleId),
    defaults: row.defaultsJson as JiraProjectBinding["defaults"],
    state: row.state,
    dryRunSampleSize: row.dryRunSampleSize,
    lastDryRunAt: row.lastDryRunAt === null ? null : row.lastDryRunAt.toISOString(),
    version: row.version,
  };
}

export interface ApplicationRow {
  appId: string;
  displayName: string;
  adoProject: string;
  adoRepo: string;
  platform: string;
  jiraComponent: string | null;
  maestroYamlPresent: boolean;
  createdVia: ApplicationRecord["createdVia"];
}

export function toApplicationRecord(row: ApplicationRow): ApplicationRecord {
  return {
    appId: row.appId,
    displayName: row.displayName,
    adoProject: row.adoProject,
    adoRepo: row.adoRepo,
    platform: row.platform as ApplicationRecord["platform"],
    jiraComponent: row.jiraComponent,
    maestroYamlPresent: row.maestroYamlPresent,
    createdVia: row.createdVia,
  };
}

export interface EvidencePackageRowShape {
  manifestJson: Json;
}

/** The manifest is stored verbatim, so the mapper is a documented cast. */
export function toEvidencePackage(row: EvidencePackageRowShape): EvidencePackage {
  return row.manifestJson as EvidencePackage;
}
