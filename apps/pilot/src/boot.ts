import type { Server } from "node:http";
import type { FetchLike as JiraFetchLike } from "@maestro/adapter-jira";
import type { FetchLike as GithubFetchLike } from "@maestro/adapter-github";
import type { TicketKey } from "@maestro/contracts";
import type { AuditChain } from "@maestro/audit";
import {
  ADO_ORG,
  ADO_PORT,
  ADO_PR_VALIDATION_DEFINITION,
  ADO_PROJECT,
  ADO_REPO,
  ADO_WEBHOOK_USERNAME,
  defaultSettings,
  discoveryJql,
  PILOT_ANALYST_VARIANT,
  PILOT_ENGINEER_VARIANT,
  PILOT_SECRETS,
  scmMode,
  UI_PORT,
  type ScmMode,
} from "./config.js";
import { resolveVariantModel, type VariantModelReader } from "./variant.js";
import { SettingsStore, SettingsValidationError, type PilotSettings } from "./settings.js";
import { flowTypeLabel, ListeningRulesStore, type FlowType } from "./listening.js";
import { GuidanceStore } from "./guidance.js";
import {
  loadRepoEnv,
  resolveGithub,
  resolveJiraCloud,
  resolveMaestroBotAccountId,
  resolveMaestroManagerAccountId,
  resolveMaestroRequesterAccountId,
  resolveOpenRouter,
  type GithubEnv,
  type JiraCloudEnv,
  type OpenRouterEnv,
} from "./env.js";
import type { AnalysisTemplateOverlayLoader } from "./analysis.js";
import type { CreateWorkspaceOptions } from "./workspace.js";
import { DocStore, type PilotDocTemplate } from "./docs.js";
import { createFakeAdo, type FakeAdo } from "./fake-ado.js";
import { close, listen } from "./http.js";
import { detectOrphans } from "./orphan.js";
import { discoverTickets, type DiscoveredTicket } from "./poll.js";
import { PilotRun } from "./run.js";
import { createUiServer } from "./server.js";
import { initialState, StateStore } from "./state.js";
import {
  createPilotAudit,
  createPilotCiPort,
  createPilotGateway,
  createPilotScmPort,
  createPilotSecrets,
  createPilotWorkPort,
  type GatewayHooks,
} from "./wiring.js";

/**
 * Boots the pilot: the FAKE ADO prop, and Maestro (UI + ADO webhook endpoint)
 * wired to the real package drivers — with the Jira WorkPort pointed at the
 * LIVE site. Ports default to the pilot's fixed ones; tests pass 0 for
 * ephemeral ports and inject `jiraFetch` + `llmFetch` so nothing touches the
 * network.
 */

