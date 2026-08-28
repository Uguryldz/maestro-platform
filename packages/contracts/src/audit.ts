import { z } from "zod";
import { IsoDateTime, NonEmpty, Sha256Hex } from "./common.js";

export const AuditAction = z.enum([
  "RUN_STARTED",
  "GATE_OPEN",
  "GATE_APPROVE",
  "GATE_REJECT",
  "CLARIFICATION_ASKED",
  "CLARIFICATION_ANSWERED",
  "PII_MASKED",
  "SECURITY_SCAN_PASS",
  "SECURITY_SCAN_FAIL",
  "SANDBOX_CREATE",
  "SANDBOX_DESTROY",
  "TEST_RUN_COMPLETE",
  "CI_RESULT",
  "PR_OPENED",
  "PR_MERGED",
  "MODE_CHANGED",
  "HANDOVER",
  "ASSIGN_APP",
  "PARAM_CHANGED",
  "BINDING_CHANGED",
  "KILL_SWITCH",
  /** An MCP tool ran on a user's behalf (M101) — actor is `ai-via:<user>`. */
  "MCP_TOOL_CALL",
  "QUOTA_WARN",
  "RETENTION_ARCHIVE",
  "RESTORE_DRILL",
  "RUN_CLOSED",
]);
export type AuditAction = z.infer<typeof AuditAction>;

/**
 * Hash-chained audit event (M33). Actor conventions:
 * "user@corp" (human) · "maestro-worker" / "maestro-runner" (system)
 * · "ai-via:<user>" (AI acting with a user's token — M101).
 * The chain implementation lives in packages/audit; this is the record shape.
 */
export const AuditEvent = z.object({
  seq: z.number().int().positive(),
  at: IsoDateTime,
  actor: NonEmpty,
  action: AuditAction,
  subject: NonEmpty,
  prevHash: Sha256Hex.or(z.literal("genesis")),
  hash: Sha256Hex,
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
