import {
  EMPTY_STATUS_DRAFT,
  type StatusDraft,
} from "../common/status-map.ts";

/**
 * The guided setup's data model — everything the five panes read and write,
 * plus the one piece of real logic the wizard owns: which defaults a chosen
 * flow type implies.
 *
 * Kept out of the screen component so the defaults can be asserted directly and
 * so the panes stay presentational. The wizard is deliberately a SINGLE draft
 * object rather than per-step state: "geri gidince yazdıklarım kayboldu" is the
 * complaint that makes a wizard worse than the three tabs it replaces, and one
 * object that never resets on navigation is the cheapest way to make that
 * impossible rather than merely unlikely.
 */

/** The three flows Maestro can run. There is no fourth. */
export const FLOW_TYPES = ["analiz", "duzeltme", "gelistirme"] as const;
export type FlowType = (typeof FLOW_TYPES)[number];

/**
 * Which flows touch a repository — and therefore need a repository connection
 * before the wizard may offer them.
 *
 * `analiz` produces a document and stops, so it works on an install that has
 * never heard of GitHub. The other two write code and open a pull request; a
 * run that reaches those steps with no SCM connection cannot finish.
 *
 * This exists because the failure it prevents was expensive and silent. The
 * radio group offered all three unconditionally, an operator picked "Yeni özellik
 * geliştirme", the rule saved, the ticket ran — intake, analysis, publication,
 * a human's approval — and only then did the engineering step fail. Every one
 * of those steps cost real time, and the thing that made them futile was
 * knowable before the first click.
 *
 * The check is a PREREQUISITE, not a capability flag: it asks whether this
 * install has been given a repository, which an operator can fix in the panel
 * and see reflected here immediately. It is deliberately NOT a question about
 * the server's profile — that was the old answer, and it was unfixable from
 * the UI by design.
 */
export function flowNeedsRepository(flow: FlowType): boolean {
  return flow !== "analiz";
}

/**
 * Whether this draft binds NO repository — the analysis-only, ticket-text
 * mode. One predicate, read by the summary, the save mutation and the panes,
 * so the sentence the operator signs off on and the request the wizard sends
 * cannot disagree about which mode the binding is in.
 *
 * Only `analiz` can be repo-less (the other two flows are blocked at step 2
 * without one), and an `analiz` draft whose operator DID pick a repo stays in
 * repo mode: the optional offer is "bağlarsanız etki analizi dosyalara
 * bakarak yazılır", and picking one is accepting it.
 */
export function bindsNoRepository(draft: SetupDraft): boolean {
  return draft.flowType === "analiz" && draft.repoFullName === "";
}

/**
 * Why a flow cannot be offered right now, as a catalog key — or `null` when it
 * can.
 *
 * `scmConnectionCount` is `null` while the list is still loading. Unknown is
 * NOT the same as zero: accusing an install of having no repository because a
 * request has not come back yet would send an operator to Ayarlar for nothing,
 * which is the same lie the prerequisite banner already takes care to avoid.
 */
export function flowUnavailableReason(
  flow: FlowType,
  scmConnectionCount: number | null,
): string | null {
  if (!flowNeedsRepository(flow)) return null;
  if (scmConnectionCount === null) return null;
  return scmConnectionCount === 0 ? "setup.flow.needs_scm" : null;
}

/**
 * Which ticket field the rule matches on. Mirrors the BFF's `MATCH_KINDS` and
 * the DB CHECK (migration 0020).
 *
 * `assigned` is the third answer the wizard could not give: "her ticket" — no
 * type, no status, just the fact that a human assigned it to the Maestro bot.
 * It is the trigger most first-time operators actually want, and forcing them
 * to name an issue type instead is how a project ends up listening to a type
 * nobody uses.
 */
export type MatchKind = "status" | "issuetype" | "assigned";

