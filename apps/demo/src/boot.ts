import type { Server } from "node:http";
import {
  ADO_ORG,
  ADO_PORT,
  ADO_PR_VALIDATION_DEFINITION,
  ADO_PROJECT,
  ADO_REPO,
  ADO_WEBHOOK_USERNAME,
  APPROVER,
  DEFAULT_DESCRIPTION,
  DEFAULT_SUMMARY,
  DEMO_MODEL,
  DEMO_SECRETS,
  JIRA_PORT,
  PROJECT_KEY,
  REPORTER,
  TICKET_KEY,
  UI_PORT,
} from "./config.js";
import { loadRepoEnv, resolveOpenRouter, type OpenRouterEnv } from "./env.js";
import { createFakeAdo, type FakeAdo } from "./fake-ado.js";
import { createFakeJira, type FakeJira } from "./fake-jira.js";
import { close, listen } from "./http.js";
import { DemoRun } from "./run.js";
import { createUiServer } from "./server.js";
import { initialState, StateStore } from "./state.js";
import {
  createDemoAudit,
  createDemoCiPort,
  createDemoGateway,
  createDemoScmPort,
  createDemoSecrets,
  createDemoWorkPort,
} from "./wiring.js";

/**
 * Boots the whole prop stage: fake Jira, fake ADO, and Maestro (UI + webhook
 * endpoints) wired to the real package drivers. Ports default to the demo's
 * fixed ones; tests pass 0 to get ephemeral ports.
 */

export interface BootOptions {
  uiPort?: number;
  jiraPort?: number;
  adoPort?: number;
  /** Overrides `maestro/.env`; tests pass a dummy alongside `llmFetch`. */
  openRouter?: OpenRouterEnv;
  /** Injected LLM transport so tests never touch the network. */
  llmFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Delay before the fake build result arrives. */
  buildDelayMs?: number;
  ciTimeoutMs?: number;
  summary?: string;
  description?: string;
}

export interface DemoStage {
  uiUrl: string;
  jiraUrl: string;
  adoUrl: string;
  store: StateStore;
  run: DemoRun;
  jira: FakeJira;
  ado: FakeAdo;
  start(): Promise<void>;
  close(): Promise<void>;
}

export async function bootDemo(options: BootOptions = {}): Promise<DemoStage> {
  const openRouter = options.openRouter ?? resolveOpenRouter(loadRepoEnv());

  let uiBase: string | null = null;
  const errors: unknown[] = [];

  const jira = createFakeJira({
    pat: DEMO_SECRETS.jiraPat,
    webhookSecret: DEMO_SECRETS.jiraWebhook,
    webhookUrl: () => (uiBase === null ? null : `${uiBase}/webhooks/jira`),
    issue: {
      key: TICKET_KEY,
      projectKey: PROJECT_KEY,
      summary: options.summary ?? DEFAULT_SUMMARY,
      description: options.description ?? DEFAULT_DESCRIPTION,
      issueType: "Story",
      priority: "Yüksek",
      // Maestro never transitions the workflow (M102) — the status below is
      // where the team left the ticket, and it stays there for the whole run.
      status: "Geliştirmede",
      statusCategory: "indeterminate",
      reporter: REPORTER,
      assignee: APPROVER,
      components: ["auth-service", "web-frontend"],
      labels: ["guvenlik"],
    },
    onError: (error) => errors.push(error),
  });

  const ado = createFakeAdo({
    org: ADO_ORG,
    project: ADO_PROJECT,
    repo: ADO_REPO,
    pat: DEMO_SECRETS.adoPat,
    webhookUsername: ADO_WEBHOOK_USERNAME,
    webhookSecret: DEMO_SECRETS.adoWebhook,
    webhookUrl: () => (uiBase === null ? null : `${uiBase}/webhooks/ado`),
    definitionId: ADO_PR_VALIDATION_DEFINITION,
    ...(options.buildDelayMs === undefined ? {} : { buildDelayMs: options.buildDelayMs }),
    onError: (error) => errors.push(error),
  });

  const jiraPort = await listen(jira.server, options.jiraPort ?? JIRA_PORT);
  const adoPort = await listen(ado.server, options.adoPort ?? ADO_PORT);
  const jiraUrl = `http://127.0.0.1:${jiraPort}`;
  const adoUrl = `http://127.0.0.1:${adoPort}`;

  const store = new StateStore(
    initialState({ ticketKey: TICKET_KEY, model: DEMO_MODEL, jiraUrl, adoUrl, approver: APPROVER }),
  );

  const secrets = createDemoSecrets(openRouter);
  const { gateway, policy } = createDemoGateway(secrets, openRouter, {
    runId: () => store.snapshot().runId,
    onCallLog: (log) => {
      store.update((state) => {
        state.llmCalls += 1;
        state.tokens += log.tokensIn + log.tokensOut;
      });
      store.log("dim", `→ model ${log.driver}/${log.model} · rol ${log.role} · ${log.tokensIn}+${log.tokensOut} token`);
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
  });

  const run = new DemoRun({
    work: createDemoWorkPort(secrets, jiraUrl),
    scm: createDemoScmPort(secrets, adoUrl),
    ci: createDemoCiPort(secrets, adoUrl),
    llm: gateway,
    audit: createDemoAudit(),
    piiPolicy: policy,
    store,
    completePullRequest: (prId) => ado.completePullRequest(prId),
    ...(options.ciTimeoutMs === undefined ? {} : { ciTimeoutMs: options.ciTimeoutMs }),
  });

  const ui: Server = createUiServer({ store, run, start: () => run.start(), jiraUrl });
  const uiPort = await listen(ui, options.uiPort ?? UI_PORT);
  uiBase = `http://127.0.0.1:${uiPort}`;

  return {
    uiUrl: uiBase,
    jiraUrl,
    adoUrl,
    store,
    run,
    jira,
    ado,
    start: () => run.start(),
    async close(): Promise<void> {
      await Promise.all([close(ui), close(jira.server), close(ado.server)]);
    },
  };
}
