import type { AdoCiDriver } from "@maestro/adapter-ado";
import type { AnalysisTemplate } from "@maestro/agent-roles";
import {
  adfToPlainText,
  bulletList,
  cloudUserIdOf,
  doc,
  heading,
  inlineCode,
  isAdfDoc,
  isTextAttachment,
  paragraph,
  selectDoneTransition,
  selectReturnTransition,
  selectReviewTransition,
  strong,
  text,
  type JiraCloudWorkPort,
} from "@maestro/adapter-jira";
import type { AuditChain } from "@maestro/audit";
import type {
  AnalysisDoc,
  ApplicationRecord,
  AuditAction,
  CommandEnvelope,
  DataClass,
  GitSha,
  LlmRole,
  TicketKey,
} from "@maestro/contracts";
import type { LlmGateway } from "@maestro/llm-gateway";
import { compiledProfileFor, scanForPii, type LoadedPiiPolicy } from "@maestro/pii";
import type { RepoRef, ScmPort } from "@maestro/ports";
import { z } from "zod";
import {
  ADO_PROJECT,
  ADO_REPO,
  corpAccountOf,
  GITHUB_PUSH_TTL_SECONDS,
  GITHUB_TARGET_BRANCH,
  PILOT_ANALYST_VARIANT,
  PILOT_ENGINEER_VARIANT,
  type ScmMode,
} from "./config.js";
import {
  applyTemplateOverlay,
  produceAnalysis,
  requestIntake,
  type AnalysisTemplateOverlay,
  type AnalysisTemplateOverlayLoader,
  type TicketComment,
} from "./analysis.js";
import { type ChangeTypeMatch, classifyChangeTypes } from "./change-type.js";
import { analysisToDocs, attachAnalysisDocs, type DocStore, type PilotDocTemplate } from "./docs.js";
import { flowTypeLabel, type FlowType, type ListeningRule, type ListeningRulesStore } from "./listening.js";
import { resolveVariantModel, type VariantModelReader } from "./variant.js";
import type { RoleModels } from "./wiring.js";
import { planFor } from "./flow-plan.js";
import type { GuidanceStore } from "./guidance.js";
import { markExistingCommentsSeen, pollForCommandOnce, PollAbortedError } from "./poll.js";
import type { PilotSettings, SettingsStore } from "./settings.js";
import type { StateStore } from "./state.js";
import {
  createWorkspace,
  IMPLEMENTATION_PATH,
  TEST_PATH,
  type CreateWorkspaceOptions,
  type DemoWorkspace,
} from "./workspace.js";

/**
 * The shortened delivery flow, run against a REAL Jira Cloud site:
 *
 *   intake → analiz → İNSAN KAPISI → kod → tarama → test → PR → İNSAN KAPISI → merge
 *
 * The difference from the demo is the Jira edge: every getTicket/addComment/
 * setLabels call reaches the live site, and the two human gates are resolved by
 * POLLING the ticket's comments (Atlassian Cloud cannot deliver a webhook to
 * localhost). ADO, as in the demo, is a prop; the model, PII and audit are real.
 */

/** A step that failed for a reason worth showing on screen rather than a stack. */
export class PilotStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PilotStepError";
  }
}

/**
 * The intake gate found the ticket too thin to analyse and RETURNED it (İADE):
 * it posted the open questions AND handed the ticket back to its reporter —
 * reassigned + moved to a backlog status (step 2, M98). This is NOT a failure:
 * the flow stops CLEANLY and never falls through to the analysis/gate/code
 * steps. `start()` catches this type apart from a real error so the run reads
 * "returned to reporter", not "failed".
 */
export class ClarificationRequestedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClarificationRequestedError";
  }
}

/**
 * A human resolved a gate with `/reject`. Carries the rejection reason so the
 * gate's caller can decide what happens next:
 *   - the ANALYSIS gate turns this into a CLEAN return (the manager rejected the
 *     analysis → note on the ticket + hand it back to the bot for re-analysis),
 *   - the PR gate lets it propagate as a failure (a rejected PR stops the run).
 * `awaitApproval` throws this instead of a bare `PilotStepError` so the two gates
 * can behave differently without the poller knowing which gate it serves.
 */
export class GateRejectedError extends Error {
  constructor(
    public readonly reason: string,
    /** The Cloud comment author who wrote `/reject` — the human the reject is attributed to. */
    public readonly author: string,
  ) {
    super(`kapı reddedildi: ${reason}`);
    this.name = "GateRejectedError";
  }
}

/**
 * The Analyst Manager rejected the analysis at the review gate. Like İADE this is
 * a CLEAN STOP, not a failure: the rejection note is on the ticket and the ticket
 * has been handed back to the bot for re-analysis, so the run ends cleanly and
 * never falls through to the code/PR steps.
 */
export class AnalysisRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisRejectedError";
  }
}

const CodeDraft = z
  .object({
    summary: z.string().min(1),
    implementation: z.string().min(1),
    test: z.string().min(1),
  })
  .strict();
type CodeDraft = z.infer<typeof CodeDraft>;

const MAX_ENGINEER_ATTEMPTS = 3;
/** How many times a rejected PR is revised from reviewer feedback before the
 * ticket is handed to a human (the AI does not argue with the reviewer forever). */
const MAX_REVISE_ROUNDS = 2;

/**
 * The runner identity the pilot's sandbox events carry (M60).
 *
 * The pilot opens its workspace in-process — there is no fleet of runners here
 * to report a real host — so the "runner" a sandbox belongs to is this one
 * local pilot. A stable constant rather than a per-run value keeps every
 * workspace this process opens attributable to the same runner on the Studio
 * sandbox screen, which is what `PrismaSandboxReader` folds on.
 */
const PILOT_RUNNER = "pilot-local";

/** The AI commit identity (M13); the push token is NOT this — see cloneForGithub. */
const AI_AUTHOR_NAME = "Maestro AI";
const AI_AUTHOR_EMAIL = "maestro@ugurbank.example";

/** A short-lived push credential minted from the ScmPort (M31). */
type PushCredential = Awaited<ReturnType<ScmPort["getPushCredential"]>>;

/** Models sometimes fence code even when told not to; the fence is not code. */
function stripFences(value: string): string {
  const fenced = /^\s*```(?:[a-zA-Z]*)\n([\s\S]*?)```\s*$/.exec(value);
  return (fenced?.[1] ?? value).trim();
}

const APPLICATION = {
  appId: "ugurpay",
  displayName: "Ugur Payments",
  adoProject: ADO_PROJECT,
  adoRepo: ADO_REPO,
  platform: "linux-node",
  jiraComponent: null,
  maestroYamlPresent: false,
  createdVia: "import",
} as const;

/** GitHub-only run inputs; present iff `scmMode === "github"`. */
export interface GithubRunConfig {
  /** Credential-free HTTPS remote, e.g. https://github.com/owner/repo.git */
  remoteUrl: string;
  /** GitHub owner/repo for the Application Registry record used by the driver. */
  owner: string;
  repo: string;
}

export interface PilotRunDeps {
  work: JiraCloudWorkPort;
  scm: ScmPort;
  ci: AdoCiDriver;
  /** Which SCM edge is live (M-C2). `fake` keeps the ADO prop; `github` pushes for real. */
  scmMode?: ScmMode;
  /** Required when `scmMode === "github"`: where the runner clones/pushes. */
  github?: GithubRunConfig;
  /** Injected exec runner for the git push; tests stub it (never shell out). */
  workspaceOptions?: CreateWorkspaceOptions;
  /**
   * PR merge-status source. Defaults to `scm`. On the github path this points
   * at the FAKE (CI + merge stay faked in C2 — real GitHub checks is C3), so
   * `getPrStatus` and the merge simulation do not hit the real GitHub PR. Its
   * OWN repo ref is used for the status call (an ADO-shaped ref), not the
   * github owner/repo the branch/PR steps use.
   */
  mergeStatus?: Pick<ScmPort, "getPrStatus" | "resolveRepo">;
  /**
   * Called on the github path once the REAL PR is open, so the faked CI signal
   * can be delivered for its real id (real GitHub checks is C3). No-op on fake.
   */
  onRealPrOpened?: (prId: number, sourceRef: string) => void;
  llm: LlmGateway;
  audit: AuditChain;
  piiPolicy: LoadedPiiPolicy;
  store: StateStore;
  /** Runtime settings (approver group, model, poll ms, data class, operator). */
  settings: SettingsStore;
  /**
   * The reporter's Cloud accountId a ticket is handed BACK to on the İADE
   * (not-fit) branch. Seeded from MAESTRO_REQUESTER_ACCOUNT_ID at boot and
   * UI-param-ready (Studio). Empty string means "not configured": the ticket is
   * still moved back to the backlog, just not reassigned — never a crash.
   */
  requesterAccountId?: string;
  /**
   * The Analyst Manager's Cloud accountId a ticket is handed to for ANALYSIS
   * APPROVAL (onay devri). When the analysis is complete and its Word/PDF are
   * attached, the ticket is reassigned to this account and moved into review
   * ("İNCELEMEDE"). Seeded from MAESTRO_MANAGER_ACCOUNT_ID at boot, UI-param-ready
   * (Studio). Empty string means "not configured": the ticket is still moved into
   * review, just not reassigned — never a crash.
   */
  managerAccountId?: string;
  /**
   * The Maestro Bot's Cloud accountId the ticket is reassigned BACK to once the
   * manager approves the analysis (for the code step), and on a rejected analysis
   * (for re-analysis). Seeded from MAESTRO_BOT_ACCOUNT_ID at boot — the same id
   * the assignment-based discovery filters on — UI-param-ready. Empty string
   * means "not configured": the reassign-back is skipped (a warning), the flow
   * still proceeds; the ticket simply stays with the manager.
   */
  botAccountId?: string;
  /**
   * The live listening rules (Faz 3). Optional: when present, the run classifies
   * the ticket into a flow type (status/issuetype → analiz|duzeltme|gelistirme)
   * and records it for the UI/log. Absent (older callers, most tests) leaves the
   * flow un-classified — exactly the pre-Faz-3 behaviour.
   */
  listening?: ListeningRulesStore;
  /**
   * The enabled analysis-guidance notes ("öğren"). Read when building the
   * analysis context so uploaded knowledge shapes the analysis. Optional: absent
   * or empty means the analyst leans only on the ticket, as before.
   */
  guidance?: GuidanceStore;
  /**
   * The analyst agent's PERSONA overlay — the instruction text an admin wrote in
   * Studio for the analyst variant (resolved from the DB at boot). When present,
   * it is injected into the analyst's context so the agent behaves as configured
   * in Studio, not only on the corporate-default persona. Absent = default.
   * With a `variantReader` wired these are only the FALLBACK — each run
   * re-resolves the persona from its own variant (see `resolveRunAgents`).
   */
  analystPersona?: string;
  /** The engineer agent's PERSONA overlay (Studio's engineer-variant persona). */
  engineerPersona?: string;
  /**
   * Run-time variant resolution (Faz 3: akış → ajan eşlemesi). When wired, the
   * run resolves the matched listening rule's `analystVariantId` /
   * `engineerVariantId` (defaults: the boot variants) to a MODEL + PERSONA per
   * run — so an admin binding ANY Studio agent to a rule, or publishing a new
   * version of an already-bound agent, takes effect on the very next ticket, no
   * restart. Absent = the boot-resolved model/persona, exactly as before.
   */
  variantReader?: VariantModelReader;
  /**
   * Rebuild the LLM gateway for THIS run's resolved role models (wired by boot
   * as a `createPilotGateway` closure — pilot-side only, the gateway package is
   * untouched). The gateway's role→model bindings are immutable once built, so
   * applying a run-resolved model means building a run-local gateway; the boot
   * gateway stays the fallback for every run that resolves nothing new. Absent
   * (older callers/tests) = the deps gateway serves every run, as before.
   */
  makeRunGateway?: (models: RoleModels) => LlmGateway;
  /** Holds the generated .docx/.pdf so the download route can stream them. */
  docs: DocStore;
  /**
   * Lazy loader for the ACTIVE corporate Word template (DocTemplateVersion in
   * the DB, wired by the composition root). Read at document-generation time so
   * a template uploaded in Studio is used on the very next run, no restart.
   * Absent or resolving null = the plain built-in layout, as before.
   */
  docTemplate?: () => Promise<PilotDocTemplate | null>;
  /**
   * Lazy loader for the ACTIVE Studio analysis-template overlay
   * (AnalysisTemplateVersion in the DB, wired by the composition root). Read
   * PER RUN, right before the analyst — so a template published in Studio
   * shapes the very next analysis, no restart. Only a key-matched section's
   * title + aiInstruction are overlaid (`applyTemplateOverlay`); the engine's
   * contract bindings never change. Absent or resolving null = the corporate
   * default template, exactly as before.
   */
  analysisTemplateOverlay?: AnalysisTemplateOverlayLoader;
  /** Stands in for the human who presses "Complete" in the ADO PR screen. */
  completePullRequest: (prId: number) => boolean;
  /** Called whenever the Jira side changed, so the UI can refresh its pane. */
  onJiraChanged?: () => void;
  ciTimeoutMs?: number;
  mergePollMs?: number;
  /** Poll interval for the gate comment poller (ms). */
  commandPollMs?: number;
  /** Injected sleep so tests advance the gate poller without real timers. */
  sleep?: (ms: number) => Promise<void>;
}

