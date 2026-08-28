import type { AuditAction } from "@maestro/contracts";

/**
 * Per-action SIEM metadata (M33). The table is a `Record<AuditAction, …>`, so a
 * new action in `packages/contracts` breaks this file at compile time instead of
 * quietly reaching Splunk/QRadar as an unclassified event.
 *
 * `severity` is the CEF 0-10 scale: 0-3 low, 4-6 medium, 7-8 high, 9-10 very
 * high. Names and categories are English on purpose — SIEM content is operator
 * infrastructure, not user-facing text, so M104's catalogue does not apply and
 * M59 keeps them English.
 */
export interface AuditActionInfo {
  /** CEF severity, 0-10. */
  readonly severity: number;
  /** Human-readable event name (CEF header `name`). */
  readonly name: string;
  /** Coarse grouping for SIEM dashboards (CEF `cat`). */
  readonly category: "run" | "gate" | "security" | "sandbox" | "delivery" | "governance" | "retention";
  /** Set where the action itself states an outcome (CEF `outcome`). */
  readonly outcome?: "success" | "failure";
  /**
   * True where only a human may be recorded as the actor: an approval written
   * by `ai-via:<user>` would defeat SoD (M32) and M101's "no gate tool" rule.
   */
  readonly humanOnly?: true;
}

export const AUDIT_ACTION_INFO: Record<AuditAction, AuditActionInfo> = {
  RUN_STARTED: { severity: 3, name: "Workflow run started", category: "run" },
  GATE_OPEN: { severity: 4, name: "Approval gate opened", category: "gate" },
  GATE_APPROVE: { severity: 5, name: "Approval gate approved", category: "gate", outcome: "success", humanOnly: true },
  GATE_REJECT: { severity: 6, name: "Approval gate rejected", category: "gate", outcome: "failure", humanOnly: true },
  CLARIFICATION_ASKED: { severity: 3, name: "Clarification requested", category: "run" },
  CLARIFICATION_ANSWERED: { severity: 3, name: "Clarification answered", category: "run" },
  PII_MASKED: { severity: 4, name: "Personal data masked before egress", category: "security" },
  SECURITY_SCAN_PASS: { severity: 3, name: "Security scan passed", category: "security", outcome: "success" },
  SECURITY_SCAN_FAIL: { severity: 8, name: "Security scan failed", category: "security", outcome: "failure" },
  SANDBOX_CREATE: { severity: 3, name: "Sandbox created", category: "sandbox" },
  SANDBOX_DESTROY: { severity: 3, name: "Sandbox destroyed", category: "sandbox" },
  TEST_RUN_COMPLETE: { severity: 3, name: "Test run completed", category: "delivery" },
  CI_RESULT: { severity: 4, name: "CI pipeline result recorded", category: "delivery" },
  PR_OPENED: { severity: 4, name: "Pull request opened", category: "delivery" },
  PR_MERGED: { severity: 6, name: "Pull request merged", category: "delivery" },
  MODE_CHANGED: { severity: 6, name: "Work mode changed", category: "governance" },
  HANDOVER: { severity: 5, name: "Work handed over", category: "governance" },
  ASSIGN_APP: { severity: 4, name: "Ticket assigned to application", category: "governance" },
  PARAM_CHANGED: { severity: 7, name: "Operational parameter changed", category: "governance" },
  BINDING_CHANGED: { severity: 7, name: "Project binding changed", category: "governance" },
  KILL_SWITCH: { severity: 10, name: "Kill switch operated", category: "governance" },
  // M101: an MCP tool ran with a user's token. Severity 4 because the actor is
  // "ai-via:<user>" — a human authorised it, but a machine performed it.
  MCP_TOOL_CALL: { severity: 4, name: "MCP tool invoked on a user's behalf", category: "governance" },
  QUOTA_WARN: { severity: 5, name: "LLM quota threshold reached", category: "governance" },
  RETENTION_ARCHIVE: { severity: 3, name: "Records archived for retention", category: "retention" },
  RESTORE_DRILL: { severity: 4, name: "Restore drill executed", category: "retention" },
  RUN_CLOSED: { severity: 3, name: "Workflow run closed", category: "run" },
};

export function actionInfo(action: AuditAction): AuditActionInfo {
  return AUDIT_ACTION_INFO[action];
}
