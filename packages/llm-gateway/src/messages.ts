/**
 * Message KEYS only (M104) — no user-facing text is embedded in this package.
 * The `llm.*` keys are requested in RAPOR.md (tr+en proposal) and must be added
 * to packages/config/locales before any surface translates them.
 *
 * `MSG_QUEUED_QUOTA` is not carried by the outcome any more: `status:"queued"`
 * carries a machine-readable `reason` instead, and this is the key a surface
 * maps `reason:"subscription_quota"` to (`run.queued_quota` already exists in
 * the catalog).
 */
export const MSG_QUEUED_QUOTA = "run.queued_quota";
export const MSG_DEGRADED_AI_ASSIST = "llm.degraded_ai_assist";
/** `gizli` under `onPremMissing: "block"` — the class itself is the reason. */
export const MSG_BLOCKED_CONFIDENTIAL = "llm.blocked_confidential";
/**
 * Any other class whose route permits no bound backend. A separate key because
 * telling a `dahili` user that confidential data was refused would be a lie
 * about their own data classification.
 */
export const MSG_BLOCKED_ROUTE = "llm.blocked_by_route";
