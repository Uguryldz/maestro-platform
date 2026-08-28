import type { AuditAction } from "@maestro/contracts";
import { ago } from "./clock.js";

/**
 * Audit records that are not derived from another table.
 *
 * Everything that *is* derivable — run start, gate open, gate decision, CI
 * result, merge, closure, parameter change — is generated from the row it
 * describes (see decisions.ts), because two hand-maintained lists always drift.
 * What is left here are the events whose subject lives in no demo table yet:
 * quota windows, PII masking counts, sandbox lifecycle, scan outcomes.
 */
export interface DemoAuditIntent {
  at: Date;
  /** Must satisfy `@maestro/audit`'s actor grammar (`user@corp`, `maestro-*`). */
  actor: string;
  action: AuditAction;
  subject: string;
  meta?: Record<string, unknown>;
}

export const AMBIENT_AUDIT_EVENTS: readonly DemoAuditIntent[] = [
  {
    at: ago(47),
    actor: "ugur.yildiz@ugurbank.local",
    action: "MODE_CHANGED",
    subject: "UGURWEB-95 · human_only",
    meta: { from: "full_auto", to: "human_only", reason: "team is doing this one by hand" },
  },
  {
    at: ago(29),
    actor: "ugur.yildiz@ugurbank.local",
    action: "BINDING_CHANGED",
    subject: "UGURDESK · draft → active",
    meta: { projectKey: "UGURDESK", from: "draft", to: "active", dryRunSampleSize: 20 },
  },
  {
    at: ago(20),
    actor: "maestro-worker",
    action: "CLARIFICATION_ASKED",
    subject: "UGURPAY-712 · 3 soru",
    meta: { ticketKey: "UGURPAY-712", questions: 3 },
  },
  {
    at: ago(12),
    actor: "maestro-worker",
    action: "ASSIGN_APP",
    subject: "UGURMOB-201 · ugurmobil-ios",
    meta: { ticketKey: "UGURMOB-201", appId: "ugurmobil-ios", via: "ai_suggestion", confidence: 0.94, validatedAtGate: true },
  },
  {
    at: ago(8),
    actor: "maestro-worker",
    action: "PR_OPENED",
    subject: "UGURPAY-123 · ADO PR #1836",
    meta: { ticketKey: "UGURPAY-123", prId: 1836 },
  },
  {
    at: ago(5.5),
    actor: "maestro-worker",
    action: "QUOTA_WARN",
    subject: "claude-sub-03 · 5h penceresi %80",
    meta: { accountId: "claude-sub-03", window: "5h", usedPct: 80 },
  },
  {
    at: ago(5.3),
    actor: "maestro-worker",
    action: "PII_MASKED",
    subject: "UGURDESK-52 · 2 alan maskelendi (IBAN, müşteri no)",
    meta: { ticketKey: "UGURDESK-52", fields: 2, kinds: ["iban", "customer_no"] },
  },
  {
    at: ago(0.7),
    actor: "maestro-worker",
    action: "SECURITY_SCAN_PASS",
    subject: "UGURPAY-502 · 0 bulgu",
    meta: { ticketKey: "UGURPAY-502", findings: 0, tools: ["gitleaks", "semgrep", "trivy"] },
  },
  {
    at: ago(0.4),
    actor: "maestro-runner",
    action: "SANDBOX_DESTROY",
    subject: "UGURPAY-123 · lnx-01",
    meta: { ticketKey: "UGURPAY-123", runner: "lnx-01" },
  },
  {
    at: ago(0.15),
    actor: "maestro-worker",
    action: "TEST_RUN_COMPLETE",
    subject: "UGURPAY-123 · coverage %83",
    meta: { ticketKey: "UGURPAY-123", coveragePct: 83, flaky: 0 },
  },
];
