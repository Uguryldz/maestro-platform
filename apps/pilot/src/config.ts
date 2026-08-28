/**
 * Pilot constants. Unlike the demo, ONE edge is real: Jira is the live Cloud
 * site https://uyildiz.atlassian.net (project OPS). ADO stays a fake server the
 * pilot starts itself; the model, PII masking and audit are real, as in demo.
 *
 * The real values are read from the environment at boot (see env.ts):
 *   - OPENROUTER_API_KEY  (the model)
 *   - The live Jira identity, as MAESTRO BOT: MAESTRO_BOT_EMAIL +
 *     MAESTRO_BOT_API_TOKEN (through a SecretPort), with the personal
 *     JIRA_CLOUD_EMAIL / JIRA_CLOUD_API_TOKEN kept only as a loud fallback.
 *   - MAESTRO_BOT_ACCOUNT_ID  (the bot's Cloud accountId — drives the
 *     assignment-based discovery JQL below).
 * None is stored here; this file carries references, ports and defaults only.
 */

/** Browser entry point. 7020 to avoid clashing with the demo's 7010. */
export const UI_PORT = 7020;
/** Fake Azure DevOps Services (the only prop server the pilot starts). */
export const ADO_PORT = 7021;

/** Secret references, in the `@maestro/secrets` key grammar. */
export const SECRET_REFS = {
  /** Live Atlassian API token — the only NON-throwaway secret in the pilot. */
  jiraCloud: "kv/jira-cloud/token#value",
  adoPat: "kv/ado/pat#value",
  adoWebhook: "kv/ado/webhook#value",
  openrouter: "kv/llm/openrouter#value",
  /** GitHub token (fine-grained PAT or App installation token) — only seeded when PILOT_SCM=github. */
  github: "kv/github/token#value",
} as const;

// ----------------------------------------------------------------- SCM switch

/**
 * Which ScmPort the pilot drives (Dalga C2). `fake` (the default) keeps the
 * existing behaviour EXACTLY — the ADO prop, no push, `issueSecret` throws — so
 * nothing changes without an explicit opt-in. `github` builds the REAL GitHub
 * driver from GITHUB_OWNER/REPO + token and does a REAL git push + PR.
 *
 * The default is deliberately `fake`: a missing GitHub token must never turn
 * into a silent no-op push, and every offline test runs the fake unless it opts
 * into github with an injected fetch + exec.
 */
export type ScmMode = "fake" | "github";

/**
 * Reads and validates PILOT_SCM; anything but `github` is treated as `fake`.
 *
 * By default `process.env` wins over the passed map (the real app layers the
 * live shell env over `maestro/.env`). When `authoritative` is true the passed
 * map is the SOLE source and `process.env` is ignored — tests inject a fixed
 * env this way so a polluted `PILOT_SCM=github` in the developer's shell can
 * never sweep an offline test into the real GitHub path.
 */
export function scmMode(env: Record<string, string> = {}, authoritative = false): ScmMode {
  const raw = (
    authoritative ? env["PILOT_SCM"] ?? "fake" : process.env["PILOT_SCM"] ?? env["PILOT_SCM"] ?? "fake"
  )
    .trim()
    .toLowerCase();
  return raw === "github" ? "github" : "fake";
}

/**
 * TTL requested for the short-lived push credential (M31). Well under the
 * driver's one-hour ceiling: the credential only has to survive one
 * clone→push, and a tighter window shrinks the blast radius of a leak.
 */
export const GITHUB_PUSH_TTL_SECONDS = 600;

/** Base branch the pilot's feature branch targets on GitHub. */
export const GITHUB_TARGET_BRANCH = process.env["GITHUB_TARGET_BRANCH"] ?? "main";

/**
 * Values behind the FAKE references only. The Jira Cloud token is never here —
 * it is seeded into the SecretPort from JIRA_CLOUD_API_TOKEN at boot.
 */
export const PILOT_SECRETS = {
  adoPat: "pilot-ado-pat",
  adoWebhook: "pilot-ado-service-hook-secret",
} as const;

/** Basic-auth username half of the ADO Service Hook credential. */
export const ADO_WEBHOOK_USERNAME = "maestro";

// ------------------------------------------------------------------ Jira (real)

/** Project on the live site the pilot works in. */
export const PROJECT_KEY = "OPS";

