import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import { t } from "@maestro/config";
import type { CiResultSignal, Locale, ParamDefinition } from "@maestro/contracts";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { InMemoryUserDirectory, LocalIdentityProvider } from "../src/auth/local-identity.js";
import { InMemorySessionStore } from "../src/auth/sessions.js";
import type {
  BffDeps,
  Clock,
  ConnectionView,
  DocTemplateOutput,
  DocTemplateRecord,
  JiraBinding,
  MessageCatalog,
  NotifyDriverView,
  ReadModels,
  RoutingProjectView,
  RoutingRuleView,
  TemplateVersionRecord,
} from "../src/deps.js";
import { buildServer } from "../src/server.js";
import { StaticJiraWorkflowReader, StaticRoutingReader, StaticSettingsReader } from "../src/stores/admin-memory.js";
import type { JiraWorkflowGraphView } from "../src/jira-workflow-model.js";
import { InMemoryConnectionStore, InMemorySecretStore } from "../src/stores/connection-memory.js";
import { InMemoryListeningStore } from "../src/stores/listening-memory.js";
import { InMemoryGuidanceStore } from "../src/guidance-store.js";
import type { ConnectionRecord } from "../src/connection-store.js";
import type { ListeningRuleRecord } from "../src/listening-store.js";
import type { ConnectorFetch } from "../src/connection-service.js";
import { InMemoryDocTemplateStore } from "../src/stores/doc-template-memory.js";
import {
  InMemoryKillSwitchStore,
  InMemoryParamStore,
  InMemoryTemplateStore,
  StaticGateDirectory,
  StaticJiraProjectBindings,
} from "../src/stores/memory.js";
import {
  InMemoryAppRegistryWriter,
  InMemoryOnboardingReader,
  InMemoryRepoPolicyReader,
} from "../src/stores/onboarding-memory.js";
import type {
  OnboardingOptionsRecord,
  OnboardingSampleTicket,
  RepoPolicyRecord,
} from "../src/onboarding-models.js";
import {
  AuditStoreReader,
  InMemoryAppRegistry,
  InMemoryCostReader,
  InMemoryEvidenceReader,
  InMemoryGateBoard,
  InMemoryJournalReader,
  InMemoryKnowledgeIndex,
  InMemoryQuotaReader,
  InMemoryRunCatalog,
  InMemoryRunnerFleet,
  InMemoryScanReader,
  StaticHealthReader,
} from "../src/stores/read-memory.js";
import type { ServiceHealth } from "../src/read-models.js";
import { FakeCiPort, FakeRunGateway, FakeWorkEventReader, FakeWorkPort, WEBHOOK_SECRET } from "./fakes.js";

/**
 * Catalog keys `packages/config` does not carry yet; the tr+en wording is in
 * RAPOR.md for the orchestrator to add. Once they land, this table empties and
 * `messages.test.ts` says so.
 *
 * The original five have since shipped. `command.unknown_actor` is the one this
 * hardening packet added: it is written to a ticket whose comment author cannot
 * be attributed to a corporate account (M33).
 */
export const PENDING_CATALOG_TEXT: Record<string, string> = {
  "command.unknown_actor":
    "{command} komutu işlenemedi: yorumu yazan hesap kurumsal bir kullanıcıya eşlenemedi.",
};

/** The shipped catalog, plus the keys still awaiting an orchestrator edit. */
export const testCatalog: MessageCatalog = {
  t(locale: Locale, key: string, params: Record<string, string> = {}): string {
    const pending = PENDING_CATALOG_TEXT[key];
    if (pending === undefined) return t(locale, key, params);
    return pending.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
  },
};

