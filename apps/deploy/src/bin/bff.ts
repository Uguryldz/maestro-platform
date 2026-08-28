import { AuditChain } from "@maestro/audit";
import {
  buildServer,
  compositeHealthReader,
  connectionHealthReader,
  resolveDeps,
  EnvSettingsReader,
  UNWIRED_CAPABILITY_LINES,
  type BffDeps,
} from "@maestro/bff";
import { createDb } from "@maestro/db";
import { FlowType, type TicketKey } from "@maestro/contracts";
import type { SecretPort } from "@maestro/ports";
import { bootPlatform } from "../boot.js";
import { connectionModelFrom } from "../stores/connection-model.js";
import { tlsSkipFlagFrom } from "../stores/connection-tls.js";
import { connectionSecretsFrom } from "../stores/connection-secrets.js";
import { listenAddress, type DeployEnv } from "../env.js";
import { selectIdentityProvider } from "../identity.js";
import { PrismaKillSwitchStore } from "../stores/killswitch.js";
import { PrismaAppRegistryWriter } from "../stores/app-registry-writer.js";
import { PrismaConnectionStore } from "../stores/connections.js";
import { PrismaListeningStore } from "../stores/listening.js";
import { PrismaGuidanceStore } from "../stores/guidance.js";
import { PrismaRunContextStore } from "../stores/run-context.js";
import { activeAnalystVariantId, activeTemplateVersion } from "../stores/run-pins.js";
import {
  canSearch,
  discoverOnce,
  discoveryStatus,
  startJiraDiscovery,
  type IssueSearcher,
} from "../jira-discovery.js";
import { startJiraPoller } from "../jira-poller.js";
import { EnvGateDirectory } from "../stores/gate-directory.js";
import { prepareWorkspace } from "../stores/workspace-prepare.js";
import { EncryptedSecretStore, resolveMasterKey } from "../stores/encrypted-secret.js";
import { PrismaSessionStore } from "../stores/sessions.js";
import { PrismaBindingWriter, PrismaJiraProjectBindings } from "../stores/bindings.js";
import { PrismaDocTemplateStore } from "../stores/doc-template.js";
import { PrismaParamStore } from "../stores/params-store.js";
import { PrismaRoutingReader } from "../stores/routing.js";
import { PrismaTemplateStore } from "../stores/template.js";
import { assertStoresDurable, volatileStoreWarning, type StoreDurability } from "../stores/durability.js";
import { postgresProbe, temporalProbe } from "../stores/read-health.js";
import { DEGRADED_READ_MODELS, liveReadModels } from "../stores/read-live.js";
import { postgresChainLock, PrismaAuditStore } from "../stores/audit.js";
import { AuditDecisionReader, AuditPiiReader } from "../stores/read-governance.js";
import { PrismaVariantCatalog } from "../stores/read-variants.js";
import { PrismaVariantWriter } from "../stores/write-variants.js";
import { prismaSqlExecutor, prismaTransactionRunner } from "../stores/sql.js";
import { PrismaUserDirectory } from "../stores/users.js";
import { connectTemporal } from "../temporal-gateway.js";
import { jiraWorkEventReader } from "../work-events.js";
import { fail, install, isEntrypoint } from "./lifecycle.js";

/**
 * What each process-local store costs on a restart.
 *
 * `assertStoresDurable` turns the kill-switch entry into a refusal in the prod
 * profile; the rest are printed. The list is data rather than prose so the boot
 * path and the operator read the same thing.
 *
 * Dalga E emptied this of its two most consequential entries. `killSwitch` and
 * `sessions` are now Postgres-backed (`PrismaKillSwitchStore` over the
 * `KillSwitch` table, `PrismaSessionStore` over `Session` — migration 0008), so
 * a restart no longer releases the emergency brake (M58) or signs every user
 * out. The kill switch in particular was the only FATAL entry, so removing it
 * is what lets the prod profile boot with a durable brake rather than refusing.
 *
 * Dalga F emptied the last entry too. The open four-eyes PROPOSAL queue used to
 * be process-local, because a proposal is a value with no approver yet and the
 * `ParamVersion` CHECK (migration 0002) refuses exactly that. It now has its own
 * table — `PendingParamChange` (migration 0013) — so an open proposal (a guarded
 * parameter change OR an onboarding binding) survives a restart. Nothing here is
 * volatile any more; the list is kept as the seam a future volatile store would
 * declare itself through, rather than deleted.
 */