export interface BootOptions {
  uiPort?: number;
  adoPort?: number;
  /**
   * Injectable environment. When provided it is the SOLE source for every
   * env-derived boot decision (SCM mode, OpenRouter, Jira, GitHub) — the real
   * `maestro/.env` (`loadRepoEnv()`) is NOT read and `process.env` is IGNORED.
   * Tests pass `env: {}` (or a fixed map) so a polluted developer shell (e.g.
   * `PILOT_SCM=github`, a real `GITHUB_TOKEN`) can never sweep an offline test
   * into real network behaviour. When unset (the real app) `loadRepoEnv()` is
   * read and `process.env` still layers over it, exactly as before.
   */
  env?: Record<string, string>;
  /** Overrides env resolution; tests pass dummies alongside the injected fetches. */
  openRouter?: OpenRouterEnv;
  jiraCloud?: JiraCloudEnv;
  /** Which ScmPort to drive. Defaults to PILOT_SCM (env), which defaults to `fake`. */
  scm?: ScmMode;
  /** Overrides GitHub env resolution; tests pass a dummy alongside `githubFetch`. */
  github?: GithubEnv;
  /** Injected GitHub REST/GraphQL transport (stub) — keeps the github path offline in tests. */
  githubFetch?: GithubFetchLike;
  /** Injected exec runner for the git push — tests stub it so nothing shells out. */
  workspaceOptions?: CreateWorkspaceOptions;
  /** Injected LLM transport so tests never touch the network. */
  llmFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   * The variant store the pilot resolves its analyst/engineer MODEL from (M38).
   * When present, the gateway binds each role to the variant's active-version
   * model (DB-first — the model an admin set in Studio). When absent, boot logs
   * a warning and falls back to the bootstrap `PILOT_MODEL`. Tests pass a stub.
   */
  variantReader?: VariantModelReader;
  /** Injected Jira Cloud transport (recorded fixtures) — keeps the pilot offline in tests. */
  jiraFetch?: JiraFetchLike;
  /** Delay before the fake build result arrives. */
  buildDelayMs?: number;
  ciTimeoutMs?: number;
  /** Arm auto-merge at boot (B14). Defaults to the env/settings value (off). */
  autoMerge?: boolean;
  /**
   * PERSISTED settings seed (Faz: ayarlar kalıcılığı). Applied ON TOP of the
   * env defaults, so what an operator saved in the UI before a restart wins
   * over the env bootstrap. The MODEL stays DB-first regardless (the variant
   * resolution below overrides it), and an invalid persisted value falls back
   * to the env defaults with a loud log — a stale file must never brick boot.
   */
  settings?: Partial<PilotSettings>;
  /**
   * Called after every successful UI settings update with the new snapshot.
   * The composition root persists it so a restart keeps the operator's values.
   * Best-effort by contract — it must never fail the update.
   */
  onSettingsChanged?: (settings: PilotSettings) => void;
  /**
   * Lazy loader for the ACTIVE corporate Word template (DocTemplateVersion),
   * wired by the composition root. Read at document-generation time; absent or
   * resolving null keeps the plain built-in layout.
   */
  docTemplate?: () => Promise<PilotDocTemplate | null>;
  /**
   * Lazy loader for the ACTIVE Studio analysis-template overlay
   * (`AnalysisTemplateVersion`), wired by the composition root. Called PER RUN
   * right before the analyst, so a Studio publish shapes the next analysis
   * restart-free. Only key-matched sections' title + aiInstruction are applied
   * (safe overlay — the engine's contract bindings never change); absent or
   * resolving null keeps the corporate default template.
   */
  analysisTemplateOverlay?: AnalysisTemplateOverlayLoader;
  /** Seed the knowledge library ("öğren") at boot — the analyst + engineer read it. */
  guidance?: readonly { title: string; content: string }[];
  /**
   * Seed the listening rules at boot. The composition root reads the DB's
   * `ListeningRule` rows and passes them here, so a pilot RESTART no longer
   * silently forgets every rule until someone re-saves in Studio (the mirror
   * push still applies later edits live).
   */
  listening?: readonly import("./listening.js").ListeningRule[];
  /**
   * Called for every LLM call the gateway completes, IN ADDITION to the RAM
   * counters. The composition root passes a Postgres writer here so cost/PII
   * reporting sees the pilot's real spend; absent = counters only (offline
   * pilot). Must never throw — a reporting failure must not fail a run.
   */
  onLlmCall?: (log: import("@maestro/contracts").LlmCallLog) => void;
  /** Gate comment poll interval (ms) — tests pass a small value. */
  commandPollMs?: number;
  /** Sleep injected into the gate poller so tests don't wait on real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Off by default in tests; the running app turns the discovery loop on. */
  startDiscovery?: boolean;
  /**
   * The audit chain the run appends through. Defaults to the in-memory pilot
   * chain (`createPilotAudit`). Injectable so a test can hold the SAME chain the
   * run writes to and read the trail back — e.g. to assert a run bracketed its
   * workspace with one SANDBOX_CREATE and one SANDBOX_DESTROY (M60).
   */
  audit?: AuditChain;
}

