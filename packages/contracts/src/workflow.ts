import { z } from "zod";
import { IsoDateTime, NonEmpty, RiskTier, RunId, TicketKey } from "./common.js";

/**
 * Canonical step ids of the delivery flow
 * (masterplan §5 + diagrams/maestro-tumkapsam.md; mirrored by the mock).
 */
export const STEP_IDS = [
  "0", // work mode resolution (label / RoutingRule)
  "2", // intake — completeness check (AI)
  "2b", // clarification — human WAIT gate, unbounded + reminders
  "3o", // repo discovery — read-only agent session
  "3", // analyst — template-validated analysis + impact matrix
  "4", // PO approval (human gate)
  "5", // Tech Lead approval (human gate, SoD vs PO)
  "6a", // engineering — agent session in sandbox
  "6b", // security scans — fail-closed (M27)
  "6c", // dev-reviewer — real diff review (AI)
  "7", // test-designer (AI)
  "8", // test-reviewer (AI, 4-eyes on coverage)
  "9", // QA scenario approval (human gate)
  "10", // test-engineer — tests actually run
  "10b", // CI gate — ADO build validation signal (auto gate)
  "11", // QA result approval (human gate)
  "12", // PR approval (human gate; TL + ADO min 1 human reviewer)
  "12b", // PR thread loop — changes requested → back to 6a
  "13", // evidence package + closure
] as const;

export const StepId = z.enum(STEP_IDS);
export type StepId = z.infer<typeof StepId>;

export const StepKind = z.enum(["system", "ai", "human_gate", "human_wait", "auto_gate"]);
export type StepKind = z.infer<typeof StepKind>;

/** Step metadata; titles live in the message catalog under `steps.<id>` (M104). */
export const STEP_META: Record<StepId, { kind: StepKind; titleKey: string }> = {
  "0": { kind: "system", titleKey: "steps.0" },
  "2": { kind: "ai", titleKey: "steps.2" },
  "2b": { kind: "human_wait", titleKey: "steps.2b" },
  "3o": { kind: "ai", titleKey: "steps.3o" },
  "3": { kind: "ai", titleKey: "steps.3" },
  "4": { kind: "human_gate", titleKey: "steps.4" },
  "5": { kind: "human_gate", titleKey: "steps.5" },
  "6a": { kind: "ai", titleKey: "steps.6a" },
  "6b": { kind: "system", titleKey: "steps.6b" },
  "6c": { kind: "ai", titleKey: "steps.6c" },
  "7": { kind: "ai", titleKey: "steps.7" },
  "8": { kind: "ai", titleKey: "steps.8" },
  "9": { kind: "human_gate", titleKey: "steps.9" },
  "10": { kind: "ai", titleKey: "steps.10" },
  "10b": { kind: "auto_gate", titleKey: "steps.10b" },
  "11": { kind: "human_gate", titleKey: "steps.11" },
  "12": { kind: "human_gate", titleKey: "steps.12" },
  "12b": { kind: "system", titleKey: "steps.12b" },
  "13": { kind: "system", titleKey: "steps.13" },
};

/** Human APPROVAL gates. 2b is a human wait (clarification), not an approval. */
export const APPROVAL_GATE_STEPS = ["4", "5", "9", "11", "12"] as const satisfies readonly StepId[];

/**
 * Risk-tiered gate sets (M51):
 * dusuk → 2 gates (TL analysis + PR); orta → 4 (+PO +QA result);
 * kritik → full approval set (plus the always-possible 2b wait — the "6 gates" wording).
 */
export const GATES_BY_RISK: Record<RiskTier, readonly StepId[]> = {
  dusuk: ["5", "12"],
  orta: ["4", "5", "11", "12"],
  kritik: ["4", "5", "9", "11", "12"],
};

export const GateDecision = z
  .object({
    step: StepId,
    decision: z.enum(["approve", "reject"]),
    actorUserId: NonEmpty,
    actorGroup: NonEmpty,
    sodVerified: z.boolean(),
    signatureSeq: z.number().int().positive(),
    source: z.enum(["jira", "studio"]),
    at: IsoDateTime,
    reason: NonEmpty.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "reject" && !v.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reject requires a reason" });
    }
  });
export type GateDecision = z.infer<typeof GateDecision>;

/**
 * ADO build validation result (M13), delivered to the workflow as a signal.
 *
 * `adoProject`/`adoRepo` exist because ticketKey+prId do NOT identify a build
 * uniquely: a mirrored/forked repo in another project can carry the same
 * branch name and PR id. The workflow MUST reject a signal whose origin does
 * not match the run's ApplicationRecord. Optional only so that a driver that
 * cannot determine them fails validation downstream instead of at parse time.
 */
export const CiResultSignal = z.object({
  ticketKey: TicketKey,
  adoProject: NonEmpty.optional(),
  adoRepo: NonEmpty.optional(),
  prId: z.number().int().positive(),
  buildId: z.number().int().positive(),
  status: z.enum(["succeeded", "failed"]),
  detailsUrl: z.url().optional(),
  finishedAt: IsoDateTime,
});
export type CiResultSignal = z.infer<typeof CiResultSignal>;

export const ClarificationAnswerSignal = z.object({
  ticketKey: TicketKey,
  answeredBy: NonEmpty,
  text: NonEmpty,
  at: IsoDateTime,
});
export type ClarificationAnswerSignal = z.infer<typeof ClarificationAnswerSignal>;

/** Two-level kill switch (M58). */
export const KillSwitchSignal = z.object({
  level: z.enum(["intake_only", "all"]),
  actor: NonEmpty,
  reason: NonEmpty,
  at: IsoDateTime,
});
export type KillSwitchSignal = z.infer<typeof KillSwitchSignal>;

export const WorkflowRunStatus = z.enum([
  "running",
  "gate",
  "queued",
  "fail",
  "handover",
  "done",
  "cancelled",
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;

export const WorkflowRunState = z.object({
  runId: RunId,
  ticketKey: TicketKey,
  step: StepId,
  status: WorkflowRunStatus,
  risk: RiskTier.optional(),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkflowRunState = z.infer<typeof WorkflowRunState>;
