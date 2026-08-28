import type { ParamChange, ParamDefinition, Role } from "@maestro/contracts";

/**
 * Wire shapes for the platform-management screens.
 *
 * Only `/params` and `/killswitch` exist in the BFF today; everything else here
 * is the contract this cluster of screens needs and RAPOR-ekranlar-B.md files
 * as an endpoint request. They are declared in one place on purpose: when the
 * BFF agent lands a route, exactly one file has to agree with it, and a shape
 * that drifts fails typecheck rather than rendering wrong numbers.
 *
 * Nothing here fabricates data. A screen whose endpoint is missing shows the
 * error state — a management console that invents a healthy runner is worse
 * than one that admits it cannot reach the server.
 */

// ── /params (LIVE: GET /params, PUT /params/:key) ─────────────────────────────

export interface PendingParamChange {
  readonly key: string;
  readonly scopeRef: string | null;
  readonly value: unknown;
  readonly proposedBy: string;
  readonly at: string;
}

/** GET /params */
export interface ParamsView {
  readonly definitions: readonly ParamDefinition[];
  readonly values: readonly ParamChange[];
  readonly pending: readonly PendingParamChange[];
}

/** PUT /params/:key — 200 applied, 202 waiting for the second approver. */
export type ParamPutResult =
  | { readonly status: "applied"; readonly change: ParamChange }
  | { readonly status: "pending"; readonly pending: PendingParamChange };

// ── /killswitch (LIVE: GET, POST) ─────────────────────────────────────────────

export type KillSwitchLevel = "off" | "intake_only" | "all";

export interface KillSwitchState {
  readonly level: KillSwitchLevel;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
}

export interface KillSwitchResult {
  readonly state: KillSwitchState;
  /** Workflow ids that were told to stop; empty for `intake_only` and `off`. */
  readonly stopped: readonly string[];
}

// ── /studio/users (LIVE — list, lookup, create, edit, off-board) ──────────────

/**
 * One account, as every `/studio/users` route returns it. Deliberately thin:
 * no password material and no session inventory — the hash never leaves the
 * BFF, and `roles` is the platform's reading of `groups` (M8), computed by the
 * server so client and server can never disagree about what a group grants.
 *
 * `roles` is typed `readonly string[]` and NOT `Role[]`: the directory owns
 * group names and may carry one outside the closed set (`internal-audit`,
 * `release-manager`). The screen renders an unknown value rather than blanking
 * it — see `roleTone` in Users.tsx.
 */
export interface DirectoryUser {
  readonly username: string;
  readonly userId: string;
  /**
   * How the account reads in the table. It differs from the username only for
   * accounts nobody typed — notably the connector-provisioned Jira bot, whose
   * username is a machine id and whose name comes from Jira.
   *
   * OPTIONAL, even though the current BFF always sends one (it falls back to
   * the username server-side). Studio is deployed separately from the BFF, so a
   * newer screen can meet an older directory response; typing this as required
   * would make the compiler promise something the wire cannot.
   */
  readonly displayName?: string;
  readonly roles: readonly string[];
  readonly groups: readonly string[];
  /** False when the account has been off-boarded (deactivated). */
  readonly active: boolean;
}

/** `GET /studio/users` — the whole admin window, including off-boarded rows. */
export interface UsersView {
  readonly items: readonly DirectoryUser[];
}

/**
 * `POST /studio/users`. The password is sent once, over TLS, and never stored
 * client-side; `groups` are the mapped directory groups an admin may assign,
 * and the server derives roles from them. A weak password comes back as
 * `password_policy` with the exact rules it broke.
 */
export interface CreateUserRequest {
  readonly username: string;
  readonly displayName: string;
  readonly groups: readonly string[];
  readonly password: string;
}

/** `PUT /studio/users/:username` — display name, groups (→roles), or active state. */
export interface EditUserRequest {
  readonly displayName?: string;
  readonly groups?: readonly string[];
  readonly active?: boolean;
}

/** The failed password rules the BFF returns in `password_policy.details`. */
export type PasswordViolation =
  | "too_short"
  | "too_long"
  | "no_upper"
  | "no_lower"
  | "no_digit"
  | "no_symbol"
  | "contains_username";

/**
 * The directory groups an admin may assign, mapped to the role each grants.
 * MUST stay in sync with the BFF's `ROLE_BY_GROUP` (apps/deploy/src/stores/
 * users.ts) — that is the authority; this mirrors it for the form + preview.
 *
 * A group name is free text; the AUTHORITY it grants is one of the six frozen
 * roles. So a new team (operators, analysts) is added here without touching the
 * Role enum — it just points at an existing role.
 */
export const ROLE_BY_GROUP: Readonly<Record<string, Role>> = {
  "maestro-admins": "admin",
  operators: "tech-lead",
  "tech-leads": "tech-lead",
  analysts: "product-owner",
  "product-owners": "product-owner",
  qa: "qa",
  developers: "developer",
  "internal-audit": "viewer",
};

