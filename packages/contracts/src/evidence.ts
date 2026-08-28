import { z } from "zod";
import { IsoDateTime, NonEmpty, RunId, Sha256Hex, TicketKey } from "./common.js";
import { GateDecision } from "./workflow.js";

export const EvidenceFile = z.object({
  name: NonEmpty,
  sha256: Sha256Hex,
  bytes: z.number().int().nonnegative(),
  contentType: NonEmpty,
});
export type EvidenceFile = z.infer<typeof EvidenceFile>;

/**
 * Evidence package manifest: analysis + diff + test report + approval chain
 * + consumption. Retained 10 years (M56); optional S3 Object Lock (M57).
 */
export const EvidencePackage = z.object({
  runId: RunId,
  ticketKey: TicketKey,
  createdAt: IsoDateTime,
  templateVersion: NonEmpty,
  files: z.array(EvidenceFile).min(1),
  approvals: z.array(GateDecision),
  retentionYears: z.number().int().positive().default(10),
  objectLock: z.boolean().default(false),
});
export type EvidencePackage = z.infer<typeof EvidencePackage>;
