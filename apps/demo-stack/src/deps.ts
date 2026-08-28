import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import type { BffDeps, Clock, ReadModels } from "@maestro/bff";
import {
  AuditStoreReader,
  BcryptPasswordHasher,
  InMemoryAppRegistry,
  InMemoryCostReader,
  InMemoryDocTemplateStore,
  InMemoryEvalStore,
  InMemoryEvidenceReader,
  InMemoryGateBoard,
  InMemoryJournalReader,
  InMemoryKillSwitchStore,
  InMemoryKnowledgeIndex,
  InMemoryOnboardingReader,
  InMemoryParamStore,
  InMemoryQuotaReader,
  InMemoryRepoPolicyReader,
  InMemoryRunCatalog,
  InMemoryRunnerFleet,
  InMemoryScanReader,
  InMemorySessionStore,
  InMemoryTemplateStore,
  InMemoryUserDirectory,
  InMemoryVariantCatalog,
  LocalIdentityProvider,
  StaticGateDirectory,
  StaticHealthReader,
  StaticJiraProjectBindings,
  StaticRoutingReader,
  StaticSettingsReader,
} from "@maestro/bff";
import { loadEnv } from "@maestro/config";
import { DemoCiPort, DemoWorkEventReader, DemoWorkPort } from "./fakes/work-port.js";
import { InMemoryRunGateway } from "./fakes/run-gateway.js";
import {
  DEMO_CONNECTIONS,
  DEMO_DOC_OUTPUTS,
  DEMO_DOC_TEMPLATES,
  DEMO_NOTIFY_DRIVERS,
  DEMO_ROUTING_PROJECTS,
  DEMO_ROUTING_RULES,
} from "./seed/admin.js";
import { DEMO_PARAMS } from "./seed/params.js";
import { DEMO_TEMPLATE_BINDINGS, DEMO_TEMPLATE_VERSIONS } from "./seed/template.js";
import { DEMO_EVAL, DEMO_VARIANTS } from "./seed/variants.js";
import { seedInto, type SeedSummary } from "./seed/index.js";
import { gateMemberships } from "./seed/memberships.js";
import { DEMO_ACCOUNTS, DEMO_ACTOR_DOMAIN } from "./seed/users.js";
import {
  DEMO_BINDINGS,
  demoAccounts,
  demoOnboardingOptions,
  demoRepoPolicies,
  demoServices,
} from "./seed/platform.js";

/**
 * The demo composition root.
 *
 * The rule this file follows: the BFF is REAL. `buildServer` is the shipped one,
 * every route is the shipped one, the auth guard, the project scoping, the
 * knowledge data-class filter and the gate decision path all run exactly as they
 * do in production. What is swapped out is the layer BELOW the ports — no
 * Postgres, no Temporal, no Jira, no ADO, no LLM — and the in-memory stores that
 * replace them are the BFF's own reference implementations, not new ones written
 * to be agreeable.
 *
 * This is the opposite of `apps/deploy/src/stores/read-models.ts`, and
 * deliberately so. There, wiring the in-memory read models in would have been
 * wrong: a composition root pointed at a real deployment that answered "no runs"
 * would be indistinguishable from a quiet Friday. Here the store is SEEDED and
 * the process announces itself as a demo, so an empty page would be a bug rather
 * than a lie. Same code, opposite correct choice, because the context differs.
 */

export interface DemoStack {
  readonly deps: BffDeps;
  readonly runs: InMemoryRunGateway;
  readonly read: ReadModels;
  readonly summary: SeedSummary;
  /** The instant the seed was built around; every stamp is relative to it. */
  readonly seededAt: Date;
}

export interface DemoStackOptions {
  /** Fixed clock for tests; defaults to the system clock. */
  readonly clock?: Clock;
  /**
   * bcrypt work factor. Production cost (12) is right for the running demo and
   * far too slow for a test suite that provisions seven accounts, so tests pass
   * a lower one. It is a cost, not a behaviour: the login path is identical.
   */
  readonly bcryptRounds?: number;
}