export const ASSIGNABLE_GROUPS: readonly string[] = Object.keys(ROLE_BY_GROUP);

// ── paging (LIVE: every /studio list endpoint) ────────────────────────────────

/**
 * Every list endpoint is bounded (M7): a page plus an opaque cursor.
 * `nextCursor: null` means "that was the last page", which is not the same as
 * a short page — a full final page is not a signal.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

// ── /studio/runners, /studio/sandboxes (LIVE) ─────────────────────────────────

export type RunnerState = "idle" | "busy" | "draining" | "unreachable";

/** A row of `GET /studio/runners` (BFF `RunnerRecord`). */
export interface RunnerRecord {
  readonly runnerId: string;
  readonly pool: string;
  readonly platform: string;
  readonly state: RunnerState;
  readonly capacity: number;
  readonly activeSandboxes: number;
  readonly lastHeartbeatAt: string;
  /** Why a runner is not fully healthy; `null` when it is. */
  readonly note: string | null;
}

/** Per-pool capacity, summed by the BFF so client and server never disagree. */
export interface PoolSummary {
  readonly pool: string;
  readonly capacity: number;
  readonly busy: number;
  readonly machines: number;
  readonly unhealthy: number;
}

export interface RunnersResponse extends Page<RunnerRecord> {
  readonly pools: readonly PoolSummary[];
}

export type SandboxState = "active" | "resumable" | "human_held";

/** A row of `GET /studio/sandboxes` (BFF `SandboxRecord`). */
export interface SandboxRecord {
  readonly ticketKey: string;
  readonly runnerId: string;
  readonly state: SandboxState;
  readonly sizeBytes: number;
  readonly lastAccessAt: string;
}

// ── /studio/health (LIVE) ─────────────────────────────────────────────────────

export type ServiceState = "healthy" | "degraded" | "down" | "not_configured";

/** A row of `GET /studio/health` (BFF `ServiceHealth`). */
export interface ServiceHealth {
  readonly service: string;
  /**
   * `not_configured` marks a dependency nobody has set up (an LLM or Jira
   * connection) — honestly distinct from `down`, which means "configured and
   * failing". The BFF's aggregate state never carries it.
   */
  readonly state: ServiceState;
  readonly version: string;
  readonly checkedAt: string;
  readonly note: string | null;
}

export interface HealthResponse {
  /** Worst state across the services, computed by the BFF; never `not_configured`. */
  readonly state: "healthy" | "degraded" | "down";
  readonly services: readonly ServiceHealth[];
}

// ── /settings (REQUESTED) ─────────────────────────────────────────────────────

export type ConnectionStatus = "connected" | "degraded" | "unconfigured";

export interface Connection {
  readonly id: string;
  readonly endpoint: string;
  readonly status: ConnectionStatus;
  /** Vault path or auth method — never the secret itself. */
  readonly credentialRef: string;
  readonly checkedAt: string | null;
}

export interface NotifyDriver {
  readonly channel: string;
  readonly enabled: boolean;
  readonly target: string;
}

export interface SettingsView {
  readonly connections: readonly Connection[];
  readonly notifyDrivers: readonly NotifyDriver[];
}

// ── /studio/connections (connector-management surface) ────────────────────────

/**
 * A MANAGED connection — the editable connector, distinct from the read-only
 * `Connection` (deployment fact) above. The token is never here: a read carries
 * only `secretMask` (last four chars) and `secretSet`. This mirrors the Zod
 * `Connection` in @maestro/contracts.
 */
export type ManagedConnectionKind =
  | "jira_cloud"
  | "jira_dc"
  | "github"
  | "ado"
  | "openrouter"
  | "anthropic"
  /** A self-hosted, OpenAI-shaped model server (vLLM, llama.cpp, Ollama, …). */
  | "openai_compat"
  | "vault"
  | "smtp"
  | "storage";

export type ManagedConnectionAuthKind = "basic" | "bearer" | "pat" | "api_key";

export interface ManagedConnection {
  readonly id: string;
  readonly kind: ManagedConnectionKind;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly authKind: ManagedConnectionAuthKind;
  readonly config: Readonly<Record<string, string>>;
  readonly secretRef: string | null;
  /** Last four chars of the stored token, or null. Never the token. */
  readonly secretMask: string | null;
  readonly secretSet: boolean;
  readonly enabled: boolean;
  /** M18: the operator's assertion that this endpoint runs inside the bank. */
  readonly onPrem: boolean;
  /** Which model answers when a flow names none; at most one row holds it. */
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastTestedAt: string | null;
  /** null = never tested; true/false = the last live test's real result. */
  readonly lastTestOk: boolean | null;
  /**
   * A short, SECRET-FREE catalog key describing the last test's outcome
   * (e.g. "connection.test.unauthorized"), or null. Rendered so a failed test
   * shows WHY, never a token/DSN.
   */
  readonly lastTestNote: string | null;
}