export class PilotRun {
  private runId = "";
  private ticketKey: TicketKey | null = null;
  private progressCommentId: string | null = null;
  /**
   * The data class actually used for this run. It starts at the project's
   * configured class (runSettings.dataClass) but is RAISED to "gizli" the
   * moment PII is detected in the ticket itself (B10) — a TCKN/IBAN pasted into
   * a ticket description must never leave the process as plaintext to a cloud
   * model just because the *project* was classed "acik". Never lowered.
   */
  private detectedDataClass: DataClass | null = null;
  /**
   * Special change types (B11) detected for this run — migration / feature flag
   * / config / dependency. Set once analysis is ready; read by stepEngineering
   * to inject the matching guardrails and by the PR description. Empty = an
   * ordinary change, handled by the generic engineer rules.
   */
  private changeTypes: ChangeTypeMatch[] = [];
  private workspace: DemoWorkspace | null = null;
  private repo: RepoRef | null = null;
  private branch = "";
  /** Commit sha pushed on the github path; null on the fake path. */
  private pushedCommitSha: string | null = null;
  private ciWaiter: { prId: number; resolve: (ok: boolean) => void } | null = null;
  /** Aborts the running gate poller when the flow ends or is stopped. */
  private abort: AbortController | null = null;
  /**
   * The listening-rule flow type for this run, set during intake once the ticket
   * is classified. `planFor(this.flow)` decides which steps run — `analiz` stops
   * after the analysis, `duzeltme` skips the analysis gate, everything else runs
   * the full pipeline. Null until classified (and null = full pipeline).
   */
  private flow: FlowType | null = null;
  /**
   * The optional START HINT: the discovery row's ticket STATUS at the moment the
   * run was started (auto-start and the UI's start button both pass it). The
   * ticket snapshot (`getTicket`) does not carry the status, so without this a
   * STATUS listening rule could never classify the flow. Null = no hint (older
   * callers) — classification then matches on issue type only, as before.
   */
  private startHint: { status?: string } | null = null;
  /**
   * The AGENTS this run actually runs with (Faz 3): the variant id per role —
   * the matched listening rule's mapping, or the boot defaults — plus the
   * persona resolved from that variant PER RUN. Reset at start(); refined by
   * `resolveRunAgents` once the ticket is classified. The variant ids also
   * label every LLM call (LlmCall rows), so cost/PII reporting attributes each
   * call to the agent that really made it.
   */
  private agents: {
    analystVariantId: string;
    engineerVariantId: string;
    analystPersona: string | undefined;
    engineerPersona: string | undefined;
  };
  /**
   * The run-local LLM gateway, built by `makeRunGateway` when this run resolved
   * its variants' models — so the model an admin published in Studio is what
   * THIS run calls, restart-free. Null = the boot gateway (deps.llm) serves.
   */
  private runLlm: LlmGateway | null = null;
  /**
   * The settings this run was started with, snapshotted at start(). Because a
   * settings change is refused WHILE a run is in progress (server.ts guard), the
   * six values are fixed for a whole run: reading them once here keeps approver
   * group / data class / model / operator consistent across every step, so a
   * gate is never opened for one group and closed against another.
   */
  private runSettings: PilotSettings;

  constructor(private readonly deps: PilotRunDeps) {
    this.runSettings = deps.settings.snapshot();
    this.agents = this.defaultAgents();
  }

  /** The boot-resolved agent set — what a run uses until/unless a rule remaps it. */
  private defaultAgents(): PilotRun["agents"] {
    return {
      analystVariantId: PILOT_ANALYST_VARIANT,
      engineerVariantId: PILOT_ENGINEER_VARIANT,
      analystPersona: this.deps.analystPersona,
      engineerPersona: this.deps.engineerPersona,
    };
  }

  /** The LLM port this run calls: the run-local gateway when one was built. */
  private llm(): LlmGateway {
    return this.runLlm ?? this.deps.llm;
  }

  // ---------------------------------------------------------------- run

  async start(ticketKey: TicketKey, hint?: { status?: string }): Promise<void> {
    const { store } = this.deps;
    if (store.snapshot().running) throw new Error("akış zaten çalışıyor");
    // Snapshot the settings for the whole run (they cannot change mid-run — the
    // server refuses a settings write while running), so every step sees one
    // consistent approver group / model / data class / operator / poll interval.
    this.runSettings = this.deps.settings.snapshot();
    this.startHint = hint ?? null;
    this.ticketKey = ticketKey;
    this.runId = `pilot-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
    this.progressCommentId = null;
    this.detectedDataClass = null; // each run re-scans; no carry-over from the last ticket
    this.changeTypes = []; // re-classified per ticket from its own analysis
    this.repo = null;
    this.branch = "";
    this.pushedCommitSha = null;
    this.agents = this.defaultAgents(); // re-resolved per ticket from its own rule
    this.runLlm = null;
    this.abort = new AbortController();
    this.deps.docs.clear();
    store.update((state) => {
      state.running = true;
      state.finished = false;
      state.failure = null;
      state.runId = this.runId;
      state.ticketKey = ticketKey;
      // Reflect the settings this run actually uses (they may have changed since boot).
      state.model = this.runSettings.model;
      state.approverGroup = this.runSettings.approverGroup;
      state.browseUrl = `${state.jiraSite}/browse/${ticketKey}`;
      state.awaitingGate = null;
      state.docsReady = false;
      state.log = [];
      state.llmCalls = 0;
      state.tokens = 0;
      state.maskedFields = 0;
      for (const step of state.steps) {
        step.state = "bekliyor";
        step.notes = [];
      }
    });
    store.log("info", `▶ akış başladı · run ${this.runId} · ticket ${ticketKey} (CANLI Jira)`);

    try {
      await this.record("RUN_STARTED", { ticket: ticketKey });
      // Intake classifies the ticket and sets `this.flow`; the plan then decides
      // which of the remaining steps actually run (analiz → stop after analysis,
      // duzeltme → skip the analysis gate, else → full pipeline).
      const analysis = await this.stepIntakeAndAnalysis();
      const plan = planFor(this.flow);

      if (plan.analysisGate) await this.stepAnalysisGate();

      if (plan.engineering) {
        // Engineer → PR → human PR gate. If the reviewer asks for CHANGES
        // (rejects with feedback) rather than approving, run a REVISE round:
        // collect the PR comments, re-run the engineer with them as feedback,
        // open a fresh PR, and gate again. Bounded so a reviewer who keeps
        // rejecting does not loop forever — after MAX revise rounds it stops and
        // hands the ticket to a human (the reviewer's court, not the AI's).
        let reviewFeedback: string | null = null;
        let approved = false;
        for (let round = 0; round <= MAX_REVISE_ROUNDS && !approved; round += 1) {
          const draft = await this.stepEngineering(analysis, reviewFeedback);
          const prId = await this.stepPullRequest(draft, analysis);
          try {
            await this.stepPrGate(prId);
            await this.stepMerge(prId);
            approved = true;
          } catch (error) {
            if (error instanceof GateRejectedError && round < MAX_REVISE_ROUNDS) {
              reviewFeedback = await this.collectReviewFeedback(prId, error.reason);
              store.log("warn", `↻ revize turu ${round + 1}: inceleyen değişiklik istedi, ajan yeniden çalışıyor`);
              continue;
            }
            throw error; // final round exhausted, or a non-review error
          }
        }
      } else {
        // "analiz" flow: the analysis document IS the deliverable. Stop cleanly
        // here — no code, no PR, no merge — and say so, so the operator does not
        // wait for a PR that was never meant to come.
        store.log("info", "🧾 analiz akışı: analiz belgesi üretildi, kod/PR aşaması atlandı.");
      }

      store.update((state) => {
        state.finished = true;
        state.running = false;
      });
    } catch (error) {
      // The intake gate stopping the flow is NOT a failure: the ticket was too
      // thin to analyse, the reporter has been asked AND the ticket was returned
      // to them, and the run ends cleanly. Everything else is a real failure.
      if (error instanceof ClarificationRequestedError) {
        store.log("warn", `⏎ akış İADE ile durdu: ${error.message}`);
        store.update((state) => {
          state.finished = true;
          state.running = false;
        });
      } else if (error instanceof AnalysisRejectedError) {
        // The manager rejected the analysis: like İADE this is a CLEAN stop, not
        // a failure. The rejection note is on the ticket and the ticket is back
        // with the bot for re-analysis; the run ends cleanly (no code/PR).
        store.log("warn", `⏎ akış analiz-red ile durdu: ${error.message}`);
        store.update((state) => {
          state.finished = true;
          state.running = false;
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        store.log("err", `✗ akış durdu: ${message}`);
        store.update((state) => {
          state.failure = message;
          state.running = false;
        });
        // ERROR VISIBILITY on the Jira side, best-effort: the stakeholder who
        // watches only the ticket must see the flow died — update the standing
        // progress comment and leave a short error note. Both writes are
        // swallowed on failure (Jira may be the very thing that broke).
        await this.reportFailureToJira(message);
      }
    } finally {
      this.abort?.abort();
      this.abort = null;
      // Record the teardown BEFORE disposing, and only if a workspace was
      // actually opened (a failure before stepEngineering leaves it null). The
      // DESTROY moves the workspace to "resumable" on the sandbox screen. A
      // failed audit write must not strand the temp directory, so it is caught:
      // cleanup always runs, and `verifyAudit` below still reports the chain.
      if (this.workspace !== null && this.ticketKey !== null) {
        try {
          await this.recordSandbox("SANDBOX_DESTROY");
        } catch (error) {
          this.deps.store.log("warn", `↻ sandbox kapanışı denetime yazılamadı: ${String(error)}`);
        }
      }
      await this.workspace?.dispose();
      this.workspace = null;
      await this.verifyAudit();
      // Record this run into the pilot's history so past work is not lost when
      // the next run overwrites the live state — the "geçmiş işler" list.
      this.deps.store.archiveCurrent();
    }
  }

  private requireTicket(): TicketKey {
    if (this.ticketKey === null) throw new PilotStepError("ticket seçilmeden akış başlatılamaz");
    return this.ticketKey;
  }

  /**
   * Best-effort Jira-side failure report: refresh the standing progress comment
   * (M75) with the failure and add ONE short error comment, so the flow's death
   * is visible on the ticket, not only on the pilot screen. Every Jira error
   * here is swallowed — the run already failed; reporting must not throw again.
   */
  private async reportFailureToJira(message: string): Promise<void> {
    if (this.ticketKey === null) return;
    const short = message.length > 300 ? `${message.slice(0, 300)}…` : message;
    try {
      await this.updateProgress(`❌ akış durdu: ${short}`);
    } catch {
      // progress comment unreachable — the note below may still land
    }
    try {
      await this.deps.work.addComment(
        this.ticketKey,
        doc(
          heading(3, "❌ Maestro akışı durdu"),
          paragraph([strong("Sebep: "), text(short)]),
          paragraph(
            "Akış bir hata ile kesildi; ayrıntı pilot ekranındaki log'dadır. Sorun giderilince ticket yeniden başlatılabilir.",
          ),
        ),
      );
      this.deps.onJiraChanged?.();
    } catch {
      // Jira unreachable — the screen still shows the failure
    }
  }

  /**
   * The effective data class for this run: the project's configured class,
   * unless a ticket-content scan raised it (B10). Every place that used to read
   * `runSettings.dataClass` (intake, analysis, the PII egress profile) must read
   * THIS instead, so the raised class actually protects the flow.
   */
  private effectiveDataClass(): DataClass {
    return this.detectedDataClass ?? (this.runSettings.dataClass as DataClass);
  }

  /**
   * Ticket-level PII gate (B10). The project's data class is a static default;
   * a single ticket can carry PII the project as a whole does not — a support
   * ticket that pastes a customer's TCKN/IBAN into the description. Scan the
   * ticket's own text (summary + description + any text attachments already
   * read) with the WIDEST profile ("acik" masks the most), and if anything is
   * found, RAISE the run's class to "gizli". Raise only, never lower: a project
   * already classed "gizli" stays "gizli"; a clean ticket in an "acik" project
   * stays "acik".
   */
  private escalateDataClassForPii(
    ticket: { summary: string; description: string },
    attachments: ReadonlyArray<{ content: string | null }>,
  ): void {
    if (this.effectiveDataClass() === "gizli") return; // already at the ceiling
    const widest = compiledProfileFor(this.deps.piiPolicy, "acik").profile;
    const haystack = {
      summary: ticket.summary,
      description: ticket.description,
      attachments: attachments.map((a) => a.content ?? ""),
    };
    const counts = scanForPii(haystack, widest);
    if (counts.occurrences === 0) return;
    this.detectedDataClass = "gizli";
    this.deps.store.log(
      "warn",
      `🔒 ticket içeriğinde ${counts.occurrences} kişisel veri (TCKN/IBAN vb.) bulundu → veri sınıfı "gizli"ye yükseltildi; bu iş yalnızca yerel/gizli-onaylı modele gider.`,
    );
    this.deps.onJiraChanged?.();
  }

  // -------------------------------------------------------------- steps

  /** ① ticket read + ② analysis. */
  private async stepIntakeAndAnalysis(): Promise<AnalysisDoc> {
    const { store, work } = this.deps;
    const ticketKey = this.requireTicket();
    store.step("1", "calisiyor");

    const ticket = await work.getTicket(ticketKey);
    store.log("ok", `✓ CANLI Jira'dan okundu: ${ticket.key} — ${ticket.summary}`);
    store.note("1", `bildiren: ${ticket.reporter} · bileşen: ${ticket.components.join(", ") || "—"}`);

    // Classify the ticket into a flow type from the listening rules (Faz 3). A
    // match records "this is a DÜZELTME/ANALİZ/… flow" for the UI and log; no
    // match leaves it un-classified (the default flow), so a ticket is never
    // blocked by classification. The behaviour BRANCH on flow type is a later
    // phase — here it is visibility only.
    // `getTicket` (TicketSnapshot) carries the issue type but NOT the current
    // status, so the status comes from the START HINT — the discovery row's
    // status the caller passed to `start()` (auto-start and the UI both do).
    // Without a hint the status stays null and a status rule simply does not
    // match here (the pre-hint behaviour), never a block.
    const matchedRule =
      this.deps.listening?.ruleFor(this.deps.botAccountId ?? "", {
        // Project key is the ticket key's prefix ("OPS-123" → "OPS"), so a rule
        // only classifies its own project's tickets.
        projectKey: ticketKey.split("-")[0] ?? "",
        status: this.startHint?.status ?? null,
        issueType: ticket.issueType,
      }) ?? null;
    const flow = matchedRule?.flowType ?? null;
    if (flow !== null) {
      // Remember it for the run: the step sequence in start() reads `this.flow`
      // to decide which steps run (planFor), turning the choice from a label
      // into real behaviour.
      this.flow = flow;
      store.update((state) => {
        state.flowType = flow;
      });
      store.log("info", `👂 dinleme kuralı: bu bir ${flowTypeLabel(flow)} akışı (${ticket.issueType})`);
    }

    // Resolve the AGENTS this run flows through (Faz 3: akış → ajan eşlemesi):
    // the matched rule's variant ids (default: the boot variants), their model +
    // persona read from the variant store PER RUN — so a Studio publish or a
    // rule remap takes effect on the very next ticket without a restart. Runs
    // BEFORE the first LLM call so intake already thinks as the mapped agent.
    await this.resolveRunAgents(matchedRule);

    const labels = ticket.labels.includes("maestro") ? ticket.labels : [...ticket.labels, "maestro"];
    await work.setLabels(ticketKey, labels);
    store.log("dim", `→ etiketler güncellendi (canlı): ${labels.join(", ")}`);

    const progress = await work.addComment(
      ticketKey,
      doc(
        paragraph([strong("▶ Maestro durum:"), text(" analiz hazırlanıyor…")]),
        paragraph("Bu yorum yenisi açılmadan düzenlenerek güncellenir (M75)."),
      ),
    );
    this.progressCommentId = progress.commentId;
    this.deps.onJiraChanged?.();
    store.step("1", "tamam", "canlı Jira'ya durum yorumu bırakıldı");

    // Read the ticket's ATTACHMENTS now — BEFORE the intake role runs — for two
    // reasons: the analyst downstream needs them (a bank ticket that says "the
    // error is in the attached screenshot/spec PDF" is half-context without
    // them), and the ticket-level PII gate (B10) must scan them too. Text
    // attachments are read inline; images/PDFs are named (their bytes are not
    // parsed here — multimodal is a later step) so the analyst at least KNOWS
    // they exist and can flag "review the attached screenshot".
    const attachments = await this.readTicketAttachments(ticketKey);
    if (attachments.length > 0) {
      store.log("info", `📎 ${attachments.length} ek analize katıldı: ${attachments.map((a) => a.name).join(", ")}`);
    }

    // Read the ticket's HUMAN comments (clarify-resume lite): when a returned
    // ticket comes back to the bot, the reporter's answers live in the comments
    // — without reading them the intake would judge the same thin ticket
    // incomplete forever (the İADE loop). Bot comments and command envelopes
    // are filtered out; the last ~10 human comments feed intake AND analysis.
    const comments = await this.readHumanComments(ticketKey);
    if (comments.length > 0) {
      store.log("info", `💬 ${comments.length} insan yorumu intake/analiz bağlamına katıldı`);
    }

    // ---- ⓪ ticket-level PII gate (B10). BEFORE any LLM sees the ticket: if the
    // ticket's own text carries a TCKN/IBAN etc. (regardless of the project's
    // configured class), raise this run's data class to "gizli" so intake and
    // analysis route to a gizli-approved model, not a cloud one. The human
    // comments travel to the model too, so they are scanned alongside.
    this.escalateDataClassForPii(ticket, [
      ...attachments,
      ...comments.map((c) => ({ content: c.text })),
    ]);

    // ---- ② intake / CLARIFY gate (M98), by the REAL agent-roles intake role.
    // An incomplete ticket must NOT get a nine-section analysis over guesses:
    // the role either judges the ticket complete or names what is missing and
    // asks. On "incomplete" the flow stops here and puts the questions back to
    // the reporter as a single Turkish clarification comment.
    store.step("2", "calisiyor");
    const intake = await requestIntake({
      // Intake is the analyst's first pass: the run-resolved gateway + the
      // analyst variant id label, so the call runs (and is logged) as the agent
      // the rule mapped.
      llm: this.llm(),
      ticket,
      variantId: this.agents.analystVariantId,
      dataClass: this.effectiveDataClass(),
      comments,
    });
    if (!intake.complete) {
      // The AGENT LOOKED and judged the ticket unfit → İADE (return), not
      // "ask and wait". Two moves, in order:
      //   (a) write the open questions to the ticket (unchanged clarify note),
      //   (b) hand the ticket BACK — reassign to the reporter and move it to a
      //       backlog/To-Do status (chosen dynamically by category).
      await this.requestClarification(ticket.key, intake.display.missing);
      await this.returnTicketToReporter(ticket.key);
      // Stops the flow CLEANLY (not a failure): no analysis, no gate, no code.
      throw new ClarificationRequestedError(
        `ticket analiz için yeterli değil — ${intake.display.missing.length} soru soruldu ve ticket talep açana İADE edildi`,
      );
    }
    store.log("ok", "✓ intake: ticket analiz için yeterli görüldü");

    // The REAL agent-roles analyst (M43/M108/M109): a real analysis TEMPLATE
    // decides the sections and the fail-closed validation, a real AnalysisContext
    // carries the ticket (repo-card/knowledge are wired when populated — see
    // analysis.ts), and the run-resolved analyst variant is the variant. The seven-section check is
    // no longer a hand-rolled Zod here; it comes from the template.
    // Ajan-hedefli bilgi: global notlar + YALNIZ bu run'ın analist variant'ına
    // hedeflenmiş notlar. Başka bir ajana yüklenen belge buraya sızmaz.
    const guidanceNotes = this.deps.guidance?.forVariant(this.agents.analystVariantId) ?? [];
    if (guidanceNotes.length > 0) {
      store.log("info", `📚 analiz ${guidanceNotes.length} bilgi kütüphanesi notunu dikkate alıyor.`);
    }
    // Prepend the analyst's Studio persona (if configured) as the first knowledge
    // note, so what an admin wrote in the "Persona" field actually steers the
    // analysis. It leads the list so the model reads the role instruction first.
    const analystGuidance =
      this.agents.analystPersona !== undefined
        ? [{ title: "Ajan talimatı (persona)", content: this.agents.analystPersona }, ...guidanceNotes]
        : guidanceNotes;
    if (this.agents.analystPersona !== undefined) {
      store.log("info", "🧠 analist Studio'da tanımlı persona ile çalışıyor.");
    }

    const analysis = await produceAnalysis({
      llm: this.llm(),
      ticket,
      variantId: this.agents.analystVariantId,
      dataClass: this.effectiveDataClass(),
      template: await this.resolveAnalysisTemplate(),
      guidance: analystGuidance,
      attachments,
      comments,
    });
    store.log(
      "ok",
      `✓ analyst: şablon ${analysis.display.impactMatrix.length ? "7/7 doğrulandı" : "doğrulandı"} · risk: ${analysis.display.riskTier} · etki satırı: ${analysis.display.impactMatrix.length}`,
    );
    store.note("2", `risk: ${analysis.display.riskTier} — ${analysis.display.riskReason}`);

    // Special change types (B11): detect migration / feature-flag / config /
    // dependency from BOTH the ticket's own text and the analysis's words (a
    // reporter may not name it; the analyst may surface it in scope/risk). Any
    // hit adds engineer guardrails downstream and a reviewer-facing note here.
    this.changeTypes = classifyChangeTypes([
      ticket.summary,
      ticket.description,
      analysis.display.scope.included.join(" "),
      analysis.display.scope.excluded.join(" "),
      analysis.display.uiApiChanges,
      analysis.display.riskAndRollback.risk,
      analysis.display.riskAndRollback.rollback,
    ]);
    if (this.changeTypes.length > 0) {
      store.log(
        "info",
        `🔧 özel değişiklik türü: ${this.changeTypes.map((c) => c.label).join(", ")} — mühendislik için ek kurallar uygulanacak.`,
      );
    }

    await this.updateProgress("analiz hazır — onay bekleniyor");
    await work.addComment(ticketKey, analysisComment(analysis.display));
    if (this.changeTypes.length > 0) {
      await work.addComment(ticketKey, this.changeTypesComment());
      this.deps.onJiraChanged?.();
    }
    this.deps.onJiraChanged?.();

    await this.generateAnalysisDocs(analysis.display);

    // Fan-out (M100): if the analysis found the work spans MORE THAN ONE
    // application, open one child ticket per impacted app so each has its own
    // tracked flow — a big work item is not squeezed into a single ticket.
    await this.fanOutImpactedApps(ticketKey, analysis.display);

    store.step("2", "tamam");
    return analysis.display;
  }