/**
 * JQL that finds the tickets Maestro must work on. The opt-in signal is now
 * ASSIGNMENT, not a label: a ticket is Maestro's iff it is assigned to the
 * Maestro Bot account and not yet Done. This is the foundation of the
 * assignment-driven SDLC flow — dragging a ticket onto the bot IS the trigger.
 *
 * The bounded-JQL guard is preserved: the query still names the project
 * (`project = OPS`), so the driver's guard that refuses an unbounded search
 * still passes. The accountId is quoted so Jira Cloud parses the opaque
 * `712020:...` value as a single literal (an unquoted colon would break it).
 *
 * `botAccountId` comes from MAESTRO_BOT_ACCOUNT_ID at boot; it is NEVER
 * hard-coded here. When it is missing the caller (env.ts) substitutes
 * `currentUser()` and logs a loud warning — the query stays bounded and valid,
 * but discovery then follows whoever the token authenticates as.
 */
export function discoveryJql(botAccountId: string): string {
  const assignee = botAccountId.trim().length > 0 ? `"${botAccountId.trim()}"` : "currentUser()";
  return `project = ${PROJECT_KEY} AND assignee = ${assignee} AND statusCategory != Done ORDER BY created DESC`;
}

/**
 * The discovery JQL with the bot account left to `currentUser()`. Used as the
 * default by `discoverTickets` so the offline poll test keeps a bounded,
 * project-scoped query without wiring an accountId; the running app always
 * passes the resolved, accountId-bearing JQL from boot.
 */
export const DISCOVERY_JQL = discoveryJql("");
/** Cap the discovery page — the driver's bounded-JQL guard still applies. */
export const DISCOVERY_MAX = 20;

/** Fields to fetch per discovered issue (enough to render + map). */
export const DISCOVERY_FIELDS = ["summary", "status", "labels", "created", "reporter", "issuetype"] as const;

/**
 * Group whose membership every gate approval is checked against (M32/M51).
 *
 * SoD RELAXATION (M71): the live site is single-user — the operator is PO, TL
 * and QA at once — so the gate cannot be given to a DIFFERENT person than the
 * one who started the run. The pilot relaxes SoD by pointing the approver group
 * at one the operator is genuinely in on the site (recorded in
 * fixtures/cloud/group-member-by-name.json). The rule is NOT deleted: the
 * verifyMembership check still runs and still fail-closes on a non-member.
 * See RAPOR.md. Override with PILOT_APPROVER_GROUP.
 */
export const APPROVER_GROUP = process.env["PILOT_APPROVER_GROUP"] ?? "jira-users-uyildiz";

/**
 * The audit trail records a gate approver as a corporate account (`user@corp`),
 * but a Cloud comment author is an opaque `accountId` (Cloud has no username,
 * and GDPR lets a site hide e-mails). This maps the pilot operator's accountId
 * to the corporate account the audit records — the human stays visible in the
 * chain. An author that is ALREADY e-mail-shaped is used as-is; an unknown
 * accountId falls back to PILOT_OPERATOR_ACCOUNT so a gate is never recorded
 * with an unattributable actor. Override both via env.
 */
export const PILOT_OPERATOR_ACCOUNT = process.env["PILOT_OPERATOR_ACCOUNT"] ?? "0uguryldz94@gmail.com";

/**
 * Corporate account for a Cloud comment author (audit needs `user@corp`).
 *
 * The operator-account fallback is passed in so this can be resolved against the
 * live SettingsStore at USE time (the UI can change it without a restart). An
 * author that is already e-mail-shaped is used as-is regardless.
 */
export function corpAccountOf(author: string, operatorAccount: string = PILOT_OPERATOR_ACCOUNT): string {
  const value = author.trim();
  if (/^[^@\s]+@[^@\s]+$/.test(value)) return value; // already an e-mail identity
  return operatorAccount; // opaque accountId → configured operator account
}

// ------------------------------------------------------------------ ADO (fake)

export const ADO_ORG = "ugurbank";
export const ADO_PROJECT = "UgurPay";
export const ADO_REPO = "ugurpay";
/** The one build definition allowed to close the CI gate (M12 allow-list). */
export const ADO_PR_VALIDATION_DEFINITION = 12;

/**
 * BOOTSTRAP-DEFAULT model, NOT the flow-time model (M38).
 *
 * Read once here so a fresh/offline pilot has a model to fall back to when no
 * variant store is wired. The running flow resolves its model from the VARIANT
 * (DB) via `resolveVariantModel` — this constant is only the default the seed
 * plants and the offline fallback the boot logs a warning about. Cheap on
 * purpose (same as the demo) because it is a throwaway starting point.
 */