/**
 * The value an `assigned` rule sends. The BFF pins it to the same literal
 * anyway (the unique trigger index needs one), so this is the wizard agreeing
 * with the server rather than the wizard deciding — it is never shown to an
 * operator and never compared to a ticket.
 */
export const ASSIGNED_MATCH_VALUE = "*";

/**
 * The data classes a binding can carry — `DataClassE` in the Prisma schema
 * (M18), most open first. There is no fourth.
 */
export const DATA_CLASSES = ["acik", "dahili", "gizli"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** The five panes, in the order an operator walks them. */
export const SETUP_STEPS = ["flow", "project", "tickets", "status", "review"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupDraft {
  /** Step 1 — chosen first, because it decides the defaults for everything else. */
  readonly flowType: FlowType;
  /** Step 2 — the Jira connection the project is listed from, and the project. */
  readonly jiraConnectionId: string;
  readonly jiraProject: string;
  /** Step 2 — the SCM connection and the repository the work lands in. */
  readonly connectionId: string;
  readonly repoFullName: string;
  readonly platform: string;
  /**
   * Step 2 — how confidential this application's tickets are (M18).
   *
   * Asked rather than assumed because the assumption was wrong in the one way
   * the operator could not see. The binding used to fail closed to `gizli`, and
   * `packages/llm-gateway/src/policy.ts` refuses — correctly, on-prem only, no
   * exceptions — to send `gizli` content to a cloud model. On a deployment with
   * no on-prem model that is not a safe default, it is a SILENT one: the run
   * degraded to `ai_assist` and told the operator "modeli kullanamadım, elle
   * tamamlayın" with nothing anywhere naming the data class as the cause.
   * (Measured: SAM1-12 stalled; after SAM1 was moved to `dahili`, SAM1-13 ran
   * analysis normally.) A question with the CONSEQUENCE written next to each
   * answer is the only honest version of this field.
   */
  readonly dataClass: DataClass;
  /** Step 3 — which tickets the rule picks up. */
  readonly assigneeAccountId: string;
  readonly matchKind: MatchKind;
  readonly matchValue: string;
  /** Step 4 — the optional Jira status map, OFF unless the operator turns it on. */
  readonly statusOn: boolean;
  readonly statusDraft: StatusDraft;
  readonly reassignOnNeedInfo: boolean;
}

/**
 * The starting draft. `analiz` leads because it is the only flow that cannot
 * write code: a first-time operator who clicks straight through ends up with
 * the most conservative configuration this wizard can produce, not the one that
 * opens pull requests against a bank's repository.
 */
export const EMPTY_SETUP_DRAFT: SetupDraft = {
  flowType: "analiz",
  jiraConnectionId: "",
  jiraProject: "",
  connectionId: "",
  repoFullName: "",
  platform: "",
  // `dahili` is the safe-but-WORKABLE default. `gizli` is safer on paper and is
  // what the server used to assume, but on an install with no on-prem model it
  // silently disables analysis altogether — a default that stops the product
  // from working is not a conservative default, it is a broken one. `acik`
  // would be the genuinely permissive choice and is never a default.
  dataClass: "dahili",
  assigneeAccountId: "",
  matchKind: "issuetype",
  matchValue: "",
  statusOn: false,
  statusDraft: EMPTY_STATUS_DRAFT,
  reassignOnNeedInfo: false,
};

/**
 * What the chosen flow implies for the binding it proposes.
 *
 * This is the wizard's whole reason to ask "ne yapmak istiyorsun?" first. The
 * expert screen makes an operator answer trigger/gate/merge as three separate
 * questions in vocabulary ("risk_tiered", "opt_in") that means nothing to
 * someone whose job is approving Jira tickets. Here the same three answers fall
 * out of the one question they CAN answer, and the summary pane spells the
 * result back to them in sentences.
 *
 * `analiz` never merges anything, so its merge mode is moot — human is still
 * what is sent, because a flow that writes no code must not be the one binding
 * that says "auto" if the flow is later changed on the expert screen.
 */
export interface FlowDefaults {
  readonly triggerMode: "opt_in" | "automatic";
  readonly gateSet: "risk_tiered" | "always_six";
  readonly mergeMode: "human" | "auto";
}

const FLOW_DEFAULTS: Readonly<Record<FlowType, FlowDefaults>> = {
  // Analysis produces a document and stops. Nothing it does can reach a repo,
  // so the lightest gate set is honest rather than lax.
  analiz: { triggerMode: "opt_in", gateSet: "risk_tiered", mergeMode: "human" },
  // A bug fix DOES write code, and it skips the analysis gate to get there.
  // Opt-in triggering is what keeps that from happening to a ticket nobody
  // pointed at Maestro.
  duzeltme: { triggerMode: "opt_in", gateSet: "risk_tiered", mergeMode: "human" },
  // Feature work walks the full ladder. Every gate, every time: this is the
  // flow that opens the largest pull requests, and it is not the place to start
  // trimming checks on a first-time setup.
  gelistirme: { triggerMode: "opt_in", gateSet: "always_six", mergeMode: "human" },
};

export function flowDefaults(flow: FlowType): FlowDefaults {
  return FLOW_DEFAULTS[flow];
}

/**
 * Whether a step has everything it needs to move on, and — when it does not —
 * WHICH catalog key explains why in the operator's own terms.
 *
 * Returning the reason rather than a boolean is the point. "İleri" going dead
 * with no explanation is the failure mode of every wizard a bank has already
 * suffered through; every blocked step here can say which field is empty or
 * which prerequisite is missing, and the caller renders it next to the button.
 */
export function stepBlockedReason(
  step: SetupStep,
  draft: SetupDraft,
  scmConnectionCount: number | null = null,
): string | null {
  switch (step) {
    case "flow":
      // A radio group with a default selected can never be EMPTY — but it can
      // hold a choice this install cannot serve. `analiz` is always available,
      // so an operator is never stranded here with nothing to pick; what they
      // are stopped from doing is walking four more steps toward a run that
      // was going to fail after a human had already approved its analysis.
      return flowUnavailableReason(draft.flowType, scmConnectionCount);
    case "project":
      if (draft.jiraConnectionId === "") return "setup.blocked.no_jira_connection_picked";
      if (draft.jiraProject === "") return "setup.blocked.no_project";
      // The repository trio is required exactly when the chosen flow will
      // write code. `analiz` produces a document from the ticket text, so an
      // analysis team without a repository — the actual first-pilot audience —
      // walks through with everything blank; a repo they DID start picking
      // must still be finished, because "half a repository" is not a binding
      // either mode can honour.
      if (!flowNeedsRepository(draft.flowType)) {
        if (draft.connectionId !== "" && draft.repoFullName === "") return "setup.blocked.no_repo";
        if (draft.repoFullName !== "" && draft.platform === "") return "setup.blocked.no_platform";
        return null;
      }
      if (draft.connectionId === "") return "setup.blocked.no_scm_connection_picked";
      if (draft.repoFullName === "") return "setup.blocked.no_repo";
      if (draft.platform === "") return "setup.blocked.no_platform";
      return null;
    case "tickets":
      if (draft.assigneeAccountId.trim() === "") return "setup.blocked.no_assignee";
      // "Bota atanan her ticket" has no second condition to fill in — the
      // assignee above IS the whole rule — so demanding a value here would make
      // the third choice impossible to get past.
      if (draft.matchKind !== "assigned" && draft.matchValue.trim() === "") {
        return "setup.blocked.no_match_value";
      }
      return null;
    case "status":
      // The whole step is optional; an operator who turned the map ON and then
      // filled nothing in is not blocked — `buildStatusMap` folds that back to
      // comment-only, which is exactly what the summary will say.
      return null;
    case "review":
      return null;
  }
}