  /**
   * Resolve THIS run's agents from the matched listening rule (Faz 3).
   *
   * The variant ids come from the rule (`analystVariantId`/`engineerVariantId`)
   * with the boot defaults as fallback; the MODEL and PERSONA are then read
   * from the variant store PER RUN, so a Studio publish or a rule remap is live
   * on the next ticket, restart-free. The model is applied by building a
   * run-local gateway (`makeRunGateway` — the gateway's bindings are immutable
   * once built); the persona replaces the boot-resolved deps persona for this
   * run only.
   *
   * FAIL-SOFT: a variant store that errors mid-resolution must not kill a run
   * the boot gateway can still serve — the error is logged and the run falls
   * back to the boot-bound model/persona. No reader wired = the pre-Faz-3
   * behaviour exactly (deps persona + boot gateway), only the call LABELS carry
   * the (default) variant ids.
   */
  private async resolveRunAgents(rule: ListeningRule | null): Promise<void> {
    const { store } = this.deps;
    this.agents.analystVariantId = rule?.analystVariantId ?? PILOT_ANALYST_VARIANT;
    this.agents.engineerVariantId = rule?.engineerVariantId ?? PILOT_ENGINEER_VARIANT;

    const reader = this.deps.variantReader;
    if (reader === undefined) {
      if (rule?.analystVariantId !== undefined || rule?.engineerVariantId !== undefined) {
        store.log(
          "warn",
          "! dinleme kuralı bir ajan varyantı eşliyor ama varyant deposu bağlı değil — boot modeli/persona ile devam ediliyor",
        );
      }
      return;
    }

    try {
      const warn = (message: string): void => store.log("dim", `→ ${message}`);
      const analyst = await resolveVariantModel(this.agents.analystVariantId, reader, {
        fallbackModel: this.runSettings.model,
        warn,
      });
      const engineer = await resolveVariantModel(this.agents.engineerVariantId, reader, {
        fallbackModel: this.runSettings.model,
        warn,
      });

      // Persona per run, from the SAME variant the model came from. A reader
      // without persona support keeps the boot-resolved deps persona (the old
      // behaviour); a reader that answers null/empty means "no overlay".
      if (reader.activePersona !== undefined) {
        this.agents.analystPersona = await this.readRunPersona(reader, this.agents.analystVariantId);
        this.agents.engineerPersona = await this.readRunPersona(reader, this.agents.engineerVariantId);
      }

      // Apply the run-resolved models by building a run-local gateway (the
      // bindings of the boot gateway are immutable). Intake shares the analyst's
      // model — it is the analyst's first pass, same as boot.
      if (this.deps.makeRunGateway !== undefined) {
        this.runLlm = this.deps.makeRunGateway({
          intake: analyst.model,
          analyst: analyst.model,
          engineer: engineer.model,
        });
      }

      const tag = (source: "variant" | "env-fallback"): string =>
        source === "variant" ? "" : " · varsayılan model";
      store.log(
        "info",
        `🤖 analiz ajanı: ${this.agents.analystVariantId} (model ${analyst.model}${tag(analyst.source)})`,
      );
      store.log(
        "info",
        `🤖 mühendis ajanı: ${this.agents.engineerVariantId} (model ${engineer.model}${tag(engineer.source)})`,
      );
    } catch (error) {
      // The boot gateway still works — a broken variant store degrades to the
      // boot-bound model/persona rather than failing the ticket.
      this.runLlm = null;
      this.agents.analystPersona = this.deps.analystPersona;
      this.agents.engineerPersona = this.deps.engineerPersona;
      store.log(
        "warn",
        `! ajan varyantı çözülemedi (boot modeli/persona ile devam): ${String(error)}`,
      );
    }
  }

  /** One variant's persona for this run; a failed read means "no overlay". */
  private async readRunPersona(
    reader: VariantModelReader,
    variantId: string,
  ): Promise<string | undefined> {
    try {
      const persona = await reader.activePersona?.(variantId);
      const trimmed = persona?.trim() ?? "";
      return trimmed === "" ? undefined : trimmed;
    } catch {
      return undefined;
    }
  }

