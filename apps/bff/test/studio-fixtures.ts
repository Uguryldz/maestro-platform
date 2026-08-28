import type {
  ApplicationRecord,
  JournalEntry,
  LlmCallLog,
  SubscriptionAccount,
  TicketSnapshot,
} from "@maestro/contracts";
import type {
  KnowledgeDoc,
  OpenGate,
  RunRecord,
  RunnerRecord,
  ScanRecord,
} from "../src/read-models.js";
import { projectGroupFor } from "../src/routes/access.js";
import { InMemoryQuotaReader } from "../src/stores/read-memory.js";
import { harness, type Harness, type HarnessOptions } from "./helpers.js";

/**
 * Fixtures for Studio's read surface. Everything an endpoint returns is seeded
 * here, so a route that fabricates a field rather than reading one produces a
 * value no test wrote — which is the point: an endpoint that "looks like it
 * works" because it returns a constant is exactly what these fixtures catch.
 */

export const TICKET = "UGURPAY-501";
export const OTHER_TICKET = "UGURWEB-104";
export const RUN_ID = `run-${TICKET}`;
export const PROJECT_GROUP = projectGroupFor("UGURPAY");
export const AT = "2026-08-09T09:00:00.000Z";
/** Four days before the harness clock, so `waitingDays` has something to compute. */
export const OPENED_AT = "2026-08-05T09:00:00.000Z";

export const APP: ApplicationRecord = {
  appId: "ugurpay",
  displayName: "UgurPay",
  adoProject: "Odeme",
  adoRepo: "ugurpay",
  platform: "linux-node",
  jiraComponent: null,
  maestroYamlPresent: true,
  createdVia: "onboarding",
};

export const RUN: RunRecord = {
  ticketKey: TICKET,
  title: "Kredi limiti — API + web UI",
  appId: "ugurpay",
  mode: "full_auto",
  risk: "orta",
  dataClass: "dahili",
  step: "3",
  // Live, and deliberately so: the harness opens a gate for this ticket, so
  // the engine answers `gate` for it. A LIVE record over a `gate` engine answer
  // is the case where the engine must win, and it is the default every Studio
  // read test inherits.
  status: "running",
  parentTicketKey: null,
  childTicketKeys: [],
  reporter: "can.ozturk@ugurbank.local",
  assignee: "mert.demir@ugurbank.local",
  prId: 1841,
  costUsd: 6.2,
  tokensIn: 48_200,
  tokensOut: 6_100,
  startedAt: AT,
  updatedAt: AT,
  // On the board (0019). The default every Studio read test inherits, so a
  // test that wants an archived row has to say so — and the archive filter
  // cannot pass by accident on a fixture that was already hidden.
  archivedAt: null,
};

/**
 * The ticket as JIRA holds it — the answer `deps.work.getTicket` gives.
 *
 * Distinct from `RUN` on purpose: `RUN` is the platform's own catalog row, and
 * a hand start must classify the ticket from what Jira says about it, not from
 * what Maestro already recorded. `issueType` and `assignee` are the fields a
 * listening rule matches on, so they are the ones a test asserts travelled.
 */
export const SNAPSHOT: TicketSnapshot = {
  key: TICKET,
  projectKey: "UGURPAY",
  issueType: "Hata",
  summary: RUN.title,
  description: "Kredi limiti hesabı yanlış sonuç veriyor.",
  reporter: RUN.reporter,
  assignee: "712020:maestro-bot",
  components: [],
  labels: ["maestro", "odeme"],
  parentKey: null,
  createdAt: AT,
  updatedAt: AT,
};

export const OTHER_RUN: RunRecord = {
  ...RUN,
  ticketKey: OTHER_TICKET,
  title: "Başka projenin işi",
  appId: "ugurweb",
};

export const JOURNAL_AI: JournalEntry = {
  runId: RUN_ID,
  seq: 1,
  at: AT,
  actor: "ai",
  kind: "engineering",
  title: "Kod yazıldı",
  detail: "7 dosya · +388/−74",
  cost: { usd: 2.41, tokensIn: 40_000, tokensOut: 5_000, model: "claude-opus-5" },
};

