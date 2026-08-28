import type {
  AnalysisDoc,
  ApplicationRecord,
  EvidencePackage,
  PublishRequest,
  TicketKey,
} from "@maestro/contracts";
import { defaultPiiPolicy } from "@maestro/pii";
import type { ScmPort, SecretPort, WorkPort } from "@maestro/ports";
import type { ReleaseNoteDraft } from "../src/documents.js";
import type { PublishPiiDeps } from "../src/pii.js";
import type { FetchLike, PublishRunContext, RepoWorkspace, Translate } from "../src/types.js";

export const RUN_ID = "run-20260808-0001";
export const TICKET: TicketKey = "UGURPAY-123";

/**
 * Deterministic catalog stub. It echoes locale+key (+params) instead of real
 * text: the assertions then prove WHICH key a section used, which is what M104
 * compliance actually means — the real wording lives in the catalog, not here.
 */
export function fakeTranslate(recorded?: string[]): Translate {
  return (locale, key, params) => {
    recorded?.push(key);
    const suffix = params && Object.keys(params).length > 0
      ? `(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")})`
      : "";
    return `${locale}:${key}${suffix}`;
  };
}

/**
 * What a composition root exempts from masking for this run: the M83 template
 * pins and the approver whose signature the evidence summary records.
 */
export const EXEMPTIONS = [
  "analysis-template@1.4.0",
  "release-note-template@1.0.0",
  "tl.yilmaz@ugurbank.corp",
] as const;

export function runContext(context: Partial<PublishRunContext> = {}) {
  return () =>
    Promise.resolve({ ticketKey: TICKET, piiExemptions: EXEMPTIONS, ...context } satisfies PublishRunContext);
}

/** The install-time default policy: every detector on, strictest fallback. */
export function piiDeps(overrides: Partial<PublishPiiDeps> = {}): PublishPiiDeps {
  return { policy: defaultPiiPolicy(), ...overrides };
}

export const APP: ApplicationRecord = {
  appId: "ugurpay",
  displayName: "UgurPay",
  adoProject: "Payments",
  adoRepo: "ugurpay",
  platform: "linux-node",
  jiraComponent: null,
  maestroYamlPresent: true,
  createdVia: "import",
};

export const ANALYSIS: AnalysisDoc = {
  templateVersion: "analysis-template@1.4.0",
  language: "tr",
  purpose: "Kart limit artırım akışını otomatikleştirmek.",
  scope: { included: ["Limit artırım servisi", "Mobil ekran"], excluded: ["Kurumsal kartlar"] },
  impactMatrix: [
    { appId: "ugurpay", impacted: true, summary: "Limit servisi değişiyor", source: "primary_repo_discovery" },
    { appId: "ugurcrm", impacted: false, summary: "Etkilenmiyor", source: "repo_card" },
  ],
  acceptanceCriteria: ["Limit 50.000 TL üzerine çıkamaz", "Onay kaydı denetim izine yazılır"],
  uiApiChanges: "POST /limits/increase ucu eklenir.",
  testApproach: "Birim + entegrasyon testleri, negatif senaryolar dahil.",
  riskAndRollback: {
    risk: "Limit hesabı yanlış hesaplanabilir",
    mitigation: "Çift kontrol ve kanary yayın",
    rollback: "Feature flag kapatılır",
  },
  riskTier: "orta",
  riskReason: "Finansal limit değişikliği",
  clarificationsUsed: ["Limit üst sınırı 50.000 TL olarak doğrulandı"],
};

export const EVIDENCE: EvidencePackage = {
  runId: RUN_ID,
  ticketKey: TICKET,
  createdAt: "2026-08-08T09:30:00.000Z",
  templateVersion: "analysis-template@1.4.0",
  files: [
    { name: "analysis.md", sha256: "a".repeat(64), bytes: 2048, contentType: "text/markdown" },
    { name: "diff.patch", sha256: "b".repeat(64), bytes: 9012, contentType: "text/x-diff" },
  ],
  approvals: [
    {
      step: "5",
      decision: "approve",
      actorUserId: "tl.yilmaz@ugurbank.corp",
      actorGroup: "tech-leads",
      sodVerified: true,
      signatureSeq: 7,
      source: "jira",
      at: "2026-08-08T10:00:00.000Z",
    },
  ],
  retentionYears: 10,
  objectLock: true,
};

export const RELEASE_NOTE: ReleaseNoteDraft = {
  templateVersion: "release-note-template@1.0.0",
  language: "tr",
  ticketKey: TICKET,
  summary: "Kart limit artırımı otomatikleşti.",
  changes: ["Limit servisi eklendi", "Mobil ekran güncellendi"],
  docUpdates: ["Kullanım kılavuzu bölüm 4 güncellenmeli"],
  mergeSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f009876543",
  prId: 42,
};

export function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return { runId: RUN_ID, doc: "analysis", targets: ["jira"], locale: "tr", ...overrides };
}