/** The create/update payload — `token` is write-only and optional. */
export interface ManagedConnectionInput {
  readonly kind: ManagedConnectionKind;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly authKind: ManagedConnectionAuthKind;
  readonly config: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly onPrem: boolean;
  readonly isDefault: boolean;
  readonly token?: string;
}

/** The live-test response — ok/fail plus a catalog key to render (never a token). */
export interface ConnectionTestResponse {
  readonly ok: boolean;
  readonly messageKey: string;
  readonly messageParams?: Readonly<Record<string, string>>;
  readonly testedAt: string;
  /**
   * The stored bot account did not belong to the token and was corrected to the
   * real owner. Rendered as a WARNING, not a green tick: the connection works,
   * but rules and attributions built on the old id need a second look. Account
   * ids only — the identity probe's email is never carried here.
   */
  readonly botAccountCorrected?: { readonly from: string; readonly to: string };
}

// ── /notify (REQUESTED) ───────────────────────────────────────────────────────

export interface EscalationStep {
  readonly afterHours: number;
  readonly channels: readonly string[];
  /** `delegate` and `report` steps render differently from a plain reminder. */
  readonly kind: "notify" | "delegate" | "report";
}

export interface Delegation {
  readonly role: Role;
  readonly primary: string;
  readonly backup: string | null;
  readonly lastResort: string | null;
}

export interface WaitingGate {
  readonly ticketKey: string;
  readonly step: string;
  readonly waitingHours: number;
  readonly lastActionKey: string | null;
  readonly lastActionParams?: Readonly<Record<string, string>>;
}

/** The four notification channels a driver can be (M45). */
export type NotifyChannel = "teams" | "smtp" | "jira" | "slack";

/**
 * The events that can raise a notification (M45), mirrored from
 * `packages/contracts/src/notify.ts` NotifyEventKey. Listed here so the notify
 * screen can render a row per event — including one that has no explicit routing
 * and therefore follows `default`. Order is meaningful only for display.
 */
export const NOTIFY_EVENTS = [
  "gate_open",
  "gate_reminder",
  "escalation",
  "clarification_reminder",
  "handover",
  "ci_red",
  "quota_wait",
  "runner_health",
  "kill_switch",
] as const;
export type NotifyEventKey = (typeof NOTIFY_EVENTS)[number];

/**
 * The stored channel routing (M45/M71/M87), exactly as the BFF round-trips it.
 *
 * `default` covers every event without an explicit entry; an event mapped to an
 * empty list is muted DELIBERATELY. The editor reads and writes this shape
 * unchanged so a save cannot silently reinterpret a mute as a default.
 */
export interface NotifyRouting {
  readonly default: readonly NotifyChannel[];
  readonly byEvent: Readonly<Record<string, readonly NotifyChannel[]>>;
}

/**
 * The stored ladder verbatim, as PUT /notify accepts it back.
 *
 * The editor changes a THRESHOLD and sends these same steps with their `id`
 * intact; a projected rung has no id and re-deriving one re-escalates every
 * open gate. `businessHoursOnly`/`calendar` are round-tripped opaquely so an
 * edit to the thresholds leaves the working-calendar untouched.
 */
export interface EscalationLadderRaw {
  readonly steps: readonly EscalationLadderStep[];
  readonly businessHoursOnly: boolean;
  readonly calendar: unknown;
}

export interface NotifyView {
  readonly ladder: readonly EscalationStep[];
  readonly delegations: readonly Delegation[];
  readonly waiting: readonly WaitingGate[];
  /** The stored routing map, so the editor round-trips exactly. */
  readonly routing: NotifyRouting;
  /** The stored ladder verbatim, so a threshold edit keeps every step id. */
  readonly ladderRaw: EscalationLadderRaw;
  /**
   * The Teams webhook URL, MASKED ("…<last 6>") when set, "" when not. The full
   * URL is a bearer credential and never reaches the screen.
   */
  readonly teamsWebhookMask: string;
}

/**
 * PUT /notify — the escalation ladder and/or the channel routing.
 *
 * Both fields are optional and an absent one is left alone (the BFF resets
 * nothing). The ladder is sent as the STORED shape — one `channel` and `event`
 * per step, keyed by a stable `id` — not the projected rungs the screen reads,
 * because editing a threshold must keep the id so open gates do not re-escalate.
 */
export interface EscalationLadderStep {
  readonly id: string;
  readonly afterHours: number;
  readonly channel: NotifyChannel;
  readonly event: string;
  readonly action: "notify" | "delegate";
  readonly to?: readonly string[];
}