  /**
   * The reviewer-facing note for the special change types (B11) detected on
   * this run — one bullet per type, each naming the guardrail the reviewer
   * should check (DBA review for a migration, default-OFF for a flag, etc.).
   */
  private changeTypesComment() {
    return doc(
      paragraph([strong("🔧 Özel değişiklik türü tespit edildi")]),
      paragraph(
        "Aşağıdaki değişiklik türleri bu iş için ek dikkat gerektirir; mühendislik adımında bunlara özel kurallar uygulanır ve gözden geçirende ayrıca doğrulanmalıdır:",
      ),
      bulletList(this.changeTypes.map((c) => c.note)),
    );
  }

  /**
   * Open a child ticket per IMPACTED application beyond the primary one. Only
   * fires when the impact matrix names ≥2 distinct impacted apps — a single-app
   * change stays one ticket. Best-effort: a child that cannot be created is
   * logged and skipped, never fatal, and a Jira that has no "Alt görev" type
   * fails softly (the analysis still stands on the parent).
   */
  private async fanOutImpactedApps(ticketKey: TicketKey, analysis: AnalysisDoc): Promise<void> {
    const impacted = [
      ...new Set(analysis.impactMatrix.filter((c) => c.impacted).map((c) => c.appId)),
    ];
    // The primary app is the one the ticket is already bound to; children are the
    // OTHERS. Nothing to fan out to when only the primary (or none) is impacted.
    const primary = APPLICATION.appId;
    const extras = impacted.filter((appId) => appId !== primary);
    if (extras.length === 0) return;

    const projectKey = ticketKey.split("-")[0] ?? "";
    if (projectKey === "") return;

    this.deps.store.log("info", `🌿 fan-out: ${extras.length} etkilenen uygulama için alt-ticket açılıyor`);
    // Fan-out OWNERSHIP: children open ASSIGNED to the Maestro Bot (the same
    // account discovery follows), so each child immediately enters the bot's
    // queue instead of sitting unassigned. Empty botAccountId = unassigned, as
    // before.
    const childAssignee = (this.deps.botAccountId ?? "").trim();
    for (const appId of extras) {
      const cell = analysis.impactMatrix.find((c) => c.appId === appId && c.impacted);
      try {
        const child = await this.deps.work.createChildIssue({
          projectKey,
          parentKey: ticketKey,
          summary: `[${appId}] ${cell?.summary ?? analysis.purpose}`.slice(0, 240),
          description: `${ticketKey} analizinden türetildi. Etkilenen uygulama: ${appId}.\n\n${cell?.summary ?? ""}`,
          ...(childAssignee.length > 0 ? { assigneeAccountId: childAssignee } : {}),
        });
        this.deps.store.log("ok", `✓ alt-ticket açıldı: ${child.key} (${appId})`);
      } catch (error) {
        this.deps.store.log("warn", `! ${appId} için alt-ticket açılamadı: ${String(error)}`);
      }
    }
    this.deps.onJiraChanged?.();
  }

  /**
   * The CLARIFY gate's action (M98): post the intake role's open questions to the
   * ticket as ONE Turkish clarification comment and record the event, then let
   * the caller stop the flow. Uses the same live Jira comment path the analysis
   * comment uses, so the reporter sees the questions on the ticket they already
   * watch. `missing` comes straight from the real intake output — each entry is a
   * concrete, model-authored question, never an invented value.
   */
  private async requestClarification(
    ticketKey: TicketKey,
    missing: ReadonlyArray<{ field: string; why: string; question: string }>,
  ): Promise<void> {
    const { store, work } = this.deps;
    store.step("2", "onay", `netleştirme bekleniyor — ${missing.length} soru`);
    for (const item of missing) store.note("2", `soru: ${item.question}`);
    store.log("warn", `! intake: ticket analiz için yeterli değil — ${missing.length} netleştirme sorusu`);

    await this.updateProgress("netleştirme bekleniyor — ticket analiz için yeterli değil");
    await work.addComment(ticketKey, clarificationComment(missing));
    this.deps.onJiraChanged?.();

    // The trail records that the reporter was asked (M98). Actor is the system
    // worker (the same actor the flow's other automated events carry), so the
    // append is never refused for an unclassifiable actor.
    await this.record("CLARIFICATION_ASKED", {
      questionCount: missing.length,
      fields: missing.map((m) => m.field),
    });
    store.log("ok", "✓ netleştirme yorumu CANLI Jira'ya yazıldı — insan yanıtı bekleniyor");
  }

  /**
   * The İADE (return) action: hand an unfit ticket back to its reporter instead
   * of parking it in Maestro's court. Reassigns the ticket to the reporter's
   * accountId and moves it to a backlog/To-Do status, the transition chosen
   * DYNAMICALLY by destination category (never a hard-coded name — the driver's
   * `returnToReporter` reads each transition's `to.statusCategory`).
   *
   * FAIL-SOFT on purpose. A return is a CLEAN STOP, not a failure: if Jira
   * refuses the reassign or the transition (permissions, a workflow with no
   * To-Do edge, a transient error), the run must still end cleanly having at
   * least asked — it must NOT flip to `failure`. So every Jira error here is
   * caught and logged, mirroring how `attachAnalysisDocs` never throws into the
   * flow. The HANDOVER audit event is written only for what actually happened.
   *
   * The reporter accountId comes from `requesterAccountId` (seeded from
   * MAESTRO_REQUESTER_ACCOUNT_ID at boot, UI-param-ready). Empty → the reassign
   * is skipped and only the status is moved back, with a warning.
   */
  private async returnTicketToReporter(ticketKey: TicketKey): Promise<void> {
    const { store, work } = this.deps;
    const requester = (this.deps.requesterAccountId ?? "").trim();
    try {
      if (requester.length === 0) {
        // No reporter configured: still move the ticket back so it does not sit
        // in Maestro's court, but say plainly that it could not be reassigned.
        store.log(
          "warn",
          "! talep açan hesabı (requesterAccountId) tanımlı değil — ticket geri atanamadı, yalnız statüsü geri alınacak",
        );
        const transitions = await work.readAvailableTransitions(ticketKey);
        const target = selectReturnTransition(transitions);
        if (target === null) {
          store.log("dim", "→ geri alınacak (To Do) statü geçişi bulunamadı — ticket zaten geride");
          await this.record("HANDOVER", { reason: "intake_incomplete", reassigned: false, transitioned: false });
          return;
        }
        await work.applyTransition(ticketKey, target.id);
        store.log("ok", `✓ İADE: ticket '${target.toStatusName}' statüsüne geri alındı (atama yapılamadı)`);
        this.deps.onJiraChanged?.();
        await this.record("HANDOVER", {
          reason: "intake_incomplete",
          reassigned: false,
          transitioned: true,
          toStatus: target.toStatusName,
        });
        return;
      }

      const result = await work.returnToReporter(ticketKey, requester);
      const statusNote = result.transition
        ? `'${result.transition.toStatusName}' statüsüne geri alındı`
        : "geri alınacak (To Do) statü geçişi yok — statü değişmedi";
      store.log("ok", `✓ İADE: ticket talep açana geri atandı ve ${statusNote}`);
      store.note("2", `İADE: talep açana geri atandı${result.transition ? ` · ${result.transition.toStatusName}` : ""}`);
      this.deps.onJiraChanged?.();
      await this.record("HANDOVER", {
        reason: "intake_incomplete",
        reassigned: result.assigned,
        transitioned: result.transitioned,
        ...(result.transition ? { toStatus: result.transition.toStatusName } : {}),
      });
    } catch (error) {
      // A return failure must NOT sink the clean stop: the reporter was already
      // asked (the clarification comment is in). Log and carry on.
      store.log("warn", `! İADE tamamlanamadı (akış temiz durdu, netleştirme yazıldı): ${String(error)}`);
    }
  }

  /**
   * The analysis template THIS run's analyst validates against: the corporate
   * default with the ACTIVE Studio overlay applied (title + aiInstruction of
   * key-matched sections — see `applyTemplateOverlay`). Read lazily PER RUN so
   * a Studio publish is live on the next ticket, restart-free. FAIL-SOFT: a
   * loader error is logged and the default serves — a template read must never
   * kill an analysis. Overlay sections the engine has no slot for are logged
   * loudly rather than silently dropped.
   */
  private async resolveAnalysisTemplate(): Promise<AnalysisTemplate> {
    const { store } = this.deps;
    const loader = this.deps.analysisTemplateOverlay;
    let overlay: AnalysisTemplateOverlay | null = null;
    if (loader !== undefined) {
      try {
        overlay = await loader();
      } catch (error) {
        store.log("warn", `! Studio analiz şablonu okunamadı (varsayılan şablon kullanılacak): ${String(error)}`);
      }
    }
    const { template, unmatched } = applyTemplateOverlay(overlay);
    if (overlay !== null) {
      store.log("info", "📐 analiz şablonu Studio yayınıyla güncellendi (bölüm başlıkları + AI talimatları)");
    }
    for (const key of unmatched) {
      store.log("warn", `! şablonda eşleşmeyen bölüm: ${key} (motor yapısı sabit — bölüm eklenmedi)`);
    }
    return template;
  }

  /**
   * Render the analysis to a real `.docx` and `.pdf` and park them for download.
   *
   * This is the same analysis the reviewer reads in the Jira comment, rendered
   * through the publish package's real drivers — not a second summary. It runs
   * AFTER the comment so a rendering hiccup never blocks the delivery flow: the
   * files are a convenience, and the page simply does not show the buttons if
   * generation failed (the failure is logged, not swallowed into a stack trace).
   */
  private async generateAnalysisDocs(analysis: AnalysisDoc): Promise<void> {
    const { store, docs, work } = this.deps;
    const ticketKey = this.requireTicket();
    try {
      // The ACTIVE corporate Word template, read lazily from the composition
      // root's loader (DocTemplateVersion). Best-effort: a loader error only
      // means the built-in layout — never a failed document.
      let template: PilotDocTemplate | null = null;
      if (this.deps.docTemplate !== undefined) {
        try {
          template = await this.deps.docTemplate();
          if (template !== null) {
            store.log("info", `📐 kurumsal Word şablonu kullanılıyor: ${template.file.fileName} (v${template.file.version})`);
          }
        } catch (error) {
          store.log("warn", `! kurumsal şablon okunamadı (yerleşik düzen kullanılacak): ${String(error)}`);
        }
      }
      const generated = await analysisToDocs(analysis, ticketKey, this.runId, undefined, template);
      docs.put(this.runId, generated);
      store.update((state) => {
        state.docsReady = true;
      });
      store.log(
        "ok",
        `✓ analiz belgesi üretildi: ${generated.pdf.fileName} (${generated.pdf.bytes.byteLength} B) · ${generated.docx.fileName} (${generated.docx.bytes.byteLength} B)`,
      );
      // The documents exist — now attach them to the live ticket (M103r), so a
      // human no longer drags the Word/PDF in by hand. This runs AFTER the files
      // are parked for download, so a Jira hiccup here never costs the reviewer
      // the download buttons: `attachAnalysisDocs` is fail-soft and never throws.
      const result = await attachAnalysisDocs(
        work,
        ticketKey,
        generated,
        (kind, message) => store.log(kind, message),
      );
      if (result.attached) this.deps.onJiraChanged?.();
    } catch (error) {
      store.log("warn", `! analiz belgesi üretilemedi (akış etkilenmedi): ${String(error)}`);
    }
  }

  /**
   * ③ the analysis-approval gate (M51 gate "5"), resolved by polling comments.
   *
   * ONAY DEVRİ (approval hand-off) — the user's decision, wired in three moves:
   *   (a) BEFORE the gate opens, hand the ticket to the Analyst Manager: reassign
   *       it to the manager's accountId and move it into review ("İNCELEMEDE"),
   *       the transition chosen DYNAMICALLY (see sendAnalysisToReview).
   *   (b) On /approve by a group member, reassign the ticket BACK to the Maestro
   *       Bot (the code step is the bot's) and proceed to engineering.
   *   (c) On /reject, post an analysis-rejection note, hand the ticket back to the
   *       bot for re-analysis, and stop the flow CLEANLY (AnalysisRejectedError) —
   *       never fall through to the code/PR steps.
   */
  private async stepAnalysisGate(): Promise<void> {
    const { store } = this.deps;
    const approverGroup = this.runSettings.approverGroup;

    // (a) onay devri: hand the ticket to the Analyst Manager and move it into
    // review, so the approval physically sits in the manager's queue.
    await this.sendAnalysisToReview();

    await this.record("GATE_OPEN", { step: "5", group: approverGroup });
    store.step("3", "onay");
    store.log(
      "warn",
      `⏸ kapı açık — GERÇEK Jira'da yoruma /approve yazılmasını bekliyorum (grup: ${approverGroup})`,
    );

    let envelope;
    try {
      envelope = await this.awaitApproval("3");
    } catch (error) {
      // (c) manager rejected the analysis → note on the ticket + hand back to the
      // bot for re-analysis, then stop CLEANLY. Any other error propagates.
      if (error instanceof GateRejectedError) {
        await this.rejectAnalysisBackToBot(error.reason, error.author);
        throw new AnalysisRejectedError(
          `analiz reddedildi — not Jira'ya yazıldı ve ticket yeniden analiz için Maestro Bot'a geri atandı`,
        );
      }
      throw error;
    }

    // (b) approved. WHO gets the ticket depends on what runs next:
    //  · engineering will run → the code step is the bot's: reassign to the bot.
    //  · analiz-only flow (no engineering) → the analysis IS the deliverable.
    //    Reassigning to the bot here put the finished ticket straight back into
    //    assignment-based discovery, and the next boot RE-ANALYSED it (found
    //    live on OPS-15 — a token-burning loop). Deliver to the REQUESTER
    //    instead; the ticket leaves the bot's court for good.
    if (planFor(this.flow).engineering) {
      await this.returnTicketToBot("analysis_approved");
    } else {
      await this.deliverAnalysisToRequester();
    }
    store.step("3", "tamam", `onaylayan: ${envelope.author}`);
    store.log("ok", `✓ analiz onayı: ${envelope.author} · grup üyeliği doğrulandı`);
  }