export async function buildDemoStack(options: DemoStackOptions = {}): Promise<DemoStack> {
  const clock: Clock = options.clock ?? { now: () => new Date() };
  const seededAt = clock.now();

  const auditStore = new InMemoryAuditStore();
  const audit = new AuditChain({ store: auditStore, clock });
  const users = new InMemoryUserDirectory();
  const identity = new LocalIdentityProvider(
    users,
    new BcryptPasswordHasher(options.bcryptRounds ?? 12),
  );

  const runs = new InMemoryRunGateway([], clock);
  const read: ReadModels = {
    runs: new InMemoryRunCatalog(),
    journal: new InMemoryJournalReader(),
    gates: new InMemoryGateBoard(),
    apps: new InMemoryAppRegistry(),
    knowledge: new InMemoryKnowledgeIndex(),
    runners: new InMemoryRunnerFleet(),
    cost: new InMemoryCostReader(),
    scans: new InMemoryScanReader(),
    evidence: new InMemoryEvidenceReader(),
    // These two take their rows at construction rather than through a `put`,
    // so they are seeded here rather than in `seedInto`.
    quota: new InMemoryQuotaReader(demoAccounts(seededAt)),
    health: new StaticHealthReader(demoServices(seededAt)),
    // The SAME store the chain appends to: a reader with its own copy would
    // verify itself rather than the trail (M33).
    audit: new AuditStoreReader(auditStore),
    // The onboarding wizard and the `.maestro.yaml` screen (M93/M102/M52),
    // over the demo's own inventory. The dry run has no run history to replay
    // in the demo, so it answers `sampled: 0` — which the screen renders as
    // "this proved nothing", the honest answer for a stack with no past.
    onboarding: new InMemoryOnboardingReader(demoOnboardingOptions()),
    repoPolicy: new InMemoryRepoPolicyReader(demoRepoPolicies(seededAt)),
  };

  // Accounts first: the seeded audit trail records gate approvals, and the chain
  // refuses a non-human actor for those actions (M32/M101). The trail therefore
  // cannot be written before the people in it exist.
  for (const account of DEMO_ACCOUNTS) {
    await identity.provision({
      username: account.username,
      userId: `${account.username}@${DEMO_ACTOR_DOMAIN}`,
      password: account.password,
      groups: account.groups,
      roles: account.roles,
    });
  }

  const summary = await seedInto({ read, runs, audit, at: seededAt });

  const deps: BffDeps = {
    work: new DemoWorkPort(gateMemberships()),
    workEvents: new DemoWorkEventReader(),
    ci: new DemoCiPort(),
    runs,
    audit,
    sessions: new InMemorySessionStore(),
    identity,
    users,
    bindings: new StaticJiraProjectBindings(DEMO_BINDINGS),
    gates: new StaticGateDirectory(),
    params: new InMemoryParamStore(DEMO_PARAMS),
    templates: new InMemoryTemplateStore(DEMO_TEMPLATE_VERSIONS, DEMO_TEMPLATE_BINDINGS),
    // No corporate `.docx` is seeded on purpose: the template screen's job is
    // to show that generation continues on a plain fallback WITH a visible
    // warning, and a seeded file would hide the behaviour a document owner
    // needs to see before uploading one.
    docTemplates: new InMemoryDocTemplateStore(DEMO_DOC_TEMPLATES, DEMO_DOC_OUTPUTS),
    settings: new StaticSettingsReader(DEMO_CONNECTIONS, DEMO_NOTIFY_DRIVERS),
    routing: new StaticRoutingReader(DEMO_ROUTING_PROJECTS, DEMO_ROUTING_RULES),
    killSwitch: new InMemoryKillSwitchStore(),
    read,
    // The agent-configuration screens (M38/M43/M78). One catalogue instance
    // answers both the read and the write side, so a variant created in the
    // demo appears in the catalogue immediately. The eval store carries a
    // pending run with a real regression, so the justified-pass gate has
    // something true to gate. `pii` and `decisions` are left unwired on purpose
    // — the demo shows the 503-by-name refusal those auditor screens give.
    studio: (() => {
      const variants = new InMemoryVariantCatalog(DEMO_VARIANTS);
      return { variants, variantWriter: variants, eval: new InMemoryEvalStore(DEMO_EVAL) };
    })(),
    clock,
    // `loadEnv` still runs: the demo is a development process (NODE_ENV is not
    // `production`), so it validates and returns local defaults rather than
    // demanding the six connection strings. A demo that bypassed the
    // environment contract would not be running the real boot path.
    config: { env: loadEnv(), actorDomain: DEMO_ACTOR_DOMAIN, locale: "tr" },
  };

  return { deps, runs, read, summary, seededAt };
}
