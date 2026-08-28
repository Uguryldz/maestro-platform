import type { ApplicationRecord, JournalEntry, RepoCard, TicketSnapshot, WorkflowRunState } from "@maestro/contracts";
import type { PrStatus, PrThread, RepoRef, ScmPort, WorkPort } from "@maestro/ports";
import { InMemoryToolAuditSink } from "../src/audit.js";
import { McpServerRuntime, type ServerRuntimeDeps } from "../src/runtime.js";
import type { CallerIdentity, ToolScope } from "../src/scopes.js";
import type { ServerDefinition } from "../src/tool.js";
import type { AdoDiffAccess, ApplicationLookup, PrDiff } from "../src/servers/ado.js";
import type { JiraComment, JiraReadAccess, RelatedTicket } from "../src/servers/jira.js";
import type {
  KillSwitchProposal,
  KnowledgeHit,
  MaestroPlatform,
  ParamChangeProposal,
  ParamView,
  PendingGate,
  QuotaStatus,
  RunDetail,
  RunnerHealth,
} from "../src/servers/maestro-platform.js";
import type { WorkspaceEntry, WorkspaceFileContent, WorkspaceFs, WorkspaceMatch } from "../src/servers/workspace.js";

export const AT = "2026-08-09T09:00:00.000Z";

export function caller(scopes: readonly ToolScope[], user = "ugur.yildiz@ugurbank.local"): CallerIdentity {
  return { user, scopes };
}

export function runtimeFor(
  definition: ServerDefinition,
  audit = new InMemoryToolAuditSink(),
): { runtime: McpServerRuntime; audit: InMemoryToolAuditSink } {
  const deps: ServerRuntimeDeps = { audit, now: () => new Date(AT) };
  return { runtime: new McpServerRuntime(definition, deps), audit };
}

export const TICKET: TicketSnapshot = {
  key: "UGURPAY-504",
  projectKey: "UGURPAY",
  issueType: "Story",
  summary: "Masaüstü alt işi",
  description: "desc",
  reporter: "po@ugurbank.local",
  assignee: null,
  components: ["odeme"],
  labels: ["maestro"],
  parentKey: null,
  createdAt: AT,
  updatedAt: AT,
};

const NOT_CALLED = (name: string) => (): never => {
  throw new Error(`unexpected call to ${name}`);
};

/** Only the WorkPort members jira-mcp is allowed to touch are real. */
export function fakeWork(): WorkPort {
  return {
    getTicket: (key: string) => Promise.resolve({ ...TICKET, key }),
    verifyWebhook: NOT_CALLED("verifyWebhook"),
    addComment: NOT_CALLED("addComment"),
    updateComment: NOT_CALLED("updateComment"),
    setLabels: NOT_CALLED("setLabels"),
    assign: NOT_CALLED("assign"),
    createLinkedIssue: NOT_CALLED("createLinkedIssue"),
    parseCommand: NOT_CALLED("parseCommand"),
    verifyMembership: NOT_CALLED("verifyMembership"),
    transition: NOT_CALLED("transition"),
  } as unknown as WorkPort;
}

export function fakeJiraReads(): JiraReadAccess {
  const comment: JiraComment = { id: "c1", author: "po@ugurbank.local", body: "onay bekliyor", at: AT };
  const related: RelatedTicket = {
    key: "UGURPAY-505",
    summary: "child",
    issueType: "Sub-task",
    status: "Open",
    relation: "child",
  };
  return {
    listComments: (_key, limit) => Promise.resolve([comment].slice(0, limit)),
    searchRelated: () => Promise.resolve([related]),
  };
}

export const APP: ApplicationRecord = {
  appId: "ugurpay-api",
  displayName: "UgurPay API",
  adoProject: "Odeme",
  adoRepo: "ugurpay-api",
  platform: "linux-node",
  jiraComponent: "odeme",
  maestroYamlPresent: true,
  createdVia: "import",
};

export const REPO: RepoRef = { project: "Odeme", repo: "ugurpay-api" };

export function fakeApps(): ApplicationLookup {
  return {
    getApplication: (appId: string) => Promise.resolve({ ...APP, appId }),
  };
}

export interface ScmCalls {
  readonly replies: { prId: number; threadId: number; text: string }[];
}

export function fakeScm(calls: ScmCalls): ScmPort {
  const thread: PrThread = { threadId: 7, status: "active", comments: [{ author: "tl", text: "fix", at: AT }] };
  const status: PrStatus = { prId: 1841, state: "active", mergeSha: null };
  return {
    resolveRepo: (app: ApplicationRecord) => Promise.resolve({ project: app.adoProject, repo: app.adoRepo }),
    listPrThreads: () => Promise.resolve([thread]),
    getPrStatus: () => Promise.resolve(status),
    replyThread: (_repo: RepoRef, prId: number, threadId: number, text: string) => {
      calls.replies.push({ prId, threadId, text });
      return Promise.resolve();
    },
    createBranch: NOT_CALLED("createBranch"),
    getPushCredential: NOT_CALLED("getPushCredential"),
    openPr: NOT_CALLED("openPr"),
    activatePr: NOT_CALLED("activatePr"),
  } as unknown as ScmPort;
}

