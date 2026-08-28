/**
 * Wire shapes for the self-service onboarding wizard (M93/M102). Split from
 * `admin-api.ts` only to keep each file inside the 300-line budget; both are
 * endpoint requests, neither is implemented in the BFF yet.
 */

/** GET /onboarding/options — the lists the wizard's selects are built from. */
export interface OnboardingOptions {
  readonly jiraProjects: readonly string[];
  readonly adoRepos: readonly string[];
  readonly platforms: readonly string[];
}

/** GET /onboarding/scm-connections — the SCM connections a repo can be picked from. */
export interface ScmConnection {
  readonly id: string;
  readonly kind: "github" | "ado";
  readonly displayName: string;
}

/** GET /onboarding/jira-connections — the Jira connections a project can be picked from. */
export interface JiraConnection {
  readonly id: string;
  readonly kind: "jira_cloud" | "jira_dc";
  readonly displayName: string;
}

/** One Jira project a connection can reach. */
export interface JiraProject {
  readonly key: string;
  readonly name: string;
}

/** GET /onboarding/jira-projects — the live project listing, or a secret-free failure. */
export type JiraProjectsResult =
  | { readonly ok: true; readonly projects: readonly JiraProject[] }
  | { readonly ok: false; readonly messageKey: string; readonly messageParams?: Record<string, string> };

/** GET /onboarding/pending — one onboarding package awaiting a second approver (M93). */
export interface PendingBinding {
  readonly projectKey: string;
  /**
   * All three are `null` for an analysis-only package: the proposal binds no
   * repository and the analysis is written from the ticket text. The approver
   * is confirming exactly that, so the screen renders the fact as a sentence
   * rather than an empty cell.
   */
  readonly appId: string | null;
  readonly adoRepo: string | null;
  readonly platform: string | null;
  readonly triggerMode: "opt_in" | "automatic";
  readonly gateSet: "risk_tiered" | "always_six";
  readonly mergeMode: "human" | "auto";
  readonly proposedBy: string;
  readonly at: string;
}

/** One repository a connection can reach. */
export interface ScmRepo {
  readonly id: string;
  readonly fullName: string;
}

/** GET /onboarding/scm-repos — the live repo listing, or a secret-free failure. */
export type ScmReposResult =
  | { readonly ok: true; readonly repos: readonly ScmRepo[] }
  | { readonly ok: false; readonly messageKey: string; readonly messageParams?: Record<string, string> };

/**
 * POST /onboarding/dry-run — where the last N tickets WOULD land under the
 * proposed rules (M102). The three buckets are separate because they call for
 * different actions: tier 1 is settled, tier 2 needs a human to confirm the
 * AI's guess, and tier 3 has no home at all and must be resolved before the
 * project is activated.
 */
export interface DryRunResult {
  /** Ticket keys resolved by an explicit rule (tier 1). */
  readonly byRule: readonly string[];
  /** Resolved by AI suggestion needing human confirmation (tier 2). */
  readonly bySuggestion: readonly string[];
  /** Unresolved — needs a manual assignment (tier 3). */
  readonly unresolved: readonly string[];
}