  /**
   * ONAY DEVRİ move (a): hand the completed analysis to the Analyst Manager.
   * Reassigns the ticket to `managerAccountId` and moves it into review
   * ("İNCELEMEDE"), the review transition chosen DYNAMICALLY by the driver
   * (name-first, then In-Progress category — never a hard-coded id/name).
   *
   * FAIL-SOFT, deliberately: the analysis and its docs are already on the ticket
   * and the gate is about to open regardless, so a Jira hiccup here (a refused
   * assign, a workflow with no review edge) must NOT sink the run — it is logged,
   * a HANDOVER event is written for what actually happened, and the gate still
   * opens. An empty `managerAccountId` moves the status only, with a warning.
   */
  private async sendAnalysisToReview(): Promise<void> {
    const { store, work } = this.deps;
    const ticketKey = this.requireTicket();
    const manager = (this.deps.managerAccountId ?? "").trim();
    const reviewStatus = this.runSettings.reviewStatusName;
    try {
      if (manager.length === 0) {
        // No manager configured: still move the ticket into review so it does not
        // sit unassigned in the bot's court, but say plainly it was not reassigned.
        store.log(
          "warn",
          "! Analist Yönetici hesabı (managerAccountId) tanımlı değil — ticket yöneticiye atanamadı, yalnız statüsü taşınacak",
        );
        const transitions = await work.readAvailableTransitions(ticketKey);
        const target = selectReviewTransition(transitions, reviewStatus);
        if (target === null) {
          store.log("dim", "→ inceleme (İNCELEMEDE) statü geçişi bulunamadı — statü değişmedi");
          await this.record("HANDOVER", { reason: "analysis_review", reassigned: false, transitioned: false });
          return;
        }
        await work.applyTransition(ticketKey, target.id);
        store.log("ok", `✓ onay devri: ticket '${target.toStatusName}' statüsüne taşındı (atama yapılamadı)`);
        this.deps.onJiraChanged?.();
        await this.record("HANDOVER", {
          reason: "analysis_review",
          reassigned: false,
          transitioned: true,
          toStatus: target.toStatusName,
        });
        return;
      }

      const result = await work.sendToReview(ticketKey, manager, reviewStatus);
      const statusNote = result.transition
        ? `'${result.transition.toStatusName}' statüsüne taşındı`
        : "inceleme (İNCELEMEDE) statü geçişi yok — statü değişmedi";
      store.log("ok", `✓ onay devri: ticket Analist Yönetici'ye atandı ve ${statusNote}`);
      store.note("3", `onay devri: Analist Yönetici'ye atandı${result.transition ? ` · ${result.transition.toStatusName}` : ""}`);
      this.deps.onJiraChanged?.();
      await this.record("HANDOVER", {
        reason: "analysis_review",
        reassigned: result.assigned,
        transitioned: result.transitioned,
        ...(result.transition ? { toStatus: result.transition.toStatusName } : {}),
      });
    } catch (error) {
      store.log("warn", `! onay devri tamamlanamadı (akış etkilenmedi, kapı yine de açılıyor): ${String(error)}`);
    }
  }

  /**
   * ONAY DEVRİ move (b): reassign the ticket BACK to the Maestro Bot after the
   * manager approves (the code step runs as the bot). FAIL-SOFT — the approval
   * already passed, so a reassign hiccup only logs and records; the flow proceeds
   * to engineering either way. `reason` distinguishes the approve path from the
   * reject path on the HANDOVER event. Empty `botAccountId` skips the reassign.
   */
  private async returnTicketToBot(reason: string): Promise<void> {
    const { store, work } = this.deps;
    const ticketKey = this.requireTicket();
    const bot = (this.deps.botAccountId ?? "").trim();
    try {
      if (bot.length === 0) {
        store.log("warn", "! Maestro Bot hesabı (botAccountId) tanımlı değil — ticket bota geri atanamadı");
        await this.record("HANDOVER", { reason, reassigned: false });
        return;
      }
      await work.assign(ticketKey, bot);
      store.log("dim", "→ ticket Maestro Bot'a geri atandı (kod adımı bota ait)");
      this.deps.onJiraChanged?.();
      await this.record("HANDOVER", { reason, reassigned: true });
    } catch (error) {
      store.log("warn", `! bota geri atama tamamlanamadı (akış etkilenmedi): ${String(error)}`);
    }
  }

  /**
   * ANALİZ TESLİMİ: the analiz-only flow's terminal handover. The approved
   * analysis is the deliverable, so the ticket goes to the REQUESTER (who asked
   * for it), never back to the bot — a bot-assigned finished ticket re-enters
   * assignment-based discovery and gets re-analysed on the next boot. FAIL-SOFT:
   * the approval already happened; an assign hiccup logs and records only. An
   * empty requesterAccountId leaves the ticket with the manager (still not the
   * bot, so the loop still cannot happen).
   */
  private async deliverAnalysisToRequester(): Promise<void> {
    const { store, work } = this.deps;
    const ticketKey = this.requireTicket();
    const requester = (this.deps.requesterAccountId ?? "").trim();
    try {
      if (requester.length === 0) {
        store.log(
          "warn",
          "! talep sahibi hesabı (requesterAccountId) tanımlı değil — analiz teslimi için ticket yöneticide bırakıldı",
        );
        await this.record("HANDOVER", { reason: "analysis_delivered", reassigned: false });
        return;
      }
      await work.assign(ticketKey, requester);
      store.log("ok", "✓ analiz teslim edildi — ticket talep sahibine atandı (bot listesinden çıktı)");
      this.deps.onJiraChanged?.();
      await this.record("HANDOVER", { reason: "analysis_delivered", reassigned: true });
    } catch (error) {
      store.log("warn", `! analiz teslim ataması tamamlanamadı (akış etkilenmedi): ${String(error)}`);
    }
  }

  /**
   * ONAY DEVRİ move (c): the manager REJECTED the analysis. Post a Turkish
   * rejection note carrying the reason, then hand the ticket back to the Maestro
   * Bot for a fresh analysis. FAIL-SOFT on the Jira side (the note is the record
   * that matters); the caller turns this into a CLEAN stop (AnalysisRejectedError),
   * not a failure.
   */
  private async rejectAnalysisBackToBot(reason: string, author: string): Promise<void> {
    const { store, work } = this.deps;
    const ticketKey = this.requireTicket();
    store.step("3", "hata", `analiz reddedildi: ${reason}`);
    store.log("warn", `⏎ analiz reddedildi (Analist Yönetici): ${reason}`);
    // The rejection is recorded as a gate reject on the analysis gate, attributed
    // to the HUMAN who rejected it (the audit chain refuses GATE_REJECT for a
    // system actor — a gate decision must carry a person, like GATE_APPROVE).
    await this.record(
      "GATE_REJECT",
      { step: "5", reason },
      corpAccountOf(author, this.runSettings.operatorAccount),
    );
    try {
      await this.updateProgress("analiz reddedildi — yeniden analiz için ticket bota geri atandı");
      await work.addComment(ticketKey, analysisRejectionComment(reason));
      this.deps.onJiraChanged?.();
    } catch (error) {
      store.log("warn", `! analiz-red notu yazılamadı (akış temiz durdu): ${String(error)}`);
    }
    await this.returnTicketToBot("analysis_rejected");
    store.log("ok", "✓ analiz-red notu CANLI Jira'ya yazıldı ve ticket yeniden analiz için bota geri atandı");
  }

  private githubMode(): boolean {
    return this.deps.scmMode === "github";
  }

  /** The Application Registry record the ScmPort resolves; owner/repo on github. */
  private application(): ApplicationRecord {
    if (this.githubMode() && this.deps.github) {
      return { ...APPLICATION, adoProject: this.deps.github.owner, adoRepo: this.deps.github.repo };
    }
    return APPLICATION;
  }

