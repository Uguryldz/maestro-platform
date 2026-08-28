import { NonEmpty } from "@maestro/contracts";
import { z } from "zod";

/**
 * Declarative Jira Cloud driver config (M44): references to secrets, never
 * secret values. Cloud authenticates with HTTP Basic — the token owner's
 * e-mail as the username and an Atlassian API token as the password —
 * so `apiTokenRef` is a SecretPort key resolved at wiring time.
 */
export const JiraCloudConfig = z.object({
  baseUrl: z.url(),
  /** E-mail address the API token belongs to — the Basic-auth username. */
  email: z.email(),
  /** SecretPort key for the Atlassian API token (never the token itself). */
  apiTokenRef: NonEmpty,
  /**
   * SecretPort key for the webhook signing secret — the `secret` handed to Jira
   * when the webhook is registered (POST /rest/webhooks/1.0/webhook). Cloud
   * signs each delivery with HMAC-SHA256 over the raw body and sends the digest
   * in `X-Hub-Signature`, the same scheme Data Center uses.
   *
   * OPTIONAL because a deployment may run Cloud read-only (the pilot polls
   * comments and registers no webhook), and such a deployment must not be
   * forced to invent a secret it never uses. Absent does NOT mean "skip
   * verification": `verifyWebhook` refuses a delivery it has no secret for.
   */
  webhookSecretRef: NonEmpty.optional(),
  /** Issue type used for fan-out children (M100) — stock type, no screen changes. */
  childIssueTypeName: NonEmpty.default("Task"),
  /** Issue link type name as configured in the Cloud site. */
  linkTypeName: NonEmpty.default("Relates"),
  requestTimeoutMs: z.number().int().positive().max(120_000).default(15_000),
  /** Page size for the group member listing used by membership checks. */
  groupPageSize: z.number().int().positive().max(1_000).default(50),
});
export type JiraCloudConfig = z.infer<typeof JiraCloudConfig>;

export const JIRA_CLOUD_DRIVER = "jira-cloud";