/** Records every WorkPort call; unused methods throw rather than pretend. */
export class FakeWorkPort {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private nextId = 1;

  addComment(key: TicketKey, body: unknown): Promise<{ commentId: string }> {
    this.calls.push({ method: "addComment", args: [key, body] });
    return Promise.resolve({ commentId: `comment-${String(this.nextId++)}` });
  }

  updateComment(key: TicketKey, commentId: string, body: unknown): Promise<void> {
    this.calls.push({ method: "updateComment", args: [key, commentId, body] });
    return Promise.resolve();
  }

  asPort(): WorkPort {
    return this as unknown as WorkPort;
  }
}

export type FakePrState = "draft" | "active" | "completed" | "abandoned";

export class FakeScmPort {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly branches = new Set<string>();
  /** PR id → state; a merged (`completed`) PR is how a branch dies. */
  readonly prStates = new Map<number, FakePrState>();
  private nextPr = 100;

  resolveRepo(app: ApplicationRecord) {
    this.calls.push({ method: "resolveRepo", args: [app] });
    return Promise.resolve({ project: app.adoProject, repo: app.adoRepo });
  }

  createBranch(repo: unknown, name: string, fromRef: string): Promise<void> {
    this.calls.push({ method: "createBranch", args: [repo, name, fromRef] });
    if (this.branches.has(name)) return Promise.reject(new Error(`branch ${name} already exists`));
    this.branches.add(name);
    return Promise.resolve();
  }

  openPr(repo: unknown, args: unknown): Promise<{ prId: number }> {
    this.calls.push({ method: "openPr", args: [repo, args] });
    const prId = this.nextPr++;
    this.prStates.set(prId, "active");
    return Promise.resolve({ prId });
  }

  getPrStatus(repo: unknown, prId: number): Promise<{ prId: number; state: FakePrState; mergeSha: string | null }> {
    this.calls.push({ method: "getPrStatus", args: [repo, prId] });
    const state = this.prStates.get(prId) ?? "active";
    return Promise.resolve({ prId, state, mergeSha: state === "completed" ? "f".repeat(40) : null });
  }

  /** Merge the PR and delete its branch, exactly as a real SCM would. */
  merge(prId: number, branch: string): void {
    this.prStates.set(prId, "completed");
    this.branches.delete(branch);
  }

  asPort(): ScmPort {
    return this as unknown as ScmPort;
  }
}

export class FakeWorkspace implements RepoWorkspace {
  readonly files = new Map<string, string>();
  readonly shas = new Map<string, string>();
  readonly commits: Array<{ branch: string; path: string; message: string }> = [];
  private nextSha = 1;

  readFile(branch: string, path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(`${branch}:${path}`) ?? null);
  }

  commitFile(args: { branch: string; path: string; content: string; message: string }): Promise<{ sha: string }> {
    const sha = `${String(this.nextSha++).padStart(2, "0")}${"c0ffee".repeat(6)}`;
    this.files.set(`${args.branch}:${args.path}`, args.content);
    this.shas.set(`${args.branch}:${args.path}`, sha);
    this.commits.push({ branch: args.branch, path: args.path, message: args.message });
    return Promise.resolve({ sha });
  }

  headSha(branch: string, path: string): Promise<string | null> {
    return Promise.resolve(this.shas.get(`${branch}:${path}`) ?? null);
  }
}

export function fakeSecrets(token = "confluence-pat"): SecretPort {
  return {
    get: () => Promise.resolve(token),
    issueShortLived: () => Promise.reject(new Error("not used")),
    set: () => Promise.reject(new Error("not used")),
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Multipart uploads (attachments) — the JSON `body` stays undefined. */
  form?: { fileName?: string; fileType?: string; fileBytes?: number; fields: Record<string, string> };
}

/** Offline fetch double: a scripted responder plus a call log. */
export function fakeFetch(
  handler: (req: RecordedRequest) => { status: number; body?: unknown; text?: string },
): { fetchImpl: FetchLike; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const recorded: RecordedRequest = {
      method: init?.method ?? "GET",
      url: input,
      headers,
      body: bodyText === undefined ? undefined : JSON.parse(bodyText),
      form: init?.body instanceof FormData ? await readForm(init.body) : undefined,
    };
    calls.push(recorded);
    const result = handler(recorded);
    const text = result.text ?? (result.body === undefined ? "" : JSON.stringify(result.body));
    return new Response(text, { status: result.status });
  };
  return { fetchImpl, calls };
}

/** Flatten a FormData so a test can assert on the uploaded file itself. */
async function readForm(form: FormData): Promise<NonNullable<RecordedRequest["form"]>> {
  const fields: Record<string, string> = {};
  let file: { fileName?: string; fileType?: string; fileBytes?: number } = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields[key] = value;
      continue;
    }
    file = { fileName: value.name, fileType: value.type, fileBytes: (await value.arrayBuffer()).byteLength };
  }
  return { ...file, fields };
}