const VOLATILE_STORES: readonly StoreDurability[] = [];

/**
 * The BFF process — the platform's single data door (M7).
 *
 * Boot order is the deployment's dependency order, and every step may refuse:
 * environment, ports, database, Temporal, then the socket. Listening comes
 * last on purpose. A process that accepts a webhook before it can reach the
 * workflow engine answers 200 to a delivery it then drops, and Jira does not
 * redeliver on Maestro's behalf.
 */
export async function main(): Promise<void> {
  // The database comes first: the dev profile's pg-blob storage driver writes
  // through it, so the platform cannot be composed without it.
  const url = required(process.env["DATABASE_URL"], "DATABASE_URL");
  const db = createDb(url);

  const { env, deployment, secrets } = await bootPlatform({
    sql: prismaSqlExecutor(db),
    // Same credential resolution as the worker, through the same factory: the
    // connection an admin tests green on this process must be the one the
    // worker's run authenticates with, and two wirings could drift.
    connectionSecrets: connectionSecretsFrom(db),
    // The model itself, from the same panel rows the credential comes from.
    // Both processes resolve it through this one factory so the endpoint an
    // admin tests green in the panel is the one the run dials — the split
    // `connectionSecrets` closed for the token, closed here for the address.
    resolveModel: connectionModelFrom(db),
    // The handshake, from the same panel rows again: a connection whose
    // admin flagged "TLS doğrulamasını atla" is dialled without certificate
    // verification by every adapter, matching the probe that tested it green.
    tlsSkipFlag: tlsSkipFlagFrom(db),
  });

  // Before Temporal, before the socket: a deployment whose emergency brake
  // cannot survive a restart must not reach the point of accepting traffic.
  // Refusing here costs an operator a start-up error; refusing later costs
  // them an incident in which `stop_all` did not stop anything.
  assertStoresDurable(env.profile, VOLATILE_STORES);
  const warning = volatileStoreWarning(VOLATILE_STORES);
  if (warning !== null) console.warn(warning);

  // The run's row is opened here, on the way in, because this is the only
  // place that learns a start actually created an execution. Activities read
  // their context back from that row, so a started workflow without one fails
  // on its first activity — see `TemporalGatewayOptions.onRunOpened`.
  const runContext = new PrismaRunContextStore(db.workflowRun);

  const temporal = await connectTemporal({
    address: required(env.base.TEMPORAL_ADDRESS, "TEMPORAL_ADDRESS"),
    namespace: env.TEMPORAL_NAMESPACE,
    ...(env.TEMPORAL_TASK_QUEUE === undefined ? {} : { taskQueue: env.TEMPORAL_TASK_QUEUE }),
    onRunOpened: async (run) => {
      // Pinned at the start, read once: publishing a new agent version or a new
      // analysis template must not change the rules under a ticket that is
      // already being analysed (M38/M83).
      const [variantId, templateVersion] = await Promise.all([
        activeAnalystVariantId(db),
        activeTemplateVersion(db),
      ]);
      // The checkout step 3ö reads. Best-effort: an analysis is worse without
      // it but still correct, and a repository that cannot be cloned must not
      // stop a ticket from being analysed at all — `discoverRepo` already
      // treats a missing session as degraded and carries on.
      const workspacePath = await checkoutOrNull(env, secrets, run);
      await runContext.create({
        runId: run.runId,
        ticket: run.ticket,
        appId: run.appId,
        mode: run.mode,
        dataClass: run.dataClass,
        startedAt: new Date(),
        variantId,
        templateVersion,
        ...(workspacePath === null ? {} : { workspacePath }),
      });
    },
  });

  const users = new PrismaUserDirectory(db.user);
  // ONE audit store, shared by the chain that appends and the reader that
  // verifies. Two stores over the same table would let `verify()` check a
  // chain nothing wrote (M33).
  //
  // Postgres-backed now, where it used to be in-memory: Studio's audit screen
  // has to read the trail the platform actually wrote, and an in-memory chain
  // would have rendered a verified chain of zero events on a database holding
  // the real one. The lock moves with it — `postgresChainLock` is what stops a
  // second replica from forking the chain, which `LocalChainLock` cannot do.
  const auditStore = new PrismaAuditStore(db.auditLog);
  // Built once and shared: the settings screen reports the SAME probe results
  // the health screen does. Two independent probe sets would let one screen
  // call Jira green while the other calls it red, and an operator would have no
  // way to tell which to believe.
  // Built BEFORE the read models: the connection rows now feed the health
  // screen too, so the store and the secret side must exist first. Same
  // instances are handed to `deps` below — one store, one cipher, one truth.
  const connections = new PrismaConnectionStore(db.connection);
  const connectorSecrets = new EncryptedSecretStore(
    resolveMasterKey({
      envValue: process.env["CONNECTOR_MASTER_KEY"],
      isProduction: env.profile === "prod",
    }),
    db.connectorSecret,
  );
  const probeRead = liveReadModels({
    db,
    audit: auditStore,
    probes: [postgresProbe(db), temporalProbe(temporal.gateway)],
  });
  // The rehearsal's finding, closed: `/studio/health` reported Postgres and
  // Temporal — the parts a bank is least likely to lose — and said nothing
  // about the LLM key or the Jira credential, the two that actually fail.
  // The connection-backed reader adds llm/jira/scm rows with three honest
  // states, cached on the connection row so a health poll never hammers the
  // provider (see `connectionHealthReader`).
  const read = {
    ...probeRead,
    health: compositeHealthReader([
      probeRead.health,
      connectionHealthReader({ store: connections, secrets: connectorSecrets, fetchImpl: fetch }),
    ]),
  };

  const deps: BffDeps = {
    work: deployment.ports.work,
    workEvents: jiraWorkEventReader(),
    ci: deployment.ci,
    runs: temporal.gateway,
    audit: new AuditChain({
      store: auditStore,
      lock: postgresChainLock(prismaTransactionRunner(db)),
    }),
    // Postgres-backed, where it used to be an `InMemorySessionStore` (Dalga E,
    // migration 0008). A restart no longer signs every logged-in user out
    // mid-task — a support storm on a process that runs under
    // `restart: unless-stopped`. See `PrismaSessionStore` for the timing note
    // on why a primary-key lookup is the right store for a 256-bit token.
    sessions: new PrismaSessionStore(db.session),
    // The login path, selected by config (M8). `local` (default) is the bcrypt
    // provider unchanged; `IDENTITY_DRIVER=ldaps-bind` binds against the bank's
    // AD/LDAP with NO silent fallback to local — an unreachable directory fails
    // the login closed rather than downgrading to a weaker store. The local
    // directory below is both the local provider's store and the default.
    identity: selectIdentityProvider(env, { secrets, users }),
    users,
    // Read from the `JiraProjectBinding` table rather than from a hard-coded
    // empty list. An empty list resolved every project to `null`, so every
    // webhook the bank delivered was accepted and dropped — fail-closed in
    // direction and total in effect, with nothing for an operator to read.
    // An unbound project is still dropped; it now means nobody bound it.
    bindings: new PrismaJiraProjectBindings(db.jiraProjectBinding),
    // Role → directory group. `StaticGateDirectory` answers with the
    // workflow's ROLE names, which a real Jira site does not have: a decision
    // then fails with "group does not exist" (fail-closed, but unusable).
    gates: new EnvGateDirectory(env),
    // Postgres-backed, where it used to be an EMPTY `InMemoryParamStore`.
    // With no definitions at all, every operational setting the installer had
    // seeded into `Param`/`ParamVersion` was invisible: the params screen
    // showed nothing to configure, and the settings, notify and routing
    // screens could not read the escalation ladder, the channel routing or the
    // data-class policy that were in the database the whole time. A restart
    // also silently discarded anything an operator had changed. The pending
    // four-eyes queue is still process-local — see `PrismaParamStore`.
    params: new PrismaParamStore(db.param, db.paramVersion, db.pendingParamChange),
    // Postgres-backed, where it used to be an `InMemoryTemplateStore`.
    //
    // A template version is what an approved analysis was judged against
    // (M83), and holding that in a process-local array meant every restart
    // dropped it: `GET /template` went back to 404 `no_template` and the
    // designer screen back to "henüz yayında değil". That was the last screen
    // in the platform still showing it. Migration 0007 gives it a table, the
    // installer publishes version 1, and the store below is append-only in the
    // same way `PrismaDocTemplateStore` is.
    templates: new PrismaTemplateStore(
      db.analysisTemplateVersion,
      db.jiraProjectBinding,
      db.workflowRun,
    ),
    // Postgres-backed, unlike the two above: an uploaded corporate template is
    // a FILE somebody produced, not a setting they can retype, and a run pinned
    // to version 2 (M83) cannot render at all if a restart lost version 2.
    // That is why this one got a table (migration 0005) rather than a line in
    // `VOLATILE_STORES`.
    docTemplates: new PrismaDocTemplateStore(db.docTemplateVersion, db.docTemplateOutputRow),
    // Wiring, read from the validated environment (M6) and the live probes.
    // There is no settings table on purpose: an endpoint and a credential path
    // are deployment facts, and a console able to rewrite them could point the
    // bank's Jira integration elsewhere without a deploy.
    // The LLM triple is passed separately because it is declared by
    // `DeployEnvSchema`, not by `@maestro/config`'s `EnvSchema` — see
    // `LlmWiring`. `LLM_API_KEY_REF` is a SecretPort KEY (`kv/llm#api-key`),
    // a pointer the settings screen may show; the key it resolves to never
    // leaves the process (M9).
    settings: new EnvSettingsReader(env.base, read.health, notifyChannels(deployment), {
      baseUrl: env.LLM_BASE_URL,
      model: env.LLM_MODEL,
      apiKeyRef: env.LLM_API_KEY_REF,
    }),
    routing: new PrismaRoutingReader(db.jiraProjectBinding, db.routingRule),
    // Postgres-backed, where it used to be an `InMemoryKillSwitchStore` (Dalga
    // E, migration 0008). This is the store `assertStoresDurable` refused a
    // prod boot without: a process-local brake reverts to `off` on the restart
    // this process is configured to perform, RELEASING the emergency brake with
    // nobody told (M58). One durable row now survives it.
    killSwitch: new PrismaKillSwitchStore(db.killSwitch),
    // The connector-management surface (migration 0010): the platform's
    // outbound connections made admin-editable, with tokens stored
    // AES-256-GCM-encrypted. The store persists the connection rows; the
    // EncryptedSecretStore enciphers the tokens under a key from the
    // environment (`CONNECTOR_MASTER_KEY`) — in prod that key is REQUIRED, and
    // in dev a documented key is derived with a warning (never silent). This is
    // its OWN secret port, deliberately not the Vault driver the platform reads
    // deployment secrets through: a console writes here, and must not be able to
    // rewrite the Vault mount the operator manages.
    connections,
    // The M100 app-registry writer: submitting the onboarding wizard registers
    // the picked repo into the `Application` table this reads elsewhere, so a
    // new repo no longer has to be onboarded through another path before it can
    // be bound. The binding itself stays a four-eyes proposal.
    appRegistry: new PrismaAppRegistryWriter(db.application),
    // Turns an APPROVED onboarding proposal into a live JiraProjectBinding (M93).
    // Reader (PrismaJiraProjectBindings) stays resolve-only; both sit on the same
    // table. Without this the approve path would 503-by-name rather than bind.
    bindingWriter: new PrismaBindingWriter(db.jiraProjectBinding),
    // The listening-rules store (Ayarlar > Dinleme Kuralları): status/issuetype
    // → flow-type rows an admin edits from Studio, backing the real DB table.
    listening: new PrismaListeningStore(db.listeningRule),
    guidance: new PrismaGuidanceStore(db.analysisGuidance),
    connectorSecrets,
    // Studio's read side, live (M7). Ten of the twelve read models answer from
    // the tables the worker writes; `runners` and `scans` still refuse by name
    // because nothing in this platform writes either, and a store over an
    // empty table would render "no runners, no findings" — indistinguishable
    // from a healthy fleet. See `stores/read-live.ts`.
    /**
     * The last eight screens (M7), three of them wired.
     *
     * `variants` reads the Variant/VariantVersion tables; `pii` and
     * `decisions` read the SAME audit store the chain appends through — a
     * second store over that table would verify itself, which proves nothing
     * (M33).
     *
     * `eval`, `greenfield` and `cache` are deliberately absent: none of them
     * has a producer, so their routes refuse by name rather than answer an
     * empty page. See `apps/bff/src/routes/unwired.ts` and the boot banner
     * below.
     */
    studio: {
      variants: new PrismaVariantCatalog(db.variant, db.variantVersion),
      // The write side of the same tables (M38/M83). Wiring it turns the
      // admin-gated POST/PUT variant endpoints from 503-by-name into real
      // appends — a variant an admin creates or re-versions in Studio is
      // persisted, not lost at the next restart. Independent of the reader on
      // purpose: a deployment could ship the catalogue without the writer.
      variantWriter: new PrismaVariantWriter(db.variant, db.variantVersion),
      pii: new AuditPiiReader(auditStore, db.llmCall),
      decisions: new AuditDecisionReader(auditStore),
    },
    read,
    // The rules screen shows what SHOULD be picked up; this lets it also say
    // whether anything is looking. See `routes/listening.ts`.
    discoveryStatus,
    /**
     * The "şimdi tara" button.
     *
     * `deps` is built here, but the sweep is wired further down (it needs the
     * work driver), so this closes over the holder and reads it when the
     * button is actually pressed. Left undefined until then, which is what the
     * route reports as 503 on a webhook-only install.
     */
    discoveryRun: () =>
      discoveryRun === undefined
        ? Promise.reject(new Error("sweep_not_configured"))
        : discoveryRun(),
    sweepConfigured: () => discoveryRun !== undefined,
    /**
     * Which absence it is. The driver check happens further down (it needs the
     * work port), so this reads the holder at call time like the runner does.
     */
    sweepUnavailableReason: () =>
      sweepReason ??
      "Bu kurulumda ticket taraması açık değil. .env dosyasına JIRA_DISCOVER_MS " +
        "ekleyip (örn. 300000) servisleri yeniden başlatın.",
    config: {
      env: env.base,
      /**
       * What a ticket does when NO listening rule claims it.
       *
       * A per-ticket rule is the real answer and it wins outright
       * (`apps/bff/src/flow-decision.ts`); this only decides the leftovers. It
       * used to be derived from the profile — `analiz` meant every unclaimed
       * ticket was analysis-only — which is precisely the deployment-time
       * switch that made the wizard's offer a lie. The profile no longer knows
       * what a run is for, so nothing here derives it.
       *
       * `MAESTRO_FLOW` still names a fallback for a site that wants one, and
       * absent it the answer is the full pipeline. Unset is the honest default
       * now that the engineering ports compose everywhere: a run that reaches
       * them and has no repository connection fails with a sentence naming the
       * connection, and the wizard says so before anybody commits.
       */
      ...(flowOf(env) === null ? {} : { defaultFlow: flowOf(env) }),
    },
  };

  /**
   * The Jira command poller (`jira-poller.ts`).
   *
   * Off unless `JIRA_POLL_MS` names an interval. A deployment whose webhook
   * works does not need it, and two paths reading the same comments would
   * answer every command twice. On, it is the ONLY way a Cloud site can close
   * a gate: `verifyWebhook` is not supported there, so `/approve` written on
   * the ticket reaches nothing without this loop.
   */
  const pollMs = Number(env.source["JIRA_POLL_MS"]?.trim() ?? 0);
  if (Number.isFinite(pollMs) && pollMs > 0) {
    startJiraPoller({
      deps: resolveDeps(deps),
      // The concrete driver: reading a thread is not on `WorkPort`.
      comments: deployment.ports.work as unknown as { listComments(t: TicketKey): Promise<unknown[]> },
      intervalMs: pollMs,
      // Live runs, re-read each round so a gate opened a second ago is polled
      // without waiting for a restart.
      openTickets: async () =>
        (
          await db.workflowRun.findMany({
            where: { status: { notIn: ["done", "cancelled"] } },
            orderBy: { startedAt: "desc" },
            take: 50,
          })
        ).map((row) => row.ticketKey as TicketKey),
    });
    console.log(`[maestro] jira komut yoklaması açık (${pollMs} ms)`);
  }

  /**
   * Ticket DISCOVERY (`jira-discovery.ts`).
   *
   * Separate from the comment poller above, and for a different failure: that
   * one reads `/approve` on tickets the platform already has, this one finds
   * the tickets in the first place. Without it a ticket reaches Maestro only
   * through a Jira webhook or somebody typing `/ai-start` — and on an install
   * where neither is set up, the product looks broken in the most confusing way
   * available: panel up, connection green, rules correct, no tickets ever.
   *
   * Own interval so the two can be tuned apart: comments are cheap and want to
   * be quick, a JQL sweep is not and does not.
   */
  /**
   * Set only when the sweep is configured, so the panel's button can tell
   * "nothing happened" from "there is nothing to run" (503).
   */
  let discoveryRun: (() => Promise<readonly string[]>) | undefined;
  /** Set when the sweep is impossible for a reason other than "not asked for". */
  let sweepReason: string | undefined;
  const discoverMs = Number(env.source["JIRA_DISCOVER_MS"]?.trim() ?? 0);
  /**
   * The driver's searcher, or nothing.
   *
   * This used to be `ports.work as unknown as IssueSearcher` — a cast
   * TypeScript accepts and the runtime does not. Only Jira Cloud has
   * `searchIssues`; on Data Center and on Azure DevOps every round threw
   * "searchIssues is not a function", silently on the timer and as a bare 500
   * behind the panel's button. Asked, not asserted, so a driver that cannot be
   * swept is reported instead of failing once per interval.
   */
  const workPort: unknown = deployment.ports.work;
  const searcher: IssueSearcher | null = canSearch(workPort) ? workPort : null;

  if (Number.isFinite(discoverMs) && discoverMs > 0 && searcher !== null) {
    /**
     * Built once and used twice: the timer loop below, and the panel's "şimdi
     * tara" button. Sharing the object is the point — a manual sweep that
     * searched with different rules or a different driver would test something
     * other than what runs on the timer, which is the one thing a test button
     * must never do.
     */
    const discoveryOptions = {
      deps: resolveDeps(deps),
      search: searcher,
      intervalMs: discoverMs,
      rules: async () =>
        (await db.listeningRule.findMany({ orderBy: { priority: "asc" } })).map((row) => ({
          projectKey: row.projectKey,
          assigneeAccountId: row.assigneeAccountId,
          matchKind: row.matchKind as "status" | "issuetype" | "assigned",
          matchValue: row.matchValue,
          enabled: row.enabled,
        })),
      /**
       * The operator's interval, from `jira.discover_seconds`.
       *
       * Read from the parameter table rather than the environment so it can be
       * changed from the panel and take effect on the NEXT round — on a bank's
       * server a container restart is a change request, not a click.
       *
       * A missing row (or a value that is not a number) answers null, which
       * the loop reads as "keep the boot default".
       */
      intervalSeconds: async () => {
        const row = await db.paramVersion.findFirst({
          where: { key: "jira.discover_seconds" },
          orderBy: { version: "desc" },
        });
        const value = row?.valueJson;
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      },
      // Every ticket that already has a row, in ANY state: a finished run must
      // not be started again by the next sweep, and a failed one is a decision
      // for a person, not something to retry on a timer.
      known: async () =>
        (await db.workflowRun.findMany({ select: { ticketKey: true }, take: 500 })).map(
          (row) => row.ticketKey as TicketKey,
        ),
    };
    startJiraDiscovery(discoveryOptions);
    // The panel's button runs ONE round with the same options; it does not
    // touch the timer, so pressing it never changes the schedule.
    discoveryRun = async () => discoverOnce(discoveryOptions);
    console.log(`[maestro] jira ticket keşfi açık (${discoverMs} ms)`);
  } else if (Number.isFinite(discoverMs) && discoverMs > 0) {
    /**
     * Asked for, and impossible.
     *
     * An operator who set `JIRA_DISCOVER_MS` expects a sweep; a driver with no
     * search cannot give one. Staying silent here is what produced the original
     * complaint — the panel said the sweep was on, every round threw, and
     * nothing in the log connected the two. Said at boot instead, once, by
     * name.
     */
    sweepReason =
      "Bu kurulumun iş sürücüsü ticket araması sunmuyor, bu yüzden tarama " +
      "çalışamaz. JQL araması yalnız Jira Cloud bağlantısında vardır — " +
      "Jira Data Center kurulumları ticket'ları webhook ile alır. " +
      "Bağlantılar ekranından Jira Cloud bağlantısını kontrol edin.";
    console.warn(
      `[maestro] ticket keşfi İSTENDİ (${discoverMs} ms) ama bu iş sürücüsü arama sunmuyor — ` +
        "tarama kapalı. JQL araması yalnız Jira Cloud sürücüsünde vardır; " +
        "Jira Data Center kurulumları ticket'ları webhook ile alır.",
    );
  }

  const app = await buildServer(deps);
  const { host, port } = listenAddress(env);
  await app.listen({ host, port });
  console.info(`[maestro] bff listening on ${host}:${port}`);

  // Which Studio screens will error, said at boot rather than discovered by
  // the operator who opens one. Same discipline as the worker's banner: a read
  // model that refuses is a capability this image does not have, and an
  // operator reading a green start-up log has no other way to tell.
  if (DEGRADED_READ_MODELS.length > 0) {
    console.warn(
      `[maestro] bff: ${DEGRADED_READ_MODELS.length} read model` +
        `${DEGRADED_READ_MODELS.length === 1 ? "" : "s"} NOT wired — the Studio screens ` +
        `backed by them refuse rather than render an empty page:\n  - ` +
        DEGRADED_READ_MODELS.join("\n  - "),
    );
  }

  // The Studio capabilities that have no producer, named at boot for the same
  // reason as the read models above: an operator reading a green start-up log
  // has no other way to learn that `/eval`, `/greenfield` and `/cache` will
  // answer 503. Each entry leaves this banner when something WRITES its data,
  // not when somebody decides the warning is noisy.
  if (UNWIRED_CAPABILITY_LINES.length > 0) {
    console.warn(
      `[maestro] bff: ${UNWIRED_CAPABILITY_LINES.length} Studio capabilit` +
        `${UNWIRED_CAPABILITY_LINES.length === 1 ? "y has" : "ies have"} no data source — ` +
        `the screens behind them REFUSE (503) rather than render an empty page:\n  - ` +
        UNWIRED_CAPABILITY_LINES.join("\n  - "),
    );
  }

  install(async () => {
    await app.close();
    await temporal.close();
    await db.$disconnect();
  });
}

