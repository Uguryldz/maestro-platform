/**
 * Demo-only constants. Nothing here is production configuration: the Jira and
 * the ADO endpoints point at the fake servers this app starts itself, and the
 * "secrets" are throwaway strings shared between the two sides of localhost.
 *
 * The ONE real value is the OpenRouter API key, which is read from
 * `maestro/.env` (git-ignored) and never printed, logged or serialised.
 */

/** Browser entry point — the single page the demo is watched from. */
export const UI_PORT = 7010;
/** Fake Jira Data Center. */
export const JIRA_PORT = 7011;
/** Fake Azure DevOps Services. */
export const ADO_PORT = 7012;

/** Secret references, in the `@maestro/secrets` key grammar. */
export const SECRET_REFS = {
  jiraPat: "kv/jira/pat#value",
  jiraWebhook: "kv/jira/webhook#value",
  adoPat: "kv/ado/pat#value",
  adoWebhook: "kv/ado/webhook#value",
  openrouter: "kv/llm/openrouter#value",
} as const;

/**
 * Values behind the fake references. They authenticate localhost against
 * localhost; the adapters still refuse a wrong one, which is the point.
 */
export const DEMO_SECRETS = {
  jiraPat: "demo-jira-pat",
  jiraWebhook: "demo-jira-webhook-secret",
  adoPat: "demo-ado-pat",
  adoWebhook: "demo-ado-service-hook-secret",
} as const;

/** Basic-auth username half of the ADO Service Hook credential. */
export const ADO_WEBHOOK_USERNAME = "maestro";

/** The ticket the demo run works on. */
export const TICKET_KEY = "UGURPAY-501";
export const PROJECT_KEY = "UGURPAY";

/** Jira usernames the demo knows about. */
export const REPORTER = "ayse.kaya";
export const APPROVER = "mert.demir";
/** Corporate account of the approver — the audit trail only accepts `user@corp`. */
export const APPROVER_ACCOUNT = "mert.demir@bank.example";
export const SERVICE_ACCOUNT = "maestro-svc";
/** Group whose membership the gate decisions are checked against (M32/M51). */
export const APPROVER_GROUP = "tech-leads";

/** Azure DevOps coordinates of the demo repository. */
export const ADO_ORG = "ugurbank";
export const ADO_PROJECT = "UgurPay";
export const ADO_REPO = "ugurpay";
export const ADO_DEFAULT_BRANCH = "refs/heads/main";
/** The one build definition allowed to close the CI gate (M12 allow-list). */
export const ADO_PR_VALIDATION_DEFINITION = 12;

/** Default ticket text; carries personal data on purpose so masking is visible. */
export const DEFAULT_SUMMARY = "Şifre sıfırlama akışına e-posta doğrulama adımı eklensin";
export const DEFAULT_DESCRIPTION = [
  "Kullanıcı şifresini sıfırlarken e-posta ile gönderilen 6 haneli kod doğrulanmalı.",
  "",
  "Notlar:",
  "* kod 10 dakika geçerli olmalı",
  "* 3 yanlış denemede hesap 15 dakika kilitlenmeli",
  "* pilot kullanıcı: ayse.kaya@bank.example, telefon 0532 111 22 33",
].join("\n");

/** Model used for every thinking role. Cheap on purpose. */
export const DEMO_MODEL = process.env["DEMO_MODEL"] ?? "openai/gpt-4o-mini";

/** Variant id recorded on every gateway call log (M38). */
export const DEMO_VARIANT = "demo-v1";

/**
 * Data class of the demo payloads. `gizli` together with
 * `onPremMissing: "masked_cloud"` is what makes the gateway mask before the
 * payload leaves the machine — the bank's real posture while no on-prem model
 * exists (M18/M63).
 */
export const DEMO_DATA_CLASS = "gizli" as const;