export const PILOT_MODEL = process.env["PILOT_MODEL"] ?? "openai/gpt-4o-mini";

/** Variant id recorded on every gateway call log (M38). */
export const PILOT_VARIANT = "pilot-v1";

/**
 * The variants whose MODEL the pilot resolves from the store (M38). One per
 * thinking role, matching the ids `seedDefaultVariants` plants, so a fresh
 * install's DB-first resolution finds a real row an admin can then re-version
 * from Studio. Overridable via env for a pilot pointed at differently-named
 * variants, but the DEFAULT is the seeded pair — never a hardcoded model.
 */
export const PILOT_ANALYST_VARIANT = process.env["PILOT_ANALYST_VARIANT"] ?? "analyst-default";
export const PILOT_ENGINEER_VARIANT = process.env["PILOT_ENGINEER_VARIANT"] ?? "engineer-default";

/**
 * Data class of the payloads. `gizli` + `onPremMissing: "masked_cloud"` masks
 * before anything leaves the machine — the bank's real posture (M18/M63).
 * Overridable (UI-editable) via PILOT_DATA_CLASS; defaults to `gizli`.
 */
export const PILOT_DATA_CLASS = process.env["PILOT_DATA_CLASS"] ?? "gizli";

/**
 * The permanent KÖK (root) for the single analysis sandbox. Every ticket runs in
 * its own isolated subdirectory under this root and the root is never torn down;
 * empty (the default) keeps the legacy throwaway-per-run `mkdtemp` behaviour.
 * This is only the BOOTSTRAP SEED — after boot the value lives in the runtime
 * SettingsStore and is edited from the UI, never re-read from env at use time.
 */
export const SANDBOX_ROOT = process.env["PILOT_SANDBOX_ROOT"] ?? "";

/**
 * The review status the analysis-approval handover moves a ticket to (the OPS
 * workflow's review column, "İNCELEMEDE"). This is only the BOOTSTRAP SEED for
 * the UI-editable setting; the driver matches it by name first and then falls
 * back to the In-Progress status CATEGORY, so a renamed column never breaks the
 * handover. Overridable via PILOT_REVIEW_STATUS.
 */
export const REVIEW_STATUS_NAME = process.env["PILOT_REVIEW_STATUS"] ?? "İNCELEMEDE";

/** How often the poller lists comments while a gate is open (ms). */
export const COMMAND_POLL_MS = Number(process.env["PILOT_COMMAND_POLL_MS"] ?? 3_000);
/** How often discovery re-lists opted-in tickets while idle (ms). */
export const DISCOVERY_POLL_MS = Number(process.env["PILOT_DISCOVERY_POLL_MS"] ?? 15_000);

/**
 * The seed for the runtime `SettingsStore` — the six UI-editable settings, read
 * ONCE from the env constants above. After boot the store is authoritative; the
 * env only seeds it, so nothing changes if the panel is never touched. Structural
 * constants (ADO_*, ports, JQL) and secrets are deliberately NOT here.
 */
export function defaultSettings(): {
  approverGroup: string;
  model: string;
  commandPollMs: number;
  discoveryPollMs: number;
  dataClass: string;
  operatorAccount: string;
  sandboxRoot: string;
  reviewStatusName: string;
  autoMerge: boolean;
  autoStart: boolean;
} {
  return {
    approverGroup: APPROVER_GROUP,
    model: PILOT_MODEL,
    commandPollMs: COMMAND_POLL_MS,
    discoveryPollMs: DISCOVERY_POLL_MS,
    dataClass: PILOT_DATA_CLASS,
    operatorAccount: PILOT_OPERATOR_ACCOUNT,
    sandboxRoot: SANDBOX_ROOT,
    reviewStatusName: REVIEW_STATUS_NAME,
    // Human-merge by default (B14). Only an explicit PILOT_AUTO_MERGE=true seeds
    // it on; anything else — unset, "false", "0" — stays off.
    autoMerge: process.env["PILOT_AUTO_MERGE"] === "true",
    // Auto-start ON by default (the engine's heartbeat): only an explicit
    // PILOT_AUTO_START=false turns it off. The guard is elsewhere — only a
    // ticket a listening rule can classify is ever auto-started.
    autoStart: process.env["PILOT_AUTO_START"] !== "false",
  };
}