/**
 * Which notify channels this deployment actually registered.
 *
 * Read out of the resolved selection rather than listed by hand: the notify
 * driver's config names its channels (`{ jira: {} }`), so this is the same
 * fact the notifier itself acts on. A hand-kept list here would drift, and the
 * settings screen would then show a channel as live that nothing delivers to
 * — which is worse than showing none, because an operator would stop looking
 * for the reminder that never arrived.
 *
 * The `multi` driver fans out to the channels its config names; any other
 * driver IS its channel, and its own id is the answer.
 */
/**
 * Which flow this deployment runs by DEFAULT (`planFor`) — when no listening
 * rule claims the ticket. The per-ticket answer is `flow-decision.ts`.
 *
 * Read ONLY from `MAESTRO_FLOW`, and unset unless a site names one.
 *
 * It used to be derived from the profile: `analiz` meant every unclaimed ticket
 * became analysis-only, because that profile composed refusing scm/ci/scan
 * drivers and a run reaching engineering could not succeed. The derivation was
 * sound while the profile decided what the product could do — and it is exactly
 * what had to go when that stopped being true. The engineering ports compose on
 * every deployment now, so a profile no longer carries an opinion about what a
 * ticket is for, and inventing one here would put the old deployment-time
 * switch back under a different name.
 *
 * An unrecognised value is ignored rather than guessed — the full pipeline is
 * the safe direction, and it is the direction an operator can see: a run with
 * no repository connection fails naming the connection, which is fixable from
 * the panel, unlike a flow silently downgraded by a variable.
 */