export class TestClock implements Clock {
  constructor(private current = new Date("2026-08-09T09:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const UGURPAY_BINDING: JiraBinding = {
  projectKey: "UGURPAY",
  active: true,
  triggerMode: "auto",
  appId: "ugurpay",
  mode: "full_auto",
  dataClass: "dahili",
};

export const PARAM_DEFINITIONS: ParamDefinition[] = [
  {
    key: "gate.set",
    scope: "global",
    type: "json",
    guarded: true,
    descriptionKey: "params.description.gate_set",
    defaultValue: {},
  },
  {
    key: "reminder.channel",
    scope: "global",
    type: "enum",
    guarded: false,
    enumValues: ["teams", "smtp", "slack"],
    descriptionKey: "params.description.reminder_channel",
    defaultValue: "teams",
  },
  /**
   * The routing screen's policy (M18). GUARDED, like the shipped definition:
   * it decides whether a `gizli` ticket may reach a cloud model, and a test
   * fixture that made it unguarded would let `PUT /routing` look like it saves
   * when the real deployment files a proposal.
   */
  {
    key: "dataclass.policy",
    scope: "global",
    type: "json",
    guarded: true,
    descriptionKey: "params.description.data_class_policy",
    defaultValue: {},
  },
  /** The reminder ladder and channel routing the notify screen reads (M45/M71). */
  {
    key: "escalation.ladder",
    scope: "global",
    type: "json",
    guarded: false,
    descriptionKey: "params.description.escalation_ladder",
    defaultValue: {},
  },
  {
    key: "notify.routing",
    scope: "global",
    type: "json",
    guarded: false,
    descriptionKey: "params.description.notify_routing",
    defaultValue: {},
  },
  {
    key: "notify.teams.webhook",
    scope: "global",
    type: "json",
    guarded: false,
    descriptionKey: "params.description.notify_teams_webhook",
    defaultValue: { url: "" },
  },
];

export interface Harness {
  app: FastifyInstance;
  work: FakeWorkPort;
  ci: FakeCiPort;
  runs: FakeRunGateway;
  chain: AuditChain;
  auditStore: InMemoryAuditStore;
  clock: TestClock;
  sessions: InMemorySessionStore;
  users: InMemoryUserDirectory;
  identity: LocalIdentityProvider;
  params: InMemoryParamStore;
  templates: InMemoryTemplateStore;
  /** The corporate `.docx` store (M103r), so a test can assert what was stored. */
  docTemplates: InMemoryDocTemplateStore;
  killSwitch: InMemoryKillSwitchStore;
  /** The managed-connector store, so a connector test can seed/assert rows. */
  connections: InMemoryConnectionStore;
  /** The connector secret store — proves a raw token is enciphered, never stored raw. */
  connectorSecrets: InMemorySecretStore;
  /** The listening-rules store, so a rules test can seed/assert rows. */
  listening: InMemoryListeningStore;
  /** The guidance store, so a guidance test can seed/assert notes. */
  guidance: InMemoryGuidanceStore;
  bindings: StaticJiraProjectBindings;
  /** Studio's read side, as concrete stores the tests seed directly. */
  read: TestReadModels;
  /** `MaestroPlatform` over this harness — what maestro-mcp would be injected with. */
  platform: FastifyInstance["platform"];
  /** Log in and return the bearer token. */
  login(username: string, password?: string): Promise<string>;
  /** Create an account and return its username. */
  addUser(user: {
    username: string;
    userId?: string;
    password?: string;
    roles?: string[];
    groups?: string[];
  }): Promise<string>;
  /**
   * Plant a first-run bootstrap admin directly in the directory — a
   * policy-EXEMPT password and `mustChangePassword: true`, bypassing
   * `provision` exactly the way `seedFirstAdmin` does. `addUser` cannot express
   * this: it runs the policy, which rejects `admin123` (M8). Returns the token
   * after logging in, so a test can immediately exercise the restricted session.
   */
  seedBootstrapAdmin(user?: {
    username?: string;
    password?: string;
  }): Promise<{ username: string; password: string }>;
  /** Mint a session directly — the only way to get a delegated (`ai-via:`) one. */
  delegatedToken(username: string): Promise<string>;
}

export const TEST_PASSWORD = "Maestro!Test-2026";

/**
 * The read side as concrete stores rather than interfaces, so a test can seed
 * exactly the rows the endpoint under test should return — and so an endpoint
 * that invents a field instead of reading one fails here.
 */
export interface TestReadModels extends ReadModels {
  runs: InMemoryRunCatalog;
  journal: InMemoryJournalReader;
  gates: InMemoryGateBoard;
  apps: InMemoryAppRegistry;
  knowledge: InMemoryKnowledgeIndex;
  runners: InMemoryRunnerFleet;
  cost: InMemoryCostReader;
  scans: InMemoryScanReader;
  evidence: InMemoryEvidenceReader;
  onboarding: InMemoryOnboardingReader;
  repoPolicy: InMemoryRepoPolicyReader;
}

/**
 * A published version 1, so the read endpoint has something to return and a
 * save under test becomes version 2 — the interesting case, since publishing
 * must never overwrite what a pinned run is still reading (M83).
 */
export const SEED_TEMPLATE: TemplateVersionRecord = {
  name: "Analiz şablonu",
  version: 1,
  sections: [
    {
      key: "amac",
      title: "Amaç",
      description: "",
      aiInstruction: "Ticket'ın çözdüğü iş problemini yaz.",
      required: true,
      format: "free_text",
      example: "",
    },
  ],
  publishedBy: "ayse.kaya@ugurbank.local",
  publishedAt: "2026-08-01T09:00:00.000Z",
};

export const TEST_SERVICES: readonly ServiceHealth[] = [
  {
    service: "bff",
    state: "healthy",
    version: "0.1.0",
    checkedAt: "2026-08-09T09:00:00.000Z",
    note: null,
  },
];

/**
 * Platform wiring the settings screen reads. One connected, one unconfigured:
 * the two states the screen must tell apart, and the pair that catches a
 * reader that collapses "nobody set this up" into "it is broken".
 */
export const TEST_CONNECTIONS: readonly ConnectionView[] = [
  {
    id: "jira",
    endpoint: "https://jira.ugurbank.local",
    status: "connected",
    credentialRef: "vault:maestro/jira#token",
    checkedAt: "2026-08-09T09:00:00.000Z",
  },
  {
    id: "siem",
    endpoint: "",
    status: "unconfigured",
    credentialRef: "none",
    checkedAt: null,
  },
];

export const TEST_NOTIFY_DRIVERS: readonly NotifyDriverView[] = [
  { channel: "jira", enabled: true, target: "ticket comment" },
  { channel: "teams", enabled: false, target: "platform channel" },
];

export const TEST_ROUTING_PROJECTS: readonly RoutingProjectView[] = [
  {
    projectKey: "UGURPAY",
    trigger: "label",
    apps: ["odeme-api"],
    noteKey: "routing.note.active_label",
    noteParams: { label: "maestro" },
  },
];

export const TEST_ROUTING_RULES: readonly RoutingRuleView[] = [
  {
    ruleId: "pay-component",
    conditionKey: "routing.condition.component",
    conditionParams: { value: "odeme" },
    effect: "odeme-api",
    priority: 10,
    projectKey: "UGURPAY",
  },
];

/**
 * A project workflow graph the import screen reads (M102), matching the OPS
 * project on the live site: four statuses, a per-status "start" edge and a
 * global "done" edge, honestly flagged as an OBSERVED (not proven complete)
 * edge set.
 */
export const TEST_WORKFLOW_GRAPH: JiraWorkflowGraphView = {
  projectKey: "OPS",
  statuses: [
    { id: "10004", name: "Yapılacaklar", category: "Yapılacaklar" },
    { id: "10005", name: "Devam Ediyor", category: "Devam Ediyor" },
    { id: "10007", name: "İNCELEMEDE", category: "Devam Ediyor" },
    { id: "10006", name: "Tamam", category: "Tamam" },
  ],
  transitions: [
    { id: "11", name: "Devam Ediyor", fromStatusId: "10004", toStatusId: "10005" },
    { id: "21", name: "İncele", fromStatusId: "10005", toStatusId: "10007" },
    { id: "31", name: "Tamam", fromStatusId: null, toStatusId: "10006" },
  ],
  edgesComplete: false,
  sampledFrom: ["OPS-6", "OPS-7"],
};

export interface HarnessOptions {
  groups?: Record<string, readonly string[]>;
  /**
   * Fastify server options passed straight to `buildServer`. What the
   * failed-probe log tests use: a `logger` with a capturing `stream`, so a
   * `request.log.warn` line can be asserted rather than taken on faith.
   */
  fastify?: FastifyServerOptions;
  bindings?: readonly JiraBinding[];
  ciSignal?: CiResultSignal | null;
  adoAuthorization?: string;
  deps?: Partial<BffDeps>;
  /** Subscription pool (M55); empty by default — most tests do not exercise quota. */
  accounts?: ReadModels["quota"];
  services?: readonly ServiceHealth[];
  /** Published template versions; defaults to a single seeded version 1. */
  templates?: readonly TemplateVersionRecord[];
  /** Onboarding options (M93); empty by default, so a test seeds what it asserts on. */
  onboarding?: OnboardingOptionsRecord;
  /**
   * Wire the M100 app-registry writer (default true). `false` reproduces the
   * older proposal-only submit, where the repo must already exist in the
   * options — the geriye-uyum path the route keeps when no writer is wired.
   */
  withAppRegistry?: boolean;
  /** Per-project run history the dry run replays (M102), keyed by project key. */
  samples?: ReadonlyMap<string, readonly OnboardingSampleTicket[]>;
  /** `.maestro.yaml` records per application (M52). */
  policies?: readonly RepoPolicyRecord[];
  /** Uploaded corporate `.docx` versions; empty by default — most tests upload one. */
  docTemplates?: readonly DocTemplateRecord[];
  /** Documents already produced, for the template screen's output list. */
  docOutputs?: readonly DocTemplateOutput[];
  connections?: readonly ConnectionView[];
  /** Seed the managed-connector store (distinct from the read-only `connections`). */
  managedConnections?: readonly ConnectionRecord[];
  /** Seed the listening-rules store. */
  listeningRules?: readonly ListeningRuleRecord[];
  /** Stub the connector live-test transport; defaults to a 200-with-no-body fetch. */
  connectorFetch?: ConnectorFetch;
  notifyDrivers?: readonly NotifyDriverView[];
  routingProjects?: readonly RoutingProjectView[];
  routingRules?: readonly RoutingRuleView[];
  /**
   * Project workflow graphs the import screen reads (M102). Defaults to the
   * single seeded OPS graph; pass `[]` to exercise the "project not readable"
   * path, or `deps: { jiraWorkflow: undefined }` to exercise the 503-by-name.
   */
  workflowGraphs?: readonly JiraWorkflowGraphView[];
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const work = new FakeWorkPort(WEBHOOK_SECRET, options.groups ?? {});
  const ci = new FakeCiPort(options.adoAuthorization ?? "Basic dGVzdDpzZWNyZXQ=", options.ciSignal ?? null);
  const runs = new FakeRunGateway();
  const auditStore = new InMemoryAuditStore();
  const clock = new TestClock();
  const chain = new AuditChain({ store: auditStore, clock });
  const sessions = new InMemorySessionStore();
  const users = new InMemoryUserDirectory();
  // Cost 4: the tests exercise bcrypt for real, but a production cost would
  // add minutes to the suite for no extra coverage.
  const { BcryptPasswordHasher } = await import("../src/auth/password.js");
  const identity = new LocalIdentityProvider(users, new BcryptPasswordHasher(4));
  const params = new InMemoryParamStore(PARAM_DEFINITIONS);
  const templates = new InMemoryTemplateStore(options.templates ?? [SEED_TEMPLATE], [
    { projectKey: "UGURPAY", version: 1, pinnedRuns: 0 },
  ]);
  const docTemplates = new InMemoryDocTemplateStore(
    options.docTemplates ?? [],
    options.docOutputs ?? [],
  );
  const settings = new StaticSettingsReader(
    options.connections ?? TEST_CONNECTIONS,
    options.notifyDrivers ?? TEST_NOTIFY_DRIVERS,
  );
  const routing = new StaticRoutingReader(
    options.routingProjects ?? TEST_ROUTING_PROJECTS,
    options.routingRules ?? TEST_ROUTING_RULES,
  );
  const jiraWorkflow = new StaticJiraWorkflowReader(options.workflowGraphs ?? [TEST_WORKFLOW_GRAPH]);
  const killSwitch = new InMemoryKillSwitchStore();
  const connections = new InMemoryConnectionStore(options.managedConnections ?? []);
  const connectorSecrets = new InMemorySecretStore();
  const listening = new InMemoryListeningStore(options.listeningRules ?? []);
  const guidance = new InMemoryGuidanceStore();
  const bindings = new StaticJiraProjectBindings(options.bindings ?? [UGURPAY_BINDING]);
  // The onboarding reader is shared with the app-registry writer below, the way
  // the Postgres reader and writer both sit on `db.application`: a submission
  // that registers a repo must be visible to the same request's `assertBindable`.
  const onboarding = new InMemoryOnboardingReader(options.onboarding, options.samples);
  // Wired by default so tests exercise the real M100 write path; a test that
  // wants the older proposal-only behaviour passes `withAppRegistry: false`.
  const appRegistry =
    options.withAppRegistry === false ? undefined : new InMemoryAppRegistryWriter(onboarding);

  const read: TestReadModels = {
    runs: new InMemoryRunCatalog(),
    journal: new InMemoryJournalReader(),
    gates: new InMemoryGateBoard(),
    apps: new InMemoryAppRegistry(),
    knowledge: new InMemoryKnowledgeIndex(),
    runners: new InMemoryRunnerFleet(),
    quota: options.accounts ?? new InMemoryQuotaReader(),
    cost: new InMemoryCostReader(),
    scans: new InMemoryScanReader(),
    evidence: new InMemoryEvidenceReader(),
    // The SAME store the chain appends to: a reader with its own copy would
    // verify itself rather than the trail.
    audit: new AuditStoreReader(auditStore),
    health: new StaticHealthReader(options.services ?? TEST_SERVICES),
    onboarding,
    repoPolicy: new InMemoryRepoPolicyReader(options.policies),
  };

  const app = await buildServer({
    work,
    workEvents: new FakeWorkEventReader(),
    ci,
    runs,
    audit: chain,
    sessions,
    identity,
    users,
    bindings,
    // The same in-memory store is both the binding READER and WRITER, the way
    // PrismaJiraProjectBindings and PrismaBindingWriter both sit on the same
    // table — an approved proposal binds, and the intake path resolves it.
    bindingWriter: bindings,
    gates: new StaticGateDirectory(),
    params,
    templates,
    docTemplates,
    settings,
    routing,
    jiraWorkflow,
    killSwitch,
    connections,
    connectorSecrets,
    appRegistry,
    listening,
    guidance,
    read,
    messages: testCatalog,
    clock,
    config: { actorDomain: "ugurbank.local" },
    // A default 200-with-empty-body transport so a live test resolves ok without
    // a network; a test that cares about a specific response injects its own.
    connectorFetch:
      options.connectorFetch ?? (() => Promise.resolve(new Response("{}", { status: 200 }))),
    ...options.deps,
  }, options.fastify === undefined ? {} : { fastify: options.fastify });

  const addUser: Harness["addUser"] = async (user) => {
    await identity.provision({
      username: user.username,
      userId: user.userId ?? `${user.username}@ugurbank.local`,
      password: user.password ?? TEST_PASSWORD,
      groups: user.groups ?? [],
      roles: user.roles ?? [],
    });
    return user.username;
  };

  const seedBootstrapAdmin: Harness["seedBootstrapAdmin"] = async (user = {}) => {
    const username = user.username ?? "admin";
    const password = user.password ?? "admin123";
    const { BcryptPasswordHasher } = await import("../src/auth/password.js");
    const hasher = new BcryptPasswordHasher(4);
    // Hash written DIRECTLY, never through `provision`: the whole point is that
    // the bootstrap password is policy-exempt on the seed path only.
    await users.upsert({
      username,
      userId: username,
      passwordHash: await hasher.hash(password),
      groups: ["maestro-admins"],
      roles: ["viewer", "admin"],
      active: true,
      mustChangePassword: true,
    });
    return { username, password };
  };

  const login: Harness["login"] = async (username, password = TEST_PASSWORD) => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username, password },
    });
    if (response.statusCode !== 200) throw new Error(`login failed: ${response.body}`);
    return (response.json() as { token: string }).token;
  };

  const delegatedToken: Harness["delegatedToken"] = async (username) => {
    const record = await users.find(username);
    if (record === null) throw new Error(`no such user: ${username}`);
    const { issueSession } = await import("../src/auth/sessions.js");
    const session = issueSession(
      { userId: record.userId, username: record.username, groups: record.groups, roles: record.roles },
      { clock, delegated: true },
    );
    await sessions.create(session);
    return session.token;
  };

  return {
    app,
    work,
    ci,
    runs,
    chain,
    auditStore,
    clock,
    sessions,
    users,
    identity,
    params,
    templates,
    docTemplates,
    killSwitch,
    connections,
    connectorSecrets,
    listening,
    guidance,
    bindings,
    read,
    platform: app.platform,
    login,
    addUser,
    seedBootstrapAdmin,
    delegatedToken,
  };
}

export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
