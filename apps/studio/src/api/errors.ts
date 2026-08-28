/**
 * The BFF never sends prose. Its failure body is flat: `{ error: "<code>" }`
 * plus an optional `details` object (apps/bff/src/server.ts). The `code` is a
 * stable machine identifier, so the Studio maps it to a catalog key and renders
 * the translated sentence. Raw server text is never printed to the user — there
 * is none to print, and that is the design we must not regress.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, details: unknown) {
    super(`api ${status} ${code}`);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Catalog key for this failure; see packages/config/locales/*.json. */
  get messageKey(): string {
    return errorMessageKey(this.code);
  }
}

/** Raised when the network never produced an HTTP response. */
export class NetworkError extends Error {
  override readonly name = "NetworkError";
  readonly messageKey = "error.network";
  constructor(override readonly cause: unknown) {
    super("network request failed");
  }
}

/** Raised when the session is gone; the app routes to /login. */
export class UnauthenticatedError extends ApiError {
  constructor(code: string, details: unknown) {
    super(401, code, details);
  }
}

/**
 * Every code the BFF can emit, mapped to a catalog key. Codes absent from this
 * table fall back to `error.unexpected` — a generic translated sentence, never
 * the raw code. Keep in sync with apps/bff/src/errors.ts call sites; a new BFF
 * code without an entry here is a bug caught by test/api-client.test.ts.
 */