function flowOf(env: DeployEnv): FlowType | null {
  const override = env.source["MAESTRO_FLOW"]?.trim();
  if (override !== undefined && override !== "") {
    const parsed = FlowType.safeParse(override);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

function notifyChannels(deployment: { selection: { notify: { driver: string; config: unknown } } }): readonly string[] {
  const { driver, config } = deployment.selection.notify;
  if (driver !== "multi") return [driver];
  return typeof config === "object" && config !== null ? Object.keys(config) : [];
}

/**
 * Clone the run's repository, or report that there is none.
 *
 * Best-effort on purpose. A repository the platform cannot reach — no token, a
 * private repo, a network that refuses — makes the analysis WORSE, because the
 * analyst then reasons from the ticket alone. It does not make the analysis
 * wrong, and `discoverRepo` already carries on when the session is unavailable.
 * Failing the run here would turn a degraded analysis into no analysis.
 *
 * The failure is logged rather than swallowed: an operator who expected the
 * analyst to read the repository needs to know it did not.
 */
async function checkoutOrNull(
  env: DeployEnv,
  secrets: SecretPort,
  run: { runId: string; appId: string | null },
): Promise<string | null> {
  // An analysis-only run has no repository to check out — that is the
  // binding's deliberate shape, not a clone failure, so there is nothing to
  // warn about either. The skip is journaled by the workflow itself at 3ö.
  if (run.appId === null) return null;
  const root = env.source["WORKSPACE_ROOT"]?.trim();
  if (root === undefined || root === "") return null;

  const tokenRef = env.source["SCM_TOKEN_REF"]?.trim();
  try {
    const token = tokenRef === undefined || tokenRef === "" ? undefined : await secrets.get(tokenRef);
    const scmHost = env.source["SCM_HOST"]?.trim() ?? "";
    return await prepareWorkspace({
      repo: run.appId,
      root,
      runId: run.runId,
      /**
       * Blank is ABSENT, not a host.
       *
       * `?.trim()` is `undefined` only when the KEY is missing, and both
       * bundles ship `SCM_HOST: ${SCM_HOST:-}` — present and empty. So an
       * install that never set it passed `host: ""`, which defeats the
       * `?? "github.com"` fallback in `prepareWorkspace` and turns every
       * enrichment clone into `https:///owner/repo.git`. The two settings
       * above already use this pair; this one had drifted.
       */
      ...(scmHost === "" ? {} : { host: scmHost }),
      ...(token === undefined ? {} : { token }),
    });
  } catch (error) {
    console.warn(
      `[maestro] ${run.runId}: depo çekilemedi, analiz depoyu görmeden yapılacak — ${String(error)}`,
    );
    return null;
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name}: required — the BFF cannot serve without it (M6)`);
  return value;
}

if (isEntrypoint(import.meta.url)) {
  await main().catch(fail);
}