export function fakeDiffs(): AdoDiffAccess {
  const diff: PrDiff = {
    prId: 1841,
    files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }],
    patch: "--- a\n+++ b\n",
    truncated: false,
  };
  return { getPrDiff: () => Promise.resolve(diff) };
}

export interface FsCalls {
  readonly writes: { path: string; content: string }[];
  readonly reads: string[];
}

export function fakeFs(calls: FsCalls): WorkspaceFs {
  return {
    readFile: (path: string): Promise<WorkspaceFileContent> => {
      calls.reads.push(path);
      return Promise.resolve({ path, content: "x", bytes: 1, truncated: false });
    },
    writeFile: (path: string, content: string) => {
      calls.writes.push({ path, content });
      return Promise.resolve({ bytes: content.length });
    },
    listDir: (path: string): Promise<readonly WorkspaceEntry[]> =>
      Promise.resolve([{ path: `${path}/a.ts`, kind: "file", bytes: 10 }]),
    search: (): Promise<readonly WorkspaceMatch[]> =>
      Promise.resolve([{ path: "src/a.ts", line: 3, text: "hit" }]),
  };
}

export const RUN: WorkflowRunState = {
  runId: "run-ugurpay-504-0001",
  ticketKey: "UGURPAY-504",
  step: "4",
  status: "gate",
  risk: "orta",
  startedAt: AT,
  updatedAt: AT,
};

export const REPO_CARD: RepoCard = {
  appId: "ugurpay-api",
  modules: [{ name: "odeme", path: "src/odeme", summary: "payment core" }],
  generatedFromSha: "abc1234",
  version: 3,
  updatedAt: AT,
};

export interface PlatformCalls {
  readonly users: string[];
  proposalStatus: ParamChangeProposal["status"];
}

/** Records the acting user of every call so RBAC delegation can be asserted. */
export function fakePlatform(calls: PlatformCalls): MaestroPlatform {
  const journal: JournalEntry = {
    runId: RUN.runId,
    seq: 1,
    at: AT,
    actor: "ai",
    kind: "analysis",
    title: "analiz hazır",
    detail: "",
  };
  const param: ParamView = {
    key: "gate.reminder_days",
    scope: "global",
    scopeRef: null,
    value: 3,
    guarded: false,
    version: 2,
  };
  const detail: RunDetail = {
    state: RUN,
    appId: "ugurpay-api",
    mode: "full_auto",
    pendingGate: { step: "4", ownerGroup: "product-owners", openedAt: AT, waitingDays: 16 },
  };
  const hit: KnowledgeHit = { id: "k1", title: "repo card", snippet: "…", source: "knowledge", score: 0.9, dataClass: "dahili" as const };
  const track = <T,>(user: string, value: T): Promise<T> => {
    calls.users.push(user);
    return Promise.resolve(value);
  };
  const gate: PendingGate = {
    runId: RUN.runId,
    ticketKey: RUN.ticketKey,
    step: "4",
    ownerGroup: "product-owners",
    openedAt: AT,
    waitingDays: 16,
  };
  const quota: QuotaStatus = {
    scope: "global",
    scopeRef: null,
    usedTokens: 120_000,
    limitTokens: 1_000_000,
    windowEndsAt: AT,
    throttled: false,
  };
  const runner: RunnerHealth = {
    runnerId: "runner-linux-1",
    platform: "linux-node",
    state: "idle",
    activeSandboxes: 0,
    lastHeartbeatAt: AT,
  };
  return {
    listRuns: (user) => track(user, [RUN] as readonly WorkflowRunState[]),
    getRun: (user) => track(user, detail),
    getJournal: (user) => track(user, [journal] as readonly JournalEntry[]),
    getParams: (user) => track(user, [param] as readonly ParamView[]),
    getRepoCard: (user) => track(user, REPO_CARD),
    searchKnowledge: (user) => track(user, [hit] as readonly KnowledgeHit[]),
    listPendingGates: (user) => track(user, [gate] as readonly PendingGate[]),
    quotaStatus: (user) => track(user, [quota] as readonly QuotaStatus[]),
    runnerHealth: (user) => track(user, [runner] as readonly RunnerHealth[]),
    startWorkflow: (user, args) => track(user, { runId: RUN.runId, ticketKey: args.ticketKey }),
    assignApp: (user, args) => track(user, { ticketKey: args.ticketKey, appId: args.appId }),
    setWorkMode: (user, args) => track(user, { runId: args.runId, mode: args.mode }),
    pauseRun: (user, args) => track(user, { runId: args.runId, status: "paused" }),
    resumeRun: (user, args) => track(user, { runId: args.runId, status: "running" }),
    retryStep: (user, args) => track(user, { runId: args.runId, step: args.step, attempt: 2 }),
    notifyGateOwner: (user, args) =>
      track(user, { runId: args.runId, step: args.step, notified: "product-owners" }),
    proposeParamChange: (user, proposal) =>
      track(user, {
        proposalId: "p-1",
        key: proposal.key,
        scopeRef: proposal.scopeRef,
        status: calls.proposalStatus,
        approverGroup: "platform-admins",
      } as ParamChangeProposal),
    proposeKillSwitch: (user, proposal) =>
      track(user, {
        proposalId: "ks-1",
        level: proposal.level,
        status: calls.proposalStatus,
        approverGroup: "platform-admins",
      } as KillSwitchProposal),
  };
}
