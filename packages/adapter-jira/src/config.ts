import { NonEmpty } from "@maestro/contracts";
import { z } from "zod";

/**
 * Declarative driver config (M44): references to secrets, never secret values.
 * `tokenRef` / `webhookSecretRef` are SecretPort keys resolved at wiring time.
 */
export const JiraDcConfig = z.object({
  baseUrl: z.url(),
  tokenRef: NonEmpty,
  webhookSecretRef: NonEmpty,
  /** Issue type used for fan-out children (M100) — stock type, no screen changes. */
  childIssueTypeName: NonEmpty.default("Task"),
  /** Issue link type name as configured in the DC instance. */
  linkTypeName: NonEmpty.default("Relates"),
  requestTimeoutMs: z.number().int().positive().max(120_000).default(15_000),
  /** Page size for the group member listing used by membership checks. */
  groupPageSize: z.number().int().positive().max(1_000).default(50),
});
export type JiraDcConfig = z.infer<typeof JiraDcConfig>;

export const JIRA_DC_DRIVER = "jira-dc";
export const WORK_PORT = "work";