  /** ④ + ⑤ + ⑥ — engineering, scan and the test that really runs. */
  private async stepEngineering(
    analysis: AnalysisDoc,
    // Human review feedback from a REVISE round (PR comments). When present it
    // seeds the engineer's `feedback` so the first attempt already addresses the
    // reviewer's notes, rather than re-generating the same code that was rejected.
    reviewFeedback: string | null = null,
  ): Promise<CodeDraft> {
    const { store, scm } = this.deps;
    const ticketKey = this.requireTicket();
    const github = this.githubMode();
    store.step("4", "calisiyor");

    const baseBranch = github ? GITHUB_TARGET_BRANCH : "main";
    const repo = await scm.resolveRepo(this.application());
    store.log(
      "ok",
      github
        ? `✓ GitHub deposu çözüldü (GERÇEK): ${repo.project}/${repo.repo}`
        : `✓ ADO deposu çözüldü (sahte): ${repo.project}/${repo.repo}`,
    );
    const branch = github ? `feature/${ticketKey}` : `feature/${ticketKey}-pilot`;
    await scm.createBranch(repo, branch, github ? baseBranch : "refs/heads/main");
    store.log("ok", github ? `✓ dal açıldı (GERÇEK): ${branch}` : `✓ dal açıldı: ${branch}`);
    store.note("4", `dal: ${branch}`);
    this.repo = repo;
    this.branch = branch;

    // Open the workspace. When a permanent sandbox KÖK is configured (from the
    // UI settings, seeded by env at bootstrap), the workspace is an ISOLATED
    // subdirectory `<root>/<ticketKey>/` under that stable root — each ticket
    // gets its own space + its own AI context/cache, and dispose() removes only
    // that subdir, never the root. When it is empty the workspace stays a
    // throwaway mkdtemp dir (legacy). Any injected `exec` (tests) is preserved;
    // an injected `persistentRoot` in workspaceOptions (a test overriding the
    // root directly) wins over the settings value.
    const baseWorkspaceOptions = this.deps.workspaceOptions ?? {};
    const sandboxRoot = this.runSettings.sandboxRoot.trim();
    const persistentRoot =
      baseWorkspaceOptions.persistentRoot ?? (sandboxRoot.length > 0 ? sandboxRoot : undefined);
    this.workspace = await createWorkspace({
      ...baseWorkspaceOptions,
      ...(persistentRoot !== undefined ? { persistentRoot, ticketKey } : {}),
    });
    // The workspace is open: record it so the Studio sandbox screen shows this
    // run's live workspace, and (paired with the SANDBOX_DESTROY on the way out)
    // so the trail carries the workspace's whole lifetime (M60).
    await this.recordSandbox("SANDBOX_CREATE");
    const profile = compiledProfileFor(this.deps.piiPolicy, this.effectiveDataClass()).profile;

    // On the github path the repo is cloned NOW, BEFORE any code is written, so
    // the model's files land INSIDE the git working tree (the workspace flips
    // its codeDir to the clone). Otherwise the write goes to the workspace root
    // while git commits an empty clone → "nothing to commit, working tree
    // clean". One short-lived credential (M31) covers both the clone and the
    // later push — clone→…→push happen seconds apart within this one run.
    let pushCredential: PushCredential | null = null;
    if (github) pushCredential = await this.cloneForGithub(branch, baseBranch);

    // The knowledge library ("öğren"): the operator's uploaded coding standards,
    // patterns and house rules. These already shape the ANALYSIS; feeding them
    // to the ENGINEER too means the WRITTEN CODE follows the same house rules —
    // "use parameterised queries", "prefer this pattern" — instead of the model
    // guessing the corporate style each time. Empty when nothing is uploaded, so
    // the engineer behaves exactly as before on a bare project.
    // Ajan-hedefli bilgi: global notlar + yalnız bu run'ın MÜHENDİS variant'ına
    // hedeflenmiş notlar (analiste yüklenen belge mühendise sızmaz, tersi de).
    const guidanceNotes = this.deps.guidance?.forVariant(this.agents.engineerVariantId) ?? [];
    const guidanceRules = guidanceNotes.map((g) => `Kurum bilgisi — ${g.title}: ${g.content}`);
    if (guidanceRules.length > 0) {
      store.log("info", `📚 mühendis ${guidanceRules.length} kurum bilgi/standart notunu dikkate alıyor.`);
    }
    // The engineer's Studio persona (if configured) leads its rules, so an admin
    // editing the engineer agent's persona actually changes how code is written.
    const personaRules =
      this.agents.engineerPersona !== undefined
        ? [`Ajan talimatı (persona): ${this.agents.engineerPersona}`]
        : [];
    if (this.agents.engineerPersona !== undefined) {
      store.log("info", "🧠 mühendis Studio'da tanımlı persona ile çalışıyor.");
    }

    // Seed with the reviewer's notes on a REVISE round, so attempt 1 already
    // addresses them (the same `oncekiHata` channel the self-heal loop uses).
    let feedback: string | null = reviewFeedback;
    let previousCode: CodeDraft | null = null;
    let lastError = "";
    for (let attempt = 1; attempt <= MAX_ENGINEER_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        store.step("4", "calisiyor", `düzeltme turu ${attempt}`);
        store.log("warn", `↻ mühendis düzeltme turu ${attempt}: ${lastError}`);
      }
      const draft = await this.think<CodeDraft>("engineer", "CodeDraft", CodeDraft, {
        gorev: "Aşağıdaki analize göre küçük ve çalışır bir modül + testini yaz.",
        dil: "tr",
        analiz: {
          amac: analysis.purpose,
          kabulKriterleri: analysis.acceptanceCriteria,
          testYaklasimi: analysis.testApproach,
        },
        dosyalar: { uygulama: IMPLEMENTATION_PATH, test: TEST_PATH },
        kurallar: [
          "Her iki dosya da ESM'dir (.mjs): require() KULLANMA, yalnız import kullan.",
          "implementation: saf ESM JavaScript modülü, dışa `export` ile açılır, yalnız node: yerleşiklerini kullanabilir.",
          `test: '${TEST_PATH}' dosyasının içeriği; uygulamayı "import { ... } from '../src/impl.mjs'" ile alır.`,
          "test dosyası \"import assert from 'node:assert/strict'\" kullanır ve başarılıysa konsola 'OK' yazar.",
          "Test kendi kendine yeterli olmalı; ağ, dosya sistemi, zamanlayıcı kullanma.",
          "Kodun ve testin içine e-posta adresi, telefon, TCKN, IBAN veya kart numarası YAZMA — örnek/sahte olanları bile. '@' işareti geçen metin kullanma.",
          "summary: 1-2 cümle Türkçe özet.",
          "Markdown kod bloğu (```) kullanma; alanlar düz metin olacak.",
          // B11: special-change-type guardrails. Empty for an ordinary change;
          // a migration/flag/config/dependency ticket adds its specific rules
          // (idempotent + rollback, default-OFF, safe defaults, pinned version).
          ...this.changeTypes.flatMap((c) => c.rules),
          // The engineer agent's Studio persona (its role instruction), read
          // first so it frames everything below. Empty when none is configured.
          ...personaRules,
          // The corporate knowledge library ("öğren"): the same notes the analyst
          // leans on, now binding the engineer's code to the house rules. Empty
          // when nothing is uploaded.
          ...guidanceRules,
        ],
        ...(feedback === null ? {} : { oncekiHata: feedback }),
        ...(previousCode === null ? {} : { oncekiKod: previousCode }),
      });

      const code: CodeDraft = {
        summary: draft.masked.summary,
        implementation: stripFences(draft.masked.implementation),
        test: stripFences(draft.masked.test),
      };
      previousCode = code;
      // On the github path `write` now targets the CLONE (workspace.codeDir was
      // flipped by cloneForGithub), so the model's files land inside the git
      // working tree and there is a real diff to commit.
      // TODO (deeper feature, next wave): the model writes to a FIXED path
      // (src/impl.mjs) — a NEW file. Matching its change to the repo's ACTUAL
      // files (real edits, not a new file) needs the engineer to see the repo.
      await this.workspace.write(IMPLEMENTATION_PATH, code.implementation);
      await this.workspace.write(TEST_PATH, code.test);
      store.log("ok", `✓ engineer: ${IMPLEMENTATION_PATH} + ${TEST_PATH} yazıldı`);
      store.note("4", draft.display.summary);
      store.step("4", "tamam");

      // ---- ⑤ scan (fail-closed)
      store.step("5", "calisiyor");
      const counts = scanForPii({ implementation: code.implementation, test: code.test }, profile);
      if (counts.occurrences > 0) {
        const types = Object.keys(counts.byType).join(", ");
        lastError = `üretilen kodda kişisel veri bulundu (${types}); temizlenmeli`;
        feedback = lastError;
        store.step("5", "hata", lastError);
        await this.record("SECURITY_SCAN_FAIL", { occurrences: counts.occurrences });
        store.log("err", `✗ tarama: ${lastError}`);
        continue;
      }
      await this.record("SECURITY_SCAN_PASS", { scanner: "pii", files: 2 });
      store.step("5", "tamam", "kişisel veri bulunmadı (0 bulgu)");
      store.log("ok", "✓ tarama: kişisel veri sızıntısı yok");

      // ---- ⑥ the test really runs
      store.step("6", "calisiyor");
      const run = await this.workspace.runTest();
      await this.record("TEST_RUN_COMPLETE", {
        passed: run.ok,
        exitCode: run.exitCode ?? -1,
        durationMs: run.durationMs,
      });
      if (!run.ok) {
        lastError = (run.stderr || run.stdout || "test çıkış kodu != 0").split("\n").slice(0, 6).join(" | ");
        feedback = lastError;
        store.step("6", "hata", lastError);
        store.log("err", `✗ test koştu ve DÜŞTÜ (${run.durationMs} ms): ${lastError}`);
        continue;
      }
      store.step("6", "tamam", `çıkış kodu 0 · ${run.durationMs} ms`);
      store.log(
        "ok",
        `✓ test gerçekten koştu: çıkış kodu 0 (${run.durationMs} ms) ${run.stdout ? `· ${run.stdout.split("\n")[0]}` : ""}`,
      );

      // On the github path the green code is pushed FOR REAL now: the code was
      // already written into the CLONE (codeDir points there), so `git add` sees
      // a real diff. The PR in the next step must have a real branch behind it.
      // A push failure fails the step CLOSED — no false "PR opened" (the
      // exception propagates out of start(), which records the run as failed).
      if (github) await this.pushToGithub(code, pushCredential!);

      return code;
    }