const ERROR_KEYS: Readonly<Record<string, string>> = {
  // 401
  unauthenticated: "error.unauthenticated",
  session_expired: "error.session_expired",
  invalid_credentials: "error.invalid_credentials",
  // 400
  invalid_login_body: "error.invalid_login_body",
  invalid_query: "error.invalid_query",
  invalid_ticket_key: "error.invalid_ticket_key",
  invalid_archive_request: "error.invalid_archive_request",
  invalid_signal_body: "error.invalid_signal_body",
  reject_needs_reason: "error.reject_needs_reason",
  invalid_param_key: "error.invalid_param_key",
  invalid_param_body: "error.invalid_param_body",
  param_value: "error.param_value",
  invalid_killswitch_body: "error.invalid_killswitch_body",
  ticket_key: "error.invalid_ticket_key",
  bad_request: "error.bad_request",
  /**
   * Onboarding and repo-policy (M102/M52). Every one of these was reaching the
   * operator as the generic `error.unexpected`, which is the failure this table
   * exists to prevent: the BFF answers `project_already_bound` with the project
   * key and its state, and the wizard printed "Beklenmeyen bir hata oluştu."
   * The server was precise and the screen threw the precision away.
   *
   * `invalid_page` and not `invalid_query`: the paging guard has its own code,
   * and mapping it to the neighbouring key would mistranslate it.
   */
  invalid_onboarding_body: "error.invalid_onboarding_body",
  // The Jira-workflow import surface (M102) guards its `project` query.
  invalid_project: "error.invalid_project",
  invalid_page: "error.invalid_page",
  invalid_path: "error.invalid_path",
  invalid_path_pattern: "error.invalid_path_pattern",
  invalid_app_id: "error.invalid_app_id",
  unknown_app: "error.unknown_app",
  unknown_project: "error.unknown_project",
  project_already_bound: "error.project_already_bound",
  platform_mismatch: "error.platform_mismatch",
  proposal_open: "error.proposal_open",
  kill_switch: "error.kill_switch",
  protected_path_is_default: "error.protected_path_is_default",
  protected_path_exists: "error.protected_path_exists",
  protected_path_unknown: "error.protected_path_unknown",
  /**
   * The rest of the BFF's vocabulary.
   *
   * Added wholesale rather than screen-by-screen because the coverage test in
   * `test/api-client.test.ts` now enumerates the BFF's own `throw` sites: every
   * one of these was reaching an operator as `error.unexpected`, and the four
   * onboarding codes above were simply the ones somebody happened to hit while
   * clicking through. Leaving the others would have meant fixing the symptom.
   */
  // Analysis template designer (M108)
  no_template: "error.no_template",
  invalid_template_body: "error.invalid_template_body",
  invalid_template_version: "error.invalid_template_version",
  template_version_not_found: "error.template_version_not_found",
  template_version_conflict: "error.template_version_conflict",
  template_name_required: "error.template_name_required",
  template_sections_required: "error.template_sections_required",
  template_too_many_sections: "error.template_too_many_sections",
  template_section_invalid: "error.template_section_invalid",
  template_section_title_required: "error.template_section_title_required",
  template_section_instruction_required: "error.template_section_instruction_required",
  template_section_format_invalid: "error.template_section_format_invalid",
  // Corporate Word template (M103r/M109)
  doc_template_body: "error.doc_template_body",
  doc_template_empty: "error.doc_template_empty",
  doc_template_not_docx: "error.doc_template_not_docx",
  doc_template_too_large: "error.doc_template_too_large",
  doc_template_version_not_found: "error.doc_template_version_not_found",
  invalid_doc_template_filename: "error.invalid_doc_template_filename",
  invalid_doc_template_version: "error.invalid_doc_template_version",
  raw_body_missing: "error.raw_body_missing",
  // Parameters (M71)
  param_not_guarded: "error.param_not_guarded",
  param_not_seeded: "error.param_not_seeded",
  param_unusable: "error.param_unusable",
  // Settings, notify, routing, variants
  invalid_settings_body: "error.invalid_settings_body",
  invalid_notify_body: "error.invalid_notify_body",
  invalid_routing_body: "error.invalid_routing_body",
  invalid_variant_id: "error.invalid_variant_id",
  unknown_variant: "error.unknown_variant",
  invalid_variant_body: "error.invalid_variant_body",
  variant_exists: "error.variant_exists",
  // Connector-management surface (Connection / ConnectorSecret, migration 0010)
  invalid_connection_id: "error.invalid_connection_id",
  invalid_connection_body: "error.invalid_connection_body",
  // The kind's own required config is missing (`CONNECTION_KIND_SPECS`). The
  // response carries `details.fields`, so the form can mark the exact boxes.
  missing_config: "error.missing_config",
  connection_exists: "error.connection_exists",
  no_such_connection: "error.no_such_connection",
  unknown_connection: "error.unknown_connection",
  invalid_repo_name: "error.invalid_repo_name",
  no_pending_binding: "error.no_pending_binding",
  self_approval: "error.self_approval",
  invalid_listening_rule: "error.invalid_listening_rule",
  invalid_listening_rule_id: "error.invalid_listening_rule_id",
  invalid_listening_seed: "error.invalid_listening_seed",
  // Seed-defaults 409s: deployment facts the operator can act on.
  no_jira_connection: "error.no_jira_connection",
  bot_account_unknown: "error.bot_account_unknown",
  duplicate_listening_rule: "error.duplicate_listening_rule",
  no_such_listening_rule: "error.no_such_listening_rule",
  invalid_guidance: "error.invalid_guidance",
  no_such_guidance: "error.no_such_guidance",
  // Guidance FILE upload (md/txt/docx → note)
  invalid_guidance_upload: "error.invalid_guidance_upload",
  guidance_upload_type: "error.guidance_upload_type",
  guidance_upload_too_large: "error.guidance_upload_too_large",
  // Golden-ticket eval and the M78 justified-pass gate
  invalid_eval_decision: "error.invalid_eval_decision",
  unknown_eval_run: "error.unknown_eval_run",
  eval_regression_needs_justification: "error.eval_regression_needs_justification",
  // Runs, gates and signals
  invalid_ticket: "error.invalid_ticket",
  invalid_mode: "error.invalid_mode",
  step_not_current: "error.step_not_current",
  no_evidence: "error.no_evidence",
  no_repo_card: "error.no_repo_card",
  malformed_payload: "error.malformed_payload",
  // Identity
  invalid_username: "error.invalid_username",
  unknown_user: "error.unknown_user",
  unknown_actor: "error.unknown_actor",
  // User administration (M8/M86)
  invalid_user_body: "error.invalid_user_body",
  user_exists: "error.user_exists",
  password_policy: "error.password_policy",
  // First-run bootstrap change-password (migration 0009)
  invalid_change_password_body: "error.invalid_change_password_body",
  // 403
  role_required: "error.role_required",
  project_access: "error.project_access",
  human_channel_only: "error.human_channel_only",
  not_gate_owner: "error.not_gate_owner",
  signal_not_allowed: "error.signal_not_allowed",
  forbidden: "error.forbidden",
  // 404
  no_run: "error.no_run",
  unknown_param: "error.unknown_param",
  not_found: "error.not_found",
  // 409
  no_open_gate: "error.no_open_gate",
  not_delivered: "error.not_delivered",
  param_value_mismatch: "error.param_value_mismatch",
  conflict: "error.conflict",
  // First-run bootstrap: a restricted session hit a route it may not reach
  // until it sets a real password (migration 0009). The client should already
  // have redirected to the change-password screen; this is the fallback prose.
  password_change_required: "error.password_change_required",
  // The identity driver owns no password this platform may rewrite (AD/LDAP).
  password_change_unavailable: "error.password_change_unavailable",
  // 500
  internal_error: "error.internal_error",
  /**
   * 503 — the route exists, the capability behind it does not.
   *
   * Distinct from 404 on purpose. `MaybeUnwired` reads a 404 as "this screen is
   * not published yet", which is the wrong sentence for `/eval`, `/cache` and
   * `/greenfield`: those endpoints ARE published and answer honestly that
   * nothing writes the data they would read. Without this line the screen falls
   * back to the generic `error.unexpected` and the distinction is lost on the
   * one person it was made for.
   */
  capability_not_wired: "error.capability_not_wired",
};

export function errorMessageKey(code: string): string {
  return ERROR_KEYS[code] ?? "error.unexpected";
}

export function knownErrorCodes(): readonly string[] {
  return Object.keys(ERROR_KEYS);
}

/** The catalog key for any thrown value, so toasts never print raw text. */
export function messageKeyOf(error: unknown): string {
  if (error instanceof ApiError) return error.messageKey;
  if (error instanceof NetworkError) return error.messageKey;
  return "error.unexpected";
}

/**
 * The field-level violations a validation 400 carried (`details.issues`, the
 * BFF's `"path: message"` strings). Empty for anything else — a screen renders
 * these UNDER its translated sentence, so the translated line stays the
 * message and the field names are the actionable part. These are schema field
 * names and zod's own prose, not server text echoing user values.
 */
export function issueDetailsOf(error: unknown): readonly string[] {
  if (!(error instanceof ApiError)) return [];
  const details = error.details as { issues?: unknown } | null | undefined;
  if (details == null || !Array.isArray(details.issues)) return [];
  return details.issues.filter((issue): issue is string => typeof issue === "string");
}