export interface NotifyUpdate {
  readonly ladder?: EscalationLadderRaw;
  readonly routing?: NotifyRouting;
  /** The Teams webhook URL to store, or "" to clear it. */
  readonly teamsWebhook?: string;
}

// ── /routing (LIVE: GET /routing, PUT /routing) ───────────────────────────────

/** How a ticket enters the flow. */
export interface RoutingProject {
  readonly projectKey: string;
  readonly trigger: string;
  readonly apps: readonly string[];
  readonly noteKey?: string;
  readonly noteParams?: Readonly<Record<string, string>>;
}

/** One rendered rule of the data-class routing policy. */
export interface RoutingRule {
  readonly ruleId: string;
  readonly conditionKey?: string;
  readonly conditionParams?: Readonly<Record<string, string>>;
  readonly backend: string;
  readonly model: string;
  readonly outcome: string;
}

export interface RoutingView {
  readonly projects: readonly RoutingProject[];
  readonly rules: readonly RoutingRule[];
  /**
   * The stored policy verbatim, so the editor round-trips it EXACTLY.
   *
   * The rendered `rules` are lossy (`degrade_ai_assist` and `masked_cloud` both
   * become `degraded`), so the editor MUST edit against this, never reconstruct
   * a fallback from an outcome. Editing a guessed value silently downgrades the
   * stored policy on a save that never touched it, and four-eyes cannot catch it
   * because the two proposals agree with each other.
   */
  readonly policy: DataClassPolicy;
}

/** The three data classes the policy assigns a backend to, most open first. */
export type DataClassName = "acik" | "dahili" | "gizli";

/** What happens when the on-prem backend a class requires is unavailable. */
export type OnpremFallback = "degrade_ai_assist" | "block" | "masked_cloud";

/**
 * The guarded `dataclass.policy` parameter — PUT /routing edits exactly this.
 *
 * It is GUARDED (M32/M78): the first PUT files a proposal and a different person
 * must send the identical value before it applies, so the screen must show
 * `pending` distinctly from `applied`.
 */
export interface DataClassPolicy {
  readonly backendByClass: Readonly<Record<DataClassName, string>>;
  readonly whenOnpremMissing: OnpremFallback;
}

export interface RoutingUpdate {
  readonly policy: DataClassPolicy;
}

// ── /studio/apps (LIVE) — the Application Registry (M100) ─────────────────────

/** ApplicationRecord (M100), as the registry table renders it. */
export interface ApplicationRecord {
  readonly appId: string;
  readonly displayName: string;
  readonly adoProject: string;
  readonly adoRepo: string;
  readonly platform: string;
  readonly jiraComponent: string | null;
  readonly maestroYamlPresent: boolean;
  readonly createdVia: "onboarding" | "import";
}

// ── /mcp (REQUESTED) ──────────────────────────────────────────────────────────

export type McpScope = "read" | "operate" | "admin-proposal";

export interface McpTool {
  readonly name: string;
  readonly scope: McpScope;
  /** Catalog key describing the tool (M104). */
  readonly descriptionKey: string;
}

export interface McpView {
  readonly endpoint: string;
  readonly auditActor: string;
  readonly tools: readonly McpTool[];
  /** Tools deliberately absent — listed so the boundary is visible, not implied. */
  readonly forbiddenTools: readonly string[];
}

// ── /commands (REQUESTED) ─────────────────────────────────────────────────────

export interface JiraCommand {
  readonly name: string;
  readonly roles: readonly Role[];
  readonly takesArgument: boolean;
  /** Catalog keys — the BFF must not send prose (M104). */
  readonly whenKey: string;
  readonly effectKey: string;
}

export interface CommandsView {
  readonly commands: readonly JiraCommand[];
}

// ── /repo-policy (REQUESTED) — the .maestro.yaml screen ───────────────────────

export interface RepoPolicy {
  readonly appId: string;
  readonly platform: string;
  readonly repo: string;
  /** The file as it exists in the repo; read-only in Studio. "" when absent. */
  readonly yaml: string;
  /**
   * Whether a run has ever observed this repository's `.maestro.yaml`.
   *
   * The server used to explain its absence in a block of English YAML comments,
   * which landed untranslated on a Turkish screen. Now it sends the fact and
   * the screen writes the sentence (`yaml.absent.*`).
   */
  readonly yamlPresent?: boolean;
  /**
   * Protected paths (M52). Platform defaults are separated from repo additions
   * because a default may be ADDED TO but never removed — a UI that mixed them
   * into one editable list would imply a delete that the server refuses.
   */
  readonly protectedPaths: {
    readonly platformDefaults: readonly string[];
    readonly repoAdditions: readonly string[];
  };
  readonly fetchedAt: string | null;
}

export interface RepoPolicyView {
  readonly policies: readonly RepoPolicy[];
}

/** Onboarding wire shapes live in ./onboarding-api.ts. */