export interface PilotStage {
  uiUrl: string;
  adoUrl: string;
  jiraSite: string;
  store: StateStore;
  settings: SettingsStore;
  /** The live listening-rule set (mirrored from Studio/DB over the BFF proxy). */
  listening: ListeningRulesStore;
  run: PilotRun;
  ado: FakeAdo;
  /** The hash-chained audit trail the run wrote to; read it to inspect events. */
  audit: AuditChain;
  /** One discovery pass on demand (also used by the running app's loop). */
  refreshDiscovery(): Promise<void>;
  start(ticketKey: TicketKey, hint?: { status?: string }): Promise<void>;
  close(): Promise<void>;
}

/**
 * AUTO-START selection (the engine's heartbeat), pure so it is testable alone.
 *
 * From a discovery pass, pick the FIRST ticket that (a) has not been attempted
 * by auto-start before (failed/returned tickets are never retried
 * automatically — a human restarts them) and (b) a LISTENING RULE can classify
 * from the discovery row (project + status; the row carries no issue type).
 * Tickets NO rule classifies are returned in `unmatched` so the caller can log
 * "kural eşleşmedi, elle başlatılmalı" — they wait for a manual start.
 */
export function selectAutoStartTicket(
  rows: readonly DiscoveredTicket[],
  listening: ListeningRulesStore,
  botAccountId: string,
  attempted: ReadonlySet<string>,
): { pick: { key: string; status: string | null; flow: FlowType } | null; unmatched: string[] } {
  const unmatched: string[] = [];
  let pick: { key: string; status: string | null; flow: FlowType } | null = null;
  for (const row of rows) {
    if (attempted.has(row.key)) continue;
    const flow = listening.flowTypeFor(botAccountId, {
      projectKey: row.key.split("-")[0] ?? "",
      status: row.status,
      issueType: row.issueType,
    });
    if (flow === null) {
      unmatched.push(row.key);
      continue;
    }
    if (pick === null) pick = { key: row.key, status: row.status, flow };
  }
  return { pick, unmatched };
}