export const JOURNAL_HUMAN: JournalEntry = {
  runId: RUN_ID,
  seq: 2,
  at: AT,
  actor: "human",
  kind: "gate",
  title: "PO onayı",
  detail: "Ayşe K. onayladı",
};

export const GATE: OpenGate = {
  ticketKey: TICKET,
  runId: RUN_ID,
  step: "5",
  ownerGroup: "tech-leads",
  openedAt: OPENED_AT,
  delegatedTo: null,
};

export const RUNNER: RunnerRecord = {
  runnerId: "lnx-01",
  pool: "docker-linux",
  platform: "linux-node",
  state: "busy",
  capacity: 4,
  activeSandboxes: 2,
  lastHeartbeatAt: AT,
  note: null,
};

export const SCAN: ScanRecord = {
  ticketKey: TICKET,
  finding: {
    tool: "semgrep",
    severity: "medium",
    ruleId: "sql-concat",
    file: "src/export.ts",
    line: 142,
    message: "String birleştirme ile SQL sorgusu",
  },
  outcome: "fail",
  at: AT,
};

export const CALL: LlmCallLog = {
  at: AT,
  runId: RUN_ID,
  role: "engineer",
  variantId: "engineer-web",
  driver: "anthropic-direct",
  model: "claude-opus-5",
  tokensIn: 48_200,
  tokensOut: 6_100,
  cachePct: 71,
  usd: 0.42,
  dataClass: "dahili",
};

export const PUBLIC_DOC: KnowledgeDoc = {
  id: "kb-1",
  title: "Analiz şablonu",
  snippet: "Şablona göre analiz üretimi",
  source: "rules/analiz-sablonu.md",
  score: 0.9,
  dataClass: "dahili",
  appId: "ugurpay",
  updatedBy: "ayse.kaya@ugurbank.local",
  updatedAt: AT,
};

/** A document only a cleared session may see (M18/M63). */
export const SECRET_DOC: KnowledgeDoc = {
  ...PUBLIC_DOC,
  id: "kb-2",
  title: "Analiz müşteri listesi",
  snippet: "Gizli müşteri verisi",
  source: "domain/musteri.md",
  score: 0.8,
  dataClass: "gizli",
};

export const ACCOUNTS: readonly SubscriptionAccount[] = [
  {
    accountId: "claude-sub-01",
    driver: "claude-sub",
    windows: [{ kind: "5h", usedPct: 40, resetsAt: AT }],
    state: "ready",
    lastUsedAt: AT,
  },
  {
    accountId: "claude-sub-03",
    driver: "claude-sub",
    windows: [{ kind: "5h", usedPct: 100, resetsAt: AT }],
    state: "exhausted",
    lastUsedAt: AT,
  },
];

/**
 * A harness with the run, its application and a live execution already in
 * place — the state nearly every Studio read test needs before it can ask a
 * question worth asking.
 */
export async function studioHarness(options: HarnessOptions = {}): Promise<Harness> {
  const h = await harness({ accounts: new InMemoryQuotaReader(ACCOUNTS), ...options });
  h.read.runs.put(RUN);
  h.read.apps.put(APP);
  h.runs.openGate(TICKET, "5");
  return h;
}

/** A session that belongs to UGURPAY and holds no role. */
export async function memberToken(h: Harness, username = "uye.kisi"): Promise<string> {
  await h.addUser({ username, groups: [PROJECT_GROUP] });
  return h.login(username);
}

/** A logged-in account with no project membership and no role. */
export async function outsiderToken(h: Harness, username = "stajyer"): Promise<string> {
  await h.addUser({ username, roles: [], groups: [] });
  return h.login(username);
}

export async function adminToken(h: Harness, username = "yonetici"): Promise<string> {
  await h.addUser({ username, roles: ["admin"], groups: [] });
  return h.login(username);
}