    throw new PilotStepError(
      `kod/tarama/test döngüsü ${MAX_ENGINEER_ATTEMPTS} turda yeşile dönmedi — son hata: ${lastError}`,
    );
  }

  /**
   * The CLONE half of the github git path (github path only). Mints ONE
   * short-lived push credential (M31) and clones the base branch into the
   * workspace, checking out the feature branch — this runs BEFORE any code is
   * written so the model's files land inside the git working tree (the
   * workspace flips its `codeDir` to the clone). Without this the write would go
   * to the workspace root while git commits an empty clone → "nothing to commit,
   * working tree clean", which is the exact end-to-end bug this fixes.
   *
   * Returns the credential so the later `pushToGithub` can reuse it for the push
   * (clone and push are seconds apart within one run, well inside the TTL). The
   * token is handed to the workspace which feeds it to git out-of-band (env-only
   * `http.extraHeader`) — it never lands on an argv, in `.git/config`, or a log.
   *
   * Fails CLOSED: a `getPushCredential` refusal or a clone error throws, so the
   * flow never reaches the write/test/push over a broken working tree.
   */
  private async cloneForGithub(branch: string, baseBranch: string): Promise<PushCredential> {
    const { store, scm, github } = this.deps;
    const repo = this.repo;
    const ws = this.workspace;
    if (repo === null || ws === undefined || ws === null) {
      throw new PilotStepError("klon için depo/çalışma alanı hazır değil");
    }
    if (github === undefined) throw new PilotStepError("github yapılandırması eksik");

    // Short-lived credential (M31): the driver refuses a TTL over its ceiling
    // and refuses a credential that outlives the window (fail-closed).
    const credential = await scm.getPushCredential(repo, GITHUB_PUSH_TTL_SECONDS);
    store.log("dim", `→ kısa ömürlü push kimliği alındı (geçerlilik: ${credential.expiresAt})`);

    await ws.gitClone({
      remoteUrl: github.remoteUrl,
      branch,
      baseBranch,
      token: credential.token,
      authorName: AI_AUTHOR_NAME,
      authorEmail: AI_AUTHOR_EMAIL,
    });
    store.log("dim", `→ depo klonlandı ve '${branch}' dalı açıldı — kod klon içine yazılacak`);
    return credential;
  }

  /**
   * The COMMIT/PUSH half of the github git path (github path only). The green
   * code was already written INTO the clone (codeDir points at the working
   * tree), so `git add --all` sees a real diff. Runs add→commit→push over the
   * injected exec runner, reusing the credential minted in `cloneForGithub`.
   * `branch` was already created on GitHub via the API in stepEngineering; the
   * push updates that ref.
   *
   * Fails CLOSED: any git error throws, and the PR step never runs, so the
   * workflow cannot claim a PR over an unpushed branch.
   */
  private async pushToGithub(code: CodeDraft, credential: PushCredential): Promise<void> {
    const { store } = this.deps;
    const ticketKey = this.requireTicket();
    const ws = this.workspace;
    if (ws === undefined || ws === null) {
      throw new PilotStepError("push için çalışma alanı hazır değil");
    }

    const commitSubject = `[AI] ${ticketKey} ${code.summary}`.slice(0, 72);
    const pushed = await ws.gitCommitPush({
      branch: this.branch,
      commitSubject,
      // M13: an AI-authored commit is attributed and co-signed.
      coAuthor: `Co-Authored-By: Maestro <${AI_AUTHOR_EMAIL}>`,
      token: credential.token,
      authorName: AI_AUTHOR_NAME,
      authorEmail: AI_AUTHOR_EMAIL,
    });
    this.pushedCommitSha = pushed.commitSha;
    store.log("ok", `✓ kod GERÇEK push edildi · commit ${pushed.commitSha.slice(0, 8)} · dal ${this.branch}`);
    // No dedicated push action exists in the FROZEN AuditAction enum; the pushed
    // commit sha is recorded on the PR_OPENED event in stepPullRequest instead.
  }

  /**
   * ⑦ pull request. On the github path the PR is opened FOR REAL against the
   * live repo (over the branch just pushed). The CI signal, however, still
   * arrives from the fake ADO Service Hook — real GitHub checks/Actions is C3,
   * not done here — so once the real PR is open its id is handed to the fake CI
   * publisher (`onRealPrOpened`) which emits a `build.complete` for that id.
   */
  private async stepPullRequest(draft: CodeDraft, analysis: AnalysisDoc): Promise<number> {
    const { store, scm } = this.deps;
    const ticketKey = this.requireTicket();
    const github = this.githubMode();
    const repo = this.repo;
    if (repo === null) throw new PilotStepError("depo çözülmeden PR açılamaz");
    store.step("7", "calisiyor");

    const { prId } = await scm.openPr(repo, {
      sourceBranch: this.branch,
      targetBranch: github ? GITHUB_TARGET_BRANCH : "main",
      title: `[AI] ${ticketKey} ${analysis.purpose.slice(0, 60)}`,
      // A structured PR body so a human reviewer sees WHAT/WHY/RISK and can reach
      // the ticket and the analysis at once — not a two-line stub. The ticket URL
      // makes the PR↔Jira link machine-followable.
      description: this.buildPrDescription(ticketKey, draft, analysis),
      draft: true,
    });
    store.log("ok", github ? `✓ PR #${prId} taslak olarak açıldı (GERÇEK GitHub)` : `✓ PR #${prId} taslak olarak açıldı (sahte ADO)`);
    await this.record("PR_OPENED", {
      prId,
      branch: this.branch,
      ...(this.pushedCommitSha ? { commitSha: this.pushedCommitSha } : {}),
    });

    await scm.activatePr(repo, prId);
    store.log("dim", `→ PR #${prId} taslaktan çıktı — build validation kuyruğa alındı`);

    const threads = await scm.listPrThreads(repo, prId);
    store.note("7", `PR #${prId} · açık inceleme yorumu: ${threads.length}`);

    // CI (B14): on the github path with a pushed commit and a driver that can
    // read real checks, WAIT ON GITHUB CHECKS — the actual build/test results
    // for the head commit. Otherwise fall back to the fake ADO build signal
    // (the demo/test path): trigger the fake build for the real PR id now that
    // it is out of draft, and wait on its webhook.
    const canRealCi = github && this.pushedCommitSha !== null && typeof scm.getCommitChecks === "function";
    let green: boolean;
    if (canRealCi) {
      green = await this.awaitRealCi(repo, this.pushedCommitSha as GitSha, prId);
    } else {
      if (github) this.deps.onRealPrOpened?.(prId, `refs/heads/${this.branch}`);
      green = await this.awaitCi(prId);
    }
    if (!green) {
      store.step("7", "hata", "CI kırmızı");
      throw new PilotStepError(`CI build'i başarısız döndü (PR #${prId})`);
    }
    store.step("7", "tamam", `CI yeşil · PR #${prId}`);
    return prId;
  }

  /** ⑧ human gate on the pull request (M51 gate "12") — polled on real Jira. */
  private async stepPrGate(prId: number): Promise<void> {
    const { store, work } = this.deps;
    const ticketKey = this.requireTicket();
    await work.addComment(
      ticketKey,
      doc(
        heading(3, "✅ PR hazır"),
        paragraph([text("Pull request "), strong(`#${prId}`), text(" açıldı, testler ve CI yeşil.")]),
        paragraph([text("Onay için bu ticket'a "), inlineCode("/approve"), text(" yorumu yazın.")]),
      ),
    );
    this.deps.onJiraChanged?.();
    await this.record("GATE_OPEN", { step: "12", prId });
    store.step("8", "onay");
    store.log("warn", `⏸ ikinci kapı açık — GERÇEK Jira'da PR #${prId} onayı bekleniyor`);
    const envelope = await this.awaitApproval("8");
    store.step("8", "tamam", `onaylayan: ${envelope.author}`);
    store.log("ok", `✓ PR onayı: ${envelope.author}`);
  }

  /** ⑨ merge + closure. Human-merge by default; auto-merge only when armed (B14). */
  private async stepMerge(prId: number): Promise<void> {
    const { store, work, scm } = this.deps;
    const ticketKey = this.requireTicket();
    const repo = this.repo;
    if (repo === null) throw new PilotStepError("depo yok");
    store.step("9", "calisiyor");

    // AUTO-MERGE (B14) is armed ONLY when every guard holds: the setting is on,
    // this is the github path (a real repo), and the driver can actually merge.
    // The PR gate was already approved (stepPrGate) and CI was already green
    // (stepOpenPr) before we ever reach here, so those two invariants hold by
    // construction. When armed, Maestro performs the merge itself; otherwise it
    // WAITS for a human to merge — the default, unchanged behaviour.
    const autoMergeArmed =
      this.runSettings.autoMerge && this.githubMode() && typeof scm.mergePr === "function";

    let mergeSha: string | null;
    if (autoMergeArmed) {
      store.log("warn", `⚙ otomatik birleştirme AÇIK — Maestro PR #${prId}'i gerçek olarak birleştiriyor…`);
      const result = await (scm.mergePr as NonNullable<ScmPort["mergePr"]>).call(scm, repo, prId);
      mergeSha = result.mergeSha;
      store.log("ok", `✓ Maestro birleştirdi (GERÇEK) · commit ${mergeSha.slice(0, 8)}`);
    } else {
      // Human-merge: wait for the merge to happen out-of-band. On the fake path
      // the merge + status come from the fake ADO driver; on the github path
      // (auto-merge off) a human merges the real PR and getPrStatus confirms it.
      const mergeStatus = this.deps.mergeStatus ?? scm;
      const merged = this.deps.completePullRequest(prId);
      store.log(
        "dim",
        merged
          ? "→ PR'ı bir insan birleştirdi — Maestro merge etmez (varsayılan)"
          : "→ PR zaten birleşmişti",
      );
      const statusRepo = this.deps.mergeStatus ? await mergeStatus.resolveRepo(APPLICATION) : repo;
      const deadline = Date.now() + 10_000;
      let status = await mergeStatus.getPrStatus(statusRepo, prId);
      while (status.state !== "completed" && Date.now() < deadline) {
        await sleep(this.deps.mergePollMs ?? 300);
        status = await mergeStatus.getPrStatus(statusRepo, prId);
      }
      if (status.state !== "completed") {
        throw new PilotStepError(`PR #${prId} birleşmedi (durum: ${status.state})`);
      }
      mergeSha = status.mergeSha;
      store.log("ok", `✓ merge doğrulandı · commit ${mergeSha?.slice(0, 8) ?? "?"}`);
    }
    await this.record("PR_MERGED", { prId, mergeSha: mergeSha ?? null, auto: autoMergeArmed });

    // Close the Jira ticket: move it to a Done-category status so the work does
    // not sit open after it is merged. Selection is by CATEGORY (a site may
    // rename "Done"), and a workflow that offers no Done transition is not an
    // error — the merge already succeeded, this is bookkeeping.
    let closedStatus: string | null = null;
    try {
      const transitions = await work.readAvailableTransitions(ticketKey);
      const done = selectDoneTransition(transitions);
      if (done !== null) {
        await work.applyTransition(ticketKey, done.id);
        closedStatus = done.toStatusName;
        store.log("ok", `✓ ticket '${done.toStatusName}' statüsüne kapatıldı`);
      } else {
        store.log("dim", "→ 'Tamamlandı' statü geçişi bulunamadı — ticket statüsü elle kapatılmalı");
      }
    } catch (error) {
      store.log("warn", `! ticket kapatma statüsü uygulanamadı: ${String(error)}`);
    }

    // Tidy the feature branch so merged branches do not pile up. Best-effort:
    // the branch may already be gone (auto-delete-on-merge), and a failure here
    // must never turn a successful merge into a failed run.
    await this.deleteMergedBranch();

    await this.updateProgress("tamamlandı — PR birleşti");
    await work.addComment(
      ticketKey,
      doc(
        heading(3, "🎉 Tamamlandı"),
        paragraph(
          `${ticketKey} için PR #${prId} birleşti${closedStatus !== null ? ` ve ticket '${closedStatus}' statüsüne alındı` : ""}. Analiz, kod, test ve onay zinciri kayıt altında.`,
        ),
        // The product boundary, stated plainly so nobody assumes it went live:
        // Maestro stops at merge; deploy/release is the institution's own process.
        paragraph(
          "Not: Maestro burada durur. Prod'a çıkış (deploy/release) kurumun kendi sürecidir — Maestro üretime bir şey dağıtmaz.",
        ),
      ),
    );
    this.deps.onJiraChanged?.();
    await this.record("RUN_CLOSED", { prId, closedStatus });
    store.step("9", "tamam");
  }

  /**
   * Delete the run's feature branch after merge. Reached only on the real SCM
   * path (a branch was pushed); on the fake path there is nothing to delete.
   * Every failure is swallowed — a merged PR is done regardless of whether the
   * source branch could be removed.
   */
  private async deleteMergedBranch(): Promise<void> {
    if (this.repo === null || this.branch === "") return;
    const scm = this.deps.scm;
    if (typeof scm.deleteBranch !== "function") return;
    try {
      await scm.deleteBranch(this.repo, this.branch);
      this.deps.store.log("dim", `→ dal temizlendi: ${this.branch}`);
    } catch (error) {
      this.deps.store.log("dim", `→ dal silinemedi (${this.branch}): ${String(error)}`);
    }
  }

  /**
   * Gather the reviewer's change requests into one feedback string for a revise
   * round: the reject reason (from the Jira /reject comment) plus every open PR
   * review thread's comments. Best-effort on the PR threads — if they cannot be
   * read, the reject reason alone still drives the revision.
   */
  private async collectReviewFeedback(prId: number, rejectReason: string): Promise<string> {
    const parts: string[] = [];
    if (rejectReason.trim().length > 0) parts.push(`Ret gerekçesi: ${rejectReason.trim()}`);
    try {
      if (this.repo !== null) {
        const threads = await this.deps.scm.listPrThreads(this.repo, prId);
        for (const thread of threads) {
          for (const c of thread.comments) {
            if (c.text.trim().length > 0) parts.push(`PR yorumu (${c.author}): ${c.text.trim()}`);
          }
        }
      }
    } catch {
      // PR threads unreadable — the reject reason alone is enough to revise.
    }
    return parts.length > 0
      ? `İnceleyen aşağıdaki değişiklikleri istedi; kodu buna göre düzelt:\n${parts.join("\n")}`
      : "İnceleyen değişiklik istedi (ayrıntı yok); kodu gözden geçirip iyileştir.";
  }

  /**
   * A structured PR body: what changed, why (the analysis), the risk, and links
   * back to the Jira ticket. Markdown, because GitHub renders it; a reviewer
   * sees the context without leaving the PR. The body states plainly that the AI
   * wrote it and a human must approve — the review is not a rubber stamp.
   */
  private buildPrDescription(ticketKey: TicketKey, draft: CodeDraft, analysis: AnalysisDoc): string {
    const site = this.deps.store.snapshot().jiraSite;
    const ticketUrl = site ? `${site}/browse/${ticketKey}` : ticketKey;
    // B11: surface any special change type so the reviewer sees the extra care
    // up front (a migration/flag/config/dependency line), not buried in the diff.
    const changeTypeLines =
      this.changeTypes.length > 0
        ? ["", "**Özel değişiklik türü:**", ...this.changeTypes.map((c) => `- ${c.note}`)]
        : [];
    return [
      `## ${ticketKey}`,
      "",
      `**Ne yapıldı:** ${draft.summary}`,
      "",
      `**Amaç:** ${analysis.purpose}`,
      "",
      `**Risk:** ${analysis.riskTier} — ${analysis.riskReason}`,
      ...changeTypeLines,
      "",
      `**Jira ticket:** [${ticketKey}](${ticketUrl})`,
      "",
      "---",
      "> Bu değişikliği Maestro'nun yapay zekâ ajanı yazdı; analiz, test ve güvenlik taraması kayıt altında. **İnceleyip onaylayan bir insan olmalıdır** — merge kurumun kendi sürecidir.",
    ].join("\n");
  }

  /**
   * Read the ticket's attachments for the analyst. Text attachments (txt/md/json)
   * are downloaded and their content included (capped, so a huge log does not
   * blow the prompt); images/PDFs are named but not parsed. Best-effort: an
   * attachment that cannot be listed or downloaded is skipped, never fatal — the
   * analysis proceeds with whatever context was available.
   */
  private async readTicketAttachments(
    ticketKey: TicketKey,
  ): Promise<readonly { name: string; kind: string; content: string | null }[]> {
    const MAX_TEXT_BYTES = 20_000;
    let metas: readonly { filename: string; mimeType: string; size: number; contentUrl: string }[];
    try {
      metas = await this.deps.work.readAttachments(ticketKey);
    } catch (error) {
      this.deps.store.log("dim", `→ ekler okunamadı: ${String(error)}`);
      return [];
    }

    const out: { name: string; kind: string; content: string | null }[] = [];
    for (const meta of metas) {
      const text = isTextAttachment(meta.mimeType) && meta.size <= MAX_TEXT_BYTES;
      let content: string | null = null;
      if (text && typeof this.deps.work.downloadAttachment === "function") {
        try {
          content = await this.deps.work.downloadAttachment(meta.contentUrl);
        } catch {
          content = null; // named but unreadable — still useful to the analyst
        }
      }
      out.push({ name: meta.filename, kind: meta.mimeType, content });
    }
    return out;
  }

  /**
   * The ticket's recent HUMAN comments for the intake/analysis context
   * (clarify-resume lite). Reads the same comment list the gate poller reads,
   * then filters out what is NOT a human answer: the bot's own comments
   * (author = botAccountId — the progress/analysis/clarification notes Maestro
   * itself wrote) and command envelopes (a first line starting with `/`, e.g.
   * `/approve` — those are gate commands, not context). Only the LAST 10
   * survive, newest last, so a chatty ticket cannot blow the prompt.
   * Best-effort: an unreadable comment list yields [] — the flow proceeds on
   * the ticket alone, exactly as before.
   */
  private async readHumanComments(ticketKey: TicketKey): Promise<TicketComment[]> {
    const MAX_COMMENTS = 10;
    const MAX_TEXT = 2_000;
    let raw: unknown[];
    try {
      raw = await this.deps.work.listComments(ticketKey);
    } catch (error) {
      this.deps.store.log("dim", `→ ticket yorumları okunamadı: ${String(error)}`);
      return [];
    }
    const bot = (this.deps.botAccountId ?? "").trim();
    const out: TicketComment[] = [];
    for (const comment of raw) {
      const resource =
        typeof comment === "object" && comment !== null && !Array.isArray(comment)
          ? (comment as Record<string, unknown>)
          : null;
      if (resource === null) continue;
      const author = cloudUserIdOf(resource["author"]) ?? "";
      if (author.length === 0) continue;
      if (bot.length > 0 && author === bot) continue; // Maestro's own notes
      const body = resource["body"];
      const bodyText = isAdfDoc(body) ? adfToPlainText(body) : typeof body === "string" ? body : "";
      const trimmed = bodyText.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith("/")) continue; // command envelope (/approve, /reject, …)
      out.push({ author, text: trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}…` : trimmed });
    }
    return out.slice(-MAX_COMMENTS);
  }

  // ---------------------------------------------------- gate: comment polling

  /**
   * A gate. The demo waited on a webhook; the pilot POLLS the live ticket's
   * comments until a /approve or /reject from a group member arrives. The M105
   * rules (only a plain, never-edited top-level command counts) and de-dup live
   * in the driver + poll.ts; membership / SoD is checked HERE, fail-closed.
   */
  private async awaitApproval(step: string): Promise<CommandEnvelope> {
    const { store, work } = this.deps;
    const ticketKey = this.requireTicket();
    const approverGroup = this.runSettings.approverGroup;
    const signal = this.abort?.signal ?? new AbortController().signal;
    const seen = new Set<string>();
    // STALE-APPROVAL GUARD: baseline the gate — every comment that already
    // exists is marked seen, so only a command written AFTER this gate opened
    // can resolve it. Without this, an old /approve from a previous run on the
    // same ticket approved the new gate instantly (found live on OPS-15).
    // Fail-closed: if the baseline cannot be read, the gate must not open.
    try {
      const baselined = await markExistingCommentsSeen(work, ticketKey, seen);
      if (baselined > 0) store.log("dim", `→ kapı tabanı: ${baselined} mevcut yorum sayılmayacak (yalnız yenileri)`);
    } catch (error) {
      throw new PilotStepError(`kapı açılamadı — mevcut yorum tabanı okunamadı: ${String(error)}`);
    }

    // İŞ ATAMA USULÜ ONAYI: yorum komutuna ek olarak, kapı açıkken bir insanın
    // ticket'ı Maestro Bot'a GERİ ATAMASI da onay sayılır (gerçek Jira alışkanlığı:
    // insanlar komut yazmaz, işi atar). Aynı bayat-koruma ilkesi: kapı açılırken
    // mevcut changelog girdileri tabana alınır, yalnız SONRAKİ atama sayılır.
    // FAIL-SOFT: changelog okunamazsa (eski fake'ler dahil) yalnız yorum yolu
    // çalışır — atama kanalı hiçbir zaman kapıyı kıramaz.
    const bot = (this.deps.botAccountId ?? "").trim();
    const assignSeen = new Set<string>();
    if (bot.length !== 0) {
      try {
        for (const change of await work.listAssigneeChanges(ticketKey)) assignSeen.add(change.id);
      } catch {
        store.log("dim", "→ atama tabanı okunamadı — bu kapıda yalnız yorum onayı geçerli");
      }
    }
    const pollAssignmentApproval = async (): Promise<CommandEnvelope | null> => {
      if (bot.length === 0) return null;
      try {
        for (const change of await work.listAssigneeChanges(ticketKey)) {
          if (assignSeen.has(change.id)) continue;
          assignSeen.add(change.id);
          if (change.toAccountId !== bot) continue; // başka atamalar kapıyı ilgilendirmez
          if (change.actorAccountId === bot) continue; // botun kendi ataması onay değildir
          store.log("info", `→ iş atama usulü: ticket ${change.actorAccountId} tarafından bota atandı — onay olarak değerlendiriliyor`);
          return {
            ticketKey,
            author: change.actorAccountId,
            at: change.at !== "" ? change.at : new Date().toISOString(),
            command: { name: "approve" },
          } as CommandEnvelope;
        }
      } catch {
        // transient changelog hatası: yorum yolu zaten dönüyor, sessizce geç
      }
      return null;
    };

    const intervalMs = this.deps.commandPollMs ?? this.runSettings.commandPollMs;
    const wait = this.deps.sleep ?? sleep;
    for (;;) {
      if (signal.aborted) throw new PilotStepError("kapı iptal edildi (akış durdu)");
      let envelope: CommandEnvelope | null = null;
      try {
        const hit = await pollForCommandOnce({
          work,
          ticketKey,
          seen,
          accept: ["approve", "reject"],
          onInvalid: (messageKey, command) =>
            store.log("warn", `! komut geçersiz: /${command} (${messageKey})`),
          onIgnored: (env) =>
            store.log("dim", `→ komut yok sayıldı bu kapıda: /${env.command.name} · ${env.author}`),
        });
        envelope = hit?.envelope ?? null;
      } catch (error) {
        if (error instanceof PollAbortedError) throw new PilotStepError("kapı iptal edildi (akış durdu)");
        throw error;
      }
      // Yorum komutu yoksa atama kanalına bak.
      if (envelope === null) envelope = await pollAssignmentApproval();
      if (envelope === null) {
        if (signal.aborted) throw new PilotStepError("kapı iptal edildi (akış durdu)");
        await wait(intervalMs);
        continue;
      }
      this.deps.onJiraChanged?.();

      if (envelope.command.name === "reject") {
        throw new GateRejectedError(envelope.command.reason, envelope.author);
      }

      // approve → verify the author is in the approver group (M32/M51). SoD is
      // relaxed only by which group APPROVER_GROUP names (see config/RAPOR);
      // the membership check itself is never skipped.
      const member = await work.verifyMembership(envelope.author, approverGroup);
      if (!member) {
        store.log("err", `✗ ${envelope.author} ${approverGroup} grubunda değil — onay reddedildi`);
        await work.addComment(
          ticketKey,
          doc(paragraph(`❌ ${envelope.author} bu kapıyı onaylayamaz (${approverGroup} üyesi değil).`)),
        );
        this.deps.onJiraChanged?.();
        continue; // keep polling — a non-member comment does not open the gate
      }

      await this.record(
        "GATE_APPROVE",
        { step, group: approverGroup },
        corpAccountOf(envelope.author, this.runSettings.operatorAccount),
      );
      return envelope;
    }
  }

  // ---------------------------------------------------------- ADO webhook (fake)

  /** ADO Service Hook delivery: authenticated, allow-listed, then parsed. */
  async handleAdoWebhook(headers: Record<string, string>, body: unknown): Promise<void> {
    const { store, ci } = this.deps;
    const signal = await ci.parseBuildEvent({ headers, body });
    if (signal === null) {
      store.log("dim", "→ ado service hook · ilgisiz olay, yok sayıldı");
      return;
    }
    store.log(
      signal.status === "succeeded" ? "ok" : "err",
      `→ ado build.complete · PR #${signal.prId} · build ${signal.buildId} · ${signal.status}`,
    );
    await this.record("CI_RESULT", {
      prId: signal.prId,
      buildId: signal.buildId,
      status: signal.status,
    });
    const waiter = this.ciWaiter;
    if (waiter && waiter.prId === signal.prId) {
      this.ciWaiter = null;
      waiter.resolve(signal.status === "succeeded");
    }
  }

  // ------------------------------------------------------------- helpers

  /** One thinking-role call: masked on the way out, re-opened for the screen. */
  private async think<T>(
    role: LlmRole,
    schemaName: string,
    schema: z.ZodType<T>,
    input: unknown,
  ): Promise<{ masked: T; display: T }> {
    // The run-resolved gateway + the ROLE's own run-resolved variant id, so the
    // LlmCall row is attributed to the agent that really made the call.
    const variantId =
      role === "engineer" ? this.agents.engineerVariantId : this.agents.analystVariantId;
    const outcome = await this.llm().generateObject(
      { role, variantId, dataClass: this.effectiveDataClass(), schemaName, input },
      schema,
    );
    if (outcome.status !== "ok") {
      throw new PilotStepError(
        outcome.status === "queued"
          ? `model kuyruğa alındı (kota) — ${outcome.resumeAt}`
          : `model çağrısı '${outcome.status}': ${outcome.messageKey}`,
      );
    }
    const unmask = outcome.unmask;
    return { masked: outcome.value, display: unmask ? unmask(outcome.value) : outcome.value };
  }

  /**
   * Wait on the REAL GitHub Checks for the pushed commit (B14). Polls
   * `getCommitChecks` until it is no longer `pending`: `success`/`none` → green
   * (a repo with no CI configured has nothing to fail on), `failure` → red. On
   * timeout the checks never settled, which is treated as red — a build that
   * will not report is not a build that passed.
   */
  private async awaitRealCi(repo: RepoRef, sha: GitSha, prId: number): Promise<boolean> {
    const getChecks = this.deps.scm.getCommitChecks;
    if (typeof getChecks !== "function") return this.awaitCi(prId);
    const { store } = this.deps;
    const timeoutMs = this.deps.ciTimeoutMs ?? 60_000;
    const pollMs = this.deps.mergePollMs ?? 3_000;
    const deadline = Date.now() + timeoutMs;
    store.log("dim", `→ gerçek GitHub Checks bekleniyor · commit ${sha.slice(0, 8)}`);
    let lastDetail = "";
    for (;;) {
      const checks = await getChecks.call(this.deps.scm, repo, sha);
      lastDetail = checks.detail.join(" · ");
      await this.record("CI_RESULT", { prId, sha, state: checks.state, detail: checks.detail });
      if (checks.state === "success" || checks.state === "none") {
        store.log(
          "ok",
          checks.state === "none"
            ? "→ commit için yapılandırılmış CI kontrolü yok — geçildi"
            : `→ CI yeşil: ${lastDetail}`,
        );
        return true;
      }
      if (checks.state === "failure") {
        store.log("err", `→ CI kırmızı: ${lastDetail}`);
        return false;
      }
      // pending — keep waiting until the deadline.
      if (Date.now() >= deadline) {
        store.log("err", `→ CI ${timeoutMs / 1000} sn içinde tamamlanmadı: ${lastDetail}`);
        return false;
      }
      store.step("7", "calisiyor", `CI çalışıyor: ${lastDetail || "kontroller kuyrukta"}`);
      await sleep(pollMs);
    }
  }

  private awaitCi(prId: number): Promise<boolean> {
    const timeoutMs = this.deps.ciTimeoutMs ?? 60_000;
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ciWaiter = null;
        reject(new PilotStepError(`CI sinyali ${timeoutMs / 1000} sn içinde gelmedi`));
      }, timeoutMs);
      this.ciWaiter = {
        prId,
        resolve: (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
      };
    });
  }

  private async updateProgress(message: string): Promise<void> {
    if (this.progressCommentId === null || this.ticketKey === null) return;
    await this.deps.work.updateComment(
      this.ticketKey,
      this.progressCommentId,
      doc(paragraph([strong("▶ Maestro durum:"), text(` ${message}`)])),
    );
    this.deps.onJiraChanged?.();
  }

  /**
   * Record a sandbox lifecycle event (M60): SANDBOX_CREATE when the workspace
   * opens, SANDBOX_DESTROY before it is torn down.
   *
   * Written apart from `record` because the shape is deliberately different:
   * the subject is `"<ticketKey> · <runnerId>"` (not the bare ticket) and the
   * meta carries `{ ticketKey, runner }`, the exact shape `PrismaSandboxReader`
   * folds and the demo seed already writes — so a real run's workspaces line up
   * on the Studio sandbox screen with the seeded ones. The actor is
   * `maestro-runner`, a system actor the audit trail accepts (a workspace is a
   * runner's, not a worker's), so the append is never refused for an
   * unclassifiable actor.
   */
  private async recordSandbox(action: "SANDBOX_CREATE" | "SANDBOX_DESTROY"): Promise<void> {
    const ticketKey = this.requireTicket();
    const event = await this.deps.audit.append({
      actor: "maestro-runner",
      action,
      subject: `${ticketKey} · ${PILOT_RUNNER}`,
      meta: { ticketKey, runner: PILOT_RUNNER, runId: this.runId },
    });
    this.deps.store.update((state) => {
      state.audit.records = event.seq;
    });
  }

  private async record(
    action: AuditAction,
    meta: Record<string, unknown>,
    actor = "maestro-worker",
  ): Promise<void> {
    const event = await this.deps.audit.append({
      actor,
      action,
      subject: this.requireTicket(),
      meta: { ...meta, runId: this.runId },
    });
    this.deps.store.update((state) => {
      state.audit.records = event.seq;
    });
  }

  /** Re-verify the hash chain from genesis; the pilot shows the answer as-is. */
  private async verifyAudit(): Promise<void> {
    const { store, audit } = this.deps;
    try {
      const result = await audit.verify();
      store.update((state) => {
        state.audit.verified = result.ok;
        state.audit.detail = result.ok ? null : JSON.stringify(result);
      });
      store.log(
        result.ok ? "ok" : "err",
        result.ok
          ? `✓ denetim zinciri doğrulandı — ${store.snapshot().audit.records} kayıt, hash zinciri kopuk değil`
          : "✗ denetim zinciri doğrulanamadı",
      );
    } catch (error) {
      store.log("err", `✗ denetim doğrulaması hata verdi: ${String(error)}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The intake role's open questions, rendered as the ONE Turkish clarification
 * comment the reporter reads on the ticket (M98). The questions come from the
 * real intake output; the comment only frames them and asks for an answer.
 */
function clarificationComment(
  missing: ReadonlyArray<{ field: string; why: string; question: string }>,
): ReturnType<typeof doc> {
  return doc(
    heading(3, "❓ Netleştirme gerekli"),
    paragraph("Bu kayıt analiz için henüz yeterli değil. Devam edebilmemiz için şu noktaları netleştirir misiniz:"),
    bulletList(missing.map((m) => m.question)),
    paragraph([
      text("Yanıtlarınızı bu ticket'a ekledikten sonra Maestro analizi baştan üretebilir."),
    ]),
  );
}

/**
 * The Analyst Manager's analysis rejection, rendered as the Turkish note the
 * ticket carries (onay devri, red dalı). The reason comes straight from the
 * reviewer's `/reject <reason>` comment; the note only frames it and says the
 * ticket has been handed back to the bot for a fresh analysis.
 */
function analysisRejectionComment(reason: string): ReturnType<typeof doc> {
  return doc(
    heading(3, "⛔ Analiz reddedildi"),
    paragraph([strong("Analist Yönetici gerekçesi: "), text(reason)]),
    paragraph([
      text(
        "Ticket yeniden analiz için Maestro Bot'a geri atandı. Gerekçe doğrultusunda güncellenip yeniden değerlendirilecektir.",
      ),
    ]),
  );
}

/** The analysis, rendered as the Jira comment a reviewer actually reads. */
function analysisComment(analysis: AnalysisDoc): ReturnType<typeof doc> {
  const impacted = analysis.impactMatrix
    .filter((cell) => cell.impacted)
    .map((cell) => `${cell.appId}: ${cell.summary}`);
  return doc(
    heading(3, "📋 Analiz hazır"),
    paragraph([strong("Amaç: "), text(analysis.purpose)]),
    paragraph([strong("Kapsam: "), text(analysis.scope.included.join(" · "))]),
    paragraph([strong("Kabul kriterleri:")]),
    bulletList(analysis.acceptanceCriteria),
    paragraph([strong("Etkilenen uygulamalar: "), text(impacted.join(" | ") || "yalnız bu uygulama")]),
    paragraph([strong("Ekran/API: "), text(analysis.uiApiChanges)]),
    paragraph([strong("Test yaklaşımı: "), text(analysis.testApproach)]),
    paragraph([
      strong("Risk: "),
      text(`${analysis.riskTier} — ${analysis.riskReason} · azaltma: ${analysis.riskAndRollback.mitigation}`),
    ]),
    paragraph([text("Onay için bu ticket'a "), inlineCode("/approve"), text(" yorumu yazın.")]),
  );
}