export async function bootPilot(options: BootOptions = {}): Promise<PilotStage> {
  // When `options.env` is injected it is AUTHORITATIVE: the real `maestro/.env`
  // is not read and `process.env` is ignored, so no boot decision can leak from
  // the developer's shell or repo file. Tests inject `{}` (or a fixed map) to
  // stay hermetic; the real app injects nothing and reads `maestro/.env`.
  const injected = options.env !== undefined;
  const repoEnv = options.env ?? loadRepoEnv();
  const openRouter = options.openRouter ?? resolveOpenRouter(repoEnv, injected);
  const jiraCloud = options.jiraCloud ?? resolveJiraCloud(repoEnv, injected);

  // Assignment-based discovery (the assignment-driven SDLC's cornerstone): the
  // Maestro Bot's accountId, resolved from MAESTRO_BOT_ACCOUNT_ID, is baked into
  // the bounded discovery JQL so the pilot picks up exactly the tickets ASSIGNED
  // to the bot and not yet Done. Empty (no accountId) → `assignee = currentUser()`
  // with a loud warning; the query stays bounded either way.
  const botAccountId = resolveMaestroBotAccountId(repoEnv, injected);
  const discoveryQuery = discoveryJql(botAccountId);

  // The reporter a not-fit ticket is handed BACK to on the İADE branch. Seeded
  // from MAESTRO_REQUESTER_ACCOUNT_ID at boot; UI-param-ready (Studio). Empty is
  // valid — the return then moves the ticket back to the backlog without a
  // reassign (a loud warning is emitted by the resolver), never a boot failure.
  const requesterAccountId = resolveMaestroRequesterAccountId(repoEnv, injected);

  // The Analyst Manager a completed analysis is handed to for approval (onay
  // devri): when the analysis + its docs are on the ticket, the pilot reassigns
  // to this accountId and moves the ticket into review ("İNCELEMEDE"). Seeded
  // from MAESTRO_MANAGER_ACCOUNT_ID at boot; UI-param-ready (Studio). Empty is
  // valid — the handover then only moves the status, without a reassign (a loud
  // warning is emitted by the resolver), never a boot failure. On approve the
  // ticket is reassigned BACK to the bot (`botAccountId`) for the code step.
  const managerAccountId = resolveMaestroManagerAccountId(repoEnv, injected);

  // SCM edge (Dalga C2). `fake` (the default) is unchanged. `github` resolves
  // the real GitHub edge — owner/repo/token — and builds the real ScmPort.
  const mode: ScmMode = options.scm ?? scmMode(repoEnv, injected);
  const github: GithubEnv | undefined =
    mode === "github" ? (options.github ?? resolveGithub(repoEnv, injected)) : undefined;

  let uiBase: string | null = null;
  const errors: unknown[] = [];

  const ado = createFakeAdo({
    org: ADO_ORG,
    project: ADO_PROJECT,
    repo: ADO_REPO,
    pat: PILOT_SECRETS.adoPat,
    webhookUsername: ADO_WEBHOOK_USERNAME,
    webhookSecret: PILOT_SECRETS.adoWebhook,
    webhookUrl: () => (uiBase === null ? null : `${uiBase}/webhooks/ado`),
    definitionId: ADO_PR_VALIDATION_DEFINITION,
    ...(options.buildDelayMs === undefined ? {} : { buildDelayMs: options.buildDelayMs }),
    onError: (error) => errors.push(error),
  });

  const adoPort = await listen(ado.server, options.adoPort ?? ADO_PORT);
  const adoUrl = `http://127.0.0.1:${adoPort}`;

  // DB-FIRST model resolution (M38 / Uğur's hard rule). The analyst and
  // engineer roles run under the model on their VARIANT's active version, not
  // an env constant. `resolveVariantModel` reads the variant store; with no
  // store wired it warns and falls back to the bootstrap PILOT_MODEL (the env
  // seed), so an offline pilot still boots. This runs BEFORE the settings store
  // so the seeded settings/display model is the one the gateway actually binds.
  const envDefaults = defaultSettings();
  const analyst = await resolveVariantModel(PILOT_ANALYST_VARIANT, options.variantReader, {
    fallbackModel: envDefaults.model,
  });
  const engineer = await resolveVariantModel(PILOT_ENGINEER_VARIANT, options.variantReader, {
    fallbackModel: envDefaults.model,
  });

  // Persona overlays (what an admin wrote in Studio's "Persona" field for each
  // agent). Read alongside the model when the reader supports it; absent reader
  // or absent persona → null, and the role runs on the corporate-default persona
  // exactly as before. This is what makes editing an agent's persona in Studio
  // actually change how it analyses / writes code.
  const readPersona = async (variantId: string): Promise<string | null> => {
    const reader = options.variantReader;
    if (reader?.activePersona === undefined) return null;
    try {
      const persona = await reader.activePersona(variantId);
      return persona && persona.trim() !== "" ? persona.trim() : null;
    } catch {
      // A persona read that fails must never break boot — the model already
      // resolved; fall back to the default persona quietly.
      return null;
    }
  };
  const analystPersona = await readPersona(PILOT_ANALYST_VARIANT);
  const engineerPersona = await readPersona(PILOT_ENGINEER_VARIANT);

  // Runtime settings live here (M71): the UI edits these at runtime and every
  // use site reads from the store. The MODEL is seeded from the DB-resolved
  // analyst variant (not the raw env constant) so the settings panel and the
  // status display agree with the model the gateway actually calls — the env
  // `PILOT_MODEL` only survives as the fallback baked into `analyst.model`.
  // PERSISTED settings (options.settings — what the operator saved in the UI
  // before the restart) layer OVER the env defaults; the model stays the
  // DB-resolved one so the panel never disagrees with the gateway. A persisted
  // map that fails validation is dropped with a loud log, never a boot failure.
  const makeSettings = (persisted: Partial<PilotSettings> | undefined): SettingsStore =>
    new SettingsStore({
      ...envDefaults,
      ...(persisted ?? {}),
      model: analyst.model,
      ...(options.autoMerge === undefined ? {} : { autoMerge: options.autoMerge }),
    });
  let settings: SettingsStore;
  try {
    settings = makeSettings(options.settings);
  } catch (error) {
    if (!(error instanceof SettingsValidationError) || options.settings === undefined) throw error;
    console.warn(`[pilot] kalıcı ayarlar geçersiz, env varsayılanlarına dönüldü: ${error.message}`);
    settings = makeSettings(undefined);
  }
  const seeded = settings.snapshot();

  // Listening rules live here too (Faz 3): the pilot cannot read the DB, so the
  // rules an admin edits in Studio are mirrored into this store over the BFF
  // proxy. Empty at boot — no rule means discovery uses the default JQL and every
  // ticket runs the old way, so the pilot behaves exactly as before until a rule
  // is added.
  const listening = new ListeningRulesStore(options.listening ?? []);

  // The analysis-guidance notes ("öğren"). Empty at boot in production; the BFF
  // mirrors the enabled DB notes over /api/guidance, and both the analyst AND
  // the engineer read them so uploaded knowledge shapes the next analysis and
  // the code it produces. Empty = the roles lean only on the ticket. A test may
  // seed it directly to exercise the knowledge path.
  const guidance = new GuidanceStore(options.guidance ?? []);

  const store = new StateStore(
    // The displayed model is the analyst's — the role that runs first and is
    // what an operator watching the run sees working.
    initialState({ model: analyst.model, jiraSite: jiraCloud.baseUrl, approverGroup: seeded.approverGroup }),
  );

  const secrets = createPilotSecrets(openRouter, jiraCloud, github);
  // The gateway hooks, built ONCE and shared by the boot gateway and every
  // run-local gateway `makeRunGateway` builds below — so a run on a rule-mapped
  // variant still counts tokens, logs calls and reports masking identically.
  const gatewayHooks: GatewayHooks = {
    runId: () => store.snapshot().runId,
    onCallLog: (log) => {
      store.update((state) => {
        state.llmCalls += 1;
        state.tokens += log.tokensIn + log.tokensOut;
      });
      store.log("dim", `→ model ${log.driver}/${log.model} · rol ${log.role} · ${log.tokensIn}+${log.tokensOut} token`);
      // Persist the call when a writer is wired (Faz 1): the cost/PII screens
      // read the LlmCall table, and without this the pilot's real spend never
      // reached it. Guarded — reporting must never fail a run.
      try {
        options.onLlmCall?.(log);
      } catch {
        store.log("dim", "→ llm çağrı kaydı yazılamadı (raporlama) — akış etkilenmedi");
      }
    },
    onMasked: (event) => {
      if (event.counts.fields === 0) return;
      store.update((state) => {
        state.maskedFields += event.counts.fields;
      });
      store.log(
        "info",
        `→ PII maskelendi (${event.leg === "request" ? "gidiş" : "dönüş"}): ${event.counts.fields} alan · ${event.counts.occurrences} eşleşme`,
      );
    },
    ...(options.llmFetch ? { fetchImpl: options.llmFetch } : {}),
  };
  const { gateway, policy } = createPilotGateway(secrets, openRouter, gatewayHooks, {
    // The DB-resolved (or env-fallback) model per role. intake shares the
    // analyst's model — it is the analyst's first pass, not a separate agent.
    intake: analyst.model,
    analyst: analyst.model,
    engineer: engineer.model,
  });

  const work = createPilotWorkPort(secrets, jiraCloud, options.jiraFetch);
  const docs = new DocStore();

  // On the github path the real driver does branch/PR/push, real CI (GitHub
  // Checks) and — when auto-merge is armed — the real merge (B14). The fake ADO
  // `onRealPrOpened` publisher stays ONLY as the CI fallback for a repo whose
  // driver cannot read real checks; merge-status now comes from the real PR, so
  // no fake merge-status port is wired on the github path.
  const scmPort = createPilotScmPort(secrets, adoUrl, github, options.githubFetch);
  const githubRunConfig =
    github === undefined
      ? undefined
      : { remoteUrl: `${github.gitBaseUrl}/${github.owner}/${github.repo}.git`, owner: github.owner, repo: github.repo };

  // The hash-chained audit trail (M33). Injectable so a test can hold the same
  // chain the run appends through; the app takes the default in-memory chain.
  const audit = options.audit ?? createPilotAudit();

  const run = new PilotRun({
    work,
    scm: scmPort,
    ci: createPilotCiPort(secrets, adoUrl),
    scmMode: mode,
    llm: gateway,
    audit,
    piiPolicy: policy,
    store,
    settings,
    requesterAccountId,
    managerAccountId,
    botAccountId,
    listening,
    guidance,
    docs,
    ...(options.docTemplate ? { docTemplate: options.docTemplate } : {}),
    ...(options.analysisTemplateOverlay ? { analysisTemplateOverlay: options.analysisTemplateOverlay } : {}),
    ...(analystPersona !== null ? { analystPersona } : {}),
    ...(engineerPersona !== null ? { engineerPersona } : {}),
    // Run-time variant resolution (Faz 3): the run re-reads model + persona from
    // the variant store per ticket, and applies the model by building a
    // run-local gateway over the SAME secrets/hooks — so a Studio publish or a
    // rule→ajan remap is live on the next run, restart-free.
    ...(options.variantReader ? { variantReader: options.variantReader } : {}),
    makeRunGateway: (models) => createPilotGateway(secrets, openRouter, gatewayHooks, models).gateway,
    completePullRequest: (prId) => ado.completePullRequest(prId),
    ...(githubRunConfig ? { github: githubRunConfig } : {}),
    ...(options.workspaceOptions ? { workspaceOptions: options.workspaceOptions } : {}),
    ...(github
      ? {
          // CI fallback only: if the github driver cannot read real checks, the
          // pilot waits on this fake ADO build signal instead. When real checks
          // ARE available (the normal github path), onRealPrOpened is not called.
          onRealPrOpened: (prId, sourceRef) => {
            ado.registerExternalPr(prId, sourceRef);
            ado.emitBuildCompleteFor(prId, sourceRef);
          },
        }
      : {}),
    ...(options.ciTimeoutMs === undefined ? {} : { ciTimeoutMs: options.ciTimeoutMs }),
    ...(options.commandPollMs === undefined ? {} : { commandPollMs: options.commandPollMs }),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  // AUTO-START bookkeeping: tickets auto-start has already tried (kept for the
  // process lifetime, per ticket, so a failed/returned ticket is never retried
  // automatically), and tickets whose "no rule matched" line was already logged
  // (so the discovery loop does not repeat it every cycle).
  const autoStartAttempted = new Set<string>();
  const autoStartUnmatchedLogged = new Set<string>();

  const maybeAutoStart = (): void => {
    if (!settings.snapshot().autoStart) return;
    if (store.snapshot().running) return;
    const { pick, unmatched } = selectAutoStartTicket(
      store.snapshot().discovered,
      listening,
      botAccountId,
      autoStartAttempted,
    );
    for (const key of unmatched) {
      if (autoStartUnmatchedLogged.has(key)) continue;
      autoStartUnmatchedLogged.add(key);
      store.log("dim", `→ oto-başlatma: ${key} için dinleme kuralı eşleşmedi — elle başlatılmalı`);
    }
    if (pick === null) return;
    autoStartAttempted.add(pick.key);
    store.log(
      "info",
      `⚡ oto-başlatma: ${pick.key} bir dinleme kuralıyla '${flowTypeLabel(pick.flow)}' olarak sınıflandı — akış otomatik başlıyor`,
    );
    // Fire-and-forget: start() has its own catch-all; a synchronous "already
    // running" race is caught here so the discovery loop never dies on it.
    void run
      .start(pick.key as TicketKey, pick.status === null ? undefined : { status: pick.status })
      .then(() => {
        // BULGU-3 (canlı S3): the attempted-set exists to stop FAILURE loops,
        // but a run that ends CLEANLY must not freeze the ticket forever —
        // a manager's /reject hands the ticket back for RE-analysis, and an
        // İADE answered by the reporter comes back for a second pass. Both are
        // human-driven (no runaway loop is possible), so a clean, non-failure
        // ending clears the mark; a real failure keeps the block.
        if (store.snapshot().failure === null) autoStartAttempted.delete(pick.key);
      })
      .catch((error: unknown) => {
        store.log("warn", `! oto-başlatma başarısız (${pick.key}): ${String(error)}`);
      });
  };

  const refreshDiscovery = async (): Promise<void> => {
    try {
      // The JQL is derived from the listening rules each cycle: when a `status`
      // rule exists it lists exactly those statuses, otherwise it is the default
      // assignment JQL. So an admin adding a rule in Studio (mirrored here)
      // changes what discovery lists on the next pass, no restart.
      const jql = listening.discoveryJqlFor(botAccountId, discoveryQuery);
      const rows = await discoverTickets(work, jql);
      store.update((state) => {
        state.discovered = rows;
      });
      // The heartbeat: with auto-start on, an idle pilot picks up the first
      // rule-classifiable discovered ticket by itself (guarded above).
      maybeAutoStart();
    } catch (error) {
      store.log("warn", `! keşif yoklaması başarısız: ${String(error)}`);
    }
  };

  const ui: Server = createUiServer({
    store,
    settings,
    listening,
    guidance,
    run,
    docs,
    audit,
    start: (ticketKey, hint) => run.start(ticketKey, hint),
    ...(options.onSettingsChanged ? { onSettingsChanged: options.onSettingsChanged } : {}),
  });
  const uiPort = await listen(ui, options.uiPort ?? UI_PORT);
  uiBase = `http://127.0.0.1:${uiPort}`;

  // Discovery loop: only the running app turns it on; tests call refreshDiscovery
  // explicitly so no timer fires and no live request leaves the process. The
  // interval is re-read from the SettingsStore each cycle (self-rescheduling
  // setTimeout, not a fixed setInterval) so a UI change to the discovery poll
  // takes effect on the next cycle without a restart.
  let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let discoveryStopped = false;
  const scheduleDiscovery = (): void => {
    if (discoveryStopped) return;
    discoveryTimer = setTimeout(() => {
      void refreshDiscovery().finally(scheduleDiscovery);
    }, settings.snapshot().discoveryPollMs);
  };
  if (options.startDiscovery === true) {
    await refreshDiscovery();
    scheduleDiscovery();
    // YETİM İŞ GÖRÜNÜRLÜĞÜ (v1): restart, onay kapısında bekleyen işi yetim
    // bırakır — run belleği gitti, ticket İNCELEMEDE'de yöneticinin üzerinde.
    // Boot'ta BİR KEZ tara: günlüğe warn + ticket'a tek yönlendirme yorumu
    // (çift-yorum engeli detectOrphans içinde). Devralma v1'de akış-içi devam
    // değildir: kullanıcı ticket'ı bota atayınca atama-keşif + oto-başlatma
    // zinciri yeniden analiz eder. Fire-and-forget ve fail-soft — detectOrphans
    // asla reddetmez, boot'u hiçbir hata bozamaz. Yalnız çalışan uygulama
    // (startDiscovery) tarar; testler istedikleri sahte ile doğrudan çağırır.
    void detectOrphans({
      work,
      managerAccountId,
      reviewStatusName: settings.snapshot().reviewStatusName,
      log: (level, text) => store.log(level, text),
    });
  }

  return {
    uiUrl: uiBase,
    adoUrl,
    jiraSite: jiraCloud.baseUrl,
    store,
    settings,
    listening,
    run,
    ado,
    audit,
    refreshDiscovery,
    start: (ticketKey, hint) => run.start(ticketKey, hint),
    async close(): Promise<void> {
      discoveryStopped = true;
      if (discoveryTimer !== null) clearTimeout(discoveryTimer);
      await Promise.all([close(ui), close(ado.server)]);
    },
  };
}
