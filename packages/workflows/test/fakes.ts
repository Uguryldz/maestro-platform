import type {
  MatchResult,
  Notification,
  PublishReceipt,
  RoutingRule,
  ScanResult,
  TicketSnapshot,
} from "@maestro/contracts";
import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import type { AgentTurnRequest, AgentTurnResult } from "@maestro/execution";
import { createJournalMasker } from "@maestro/memory";
import { defaultPiiPolicy } from "@maestro/pii";
import type { LlmOutcome, RepoRef } from "@maestro/ports";
import type { ActivityDeps, RunContext } from "../src/impl/deps.js";
import { InMemoryIdempotency } from "../src/impl/idempotency.js";
import {
  APP,
  LADDER,
  MemoryGateStore,
  MemoryJournalStore,
  ROUTING,
  SNAPSHOT,
  runContext,
} from "./doubles.js";

/**
 * Offline doubles for everything an activity touches.
 *
 * They are as strict as the real thing where strictness is the point — the
 * audit chain is the REAL `AuditChain` over an in-memory store, and journal
 * text goes through the REAL masker — and are dumb recorders everywhere else.
 * Anything a test did not wire throws instead of returning a plausible-looking
 * default: a fake that quietly answers is how a test stops testing.
 */

export * from "./doubles.js";

/** Everything a test wants to look at afterwards, in one place. */
export interface Recorded {
  comments: Array<{ ticket: string; body: unknown }>;
  /** Who the ticket was handed to — the `analiz` flow's delivery. */
  assignments: Array<{ ticket: string; to: string | null }>;
  labels: string[][];
  notifications: Notification[];
  published: Array<{ doc: string; markdown: string; targets: readonly string[] }>;
  stored: Array<{ key: string; bytes: number }>;
  /** Files that reached the ticket through the `DocAttacher` seam (M103r). */
  attached: Array<{ ticket: string; fileName: string; bytes: number; contentType: string }>;
  /** Board moves that reached the driver through the `StatusMover` seam. */
  moved: Array<{ ticket: string; statusName: string }>;
  children: Array<{ summary: string; description: string }>;
  turns: AgentTurnRequest[];
  scans: string[];
  /** `input` rides along so a test can assert WHAT a prompt was composed from. */
  llm: Array<{ role: string; schemaName: string; input: unknown }>;
}

export interface Fakes {
  deps: ActivityDeps;
  recorded: Recorded;
  journalStore: MemoryJournalStore;
  gateStore: MemoryGateStore;
  chain: AuditChain;
  patches: Array<Partial<RunContext>>;
}

export interface FakeOptions {
  context?: Partial<RunContext>;
  generateObject?: (schemaName: string) => LlmOutcome<unknown>;
  agentSession?: () => LlmOutcome<{ resumeToken: string; finalText: string; log: never }>;
  runTurn?: (req: AgentTurnRequest) => AgentTurnResult;
  scan?: (tool: string) => ScanResult | Promise<ScanResult>;
  rules?: RoutingRule[];
  match?: MatchResult | null;
  ticket?: TicketSnapshot;
  members?: (group: string) => string[];
  /** Makes `assign` reject, for the fail-soft delivery path. */
  assignFails?: boolean;
  /**
   * Omit the `DocAttacher` seam entirely — a Data Center deployment, where the
   * documents are generated and stored but cannot go onto the ticket.
   */
  noDocAttacher?: boolean;
  /** Makes every attachment upload reject, for the fail-soft document path. */
  attachFails?: boolean;
  /**
   * Omit the `StatusMover` seam entirely — the Data Center deployment, whose
   * driver cannot transition a ticket at all (M102). The flow must then stay in
   * comment-only mode without anything failing.
   */
  noStatusMover?: boolean;
  /**
   * What the driver answers for a move. Defaults to a clean `moved:true`. The
   * real driver NEVER throws, so a scenario that wants a refusal returns
   * `{moved:false, reason}` — `statusMoverThrows` is the separate, harsher
   * case: a driver that breaks its own contract.
   */
  statusMove?: (statusName: string) => { moved: boolean; reason?: string };
  /** A driver that throws despite the contract saying it cannot. */
  statusMoverThrows?: boolean;
  /** Bytes the binary publish targets produce; defaults to a plausible file. */
  docBytes?: (target: "docx" | "pdf") => Uint8Array;
  /** Role -> directory group, when a test needs the two to differ. */
  groupForRole?: (role: string) => string;
  prState?: { state: "draft" | "active" | "completed" | "abandoned"; mergeSha: string | null };
  verifyMembership?: boolean;
}

const NOT_WIRED = (name: string) => (): never => {
  throw new Error(`fake: ${name} is not wired for this test`);
};

function emptyRecord(): Recorded {
  return {
    comments: [],
    assignments: [],
    labels: [],
    notifications: [],
    published: [],
    stored: [],
    children: [],
    turns: [],
    scans: [],
    llm: [],
    attached: [],
    moved: [],
  };
}

/**
 * Bytes that pass `assertRealDocument`: the format's magic number followed by
 * enough filler to clear the size floor.
 *
 * Deliberately built from the SAME facts the assertion checks, so a test that
 * wants a plausible document gets one, and a test that wants a broken one
 * (`fakeDocBytes("pdf", 10)`) gets something the assertion must reject.
 */
export function fakeDocBytes(target: "docx" | "pdf", size = 4096): Uint8Array {
  const magic = target === "pdf" ? "%PDF-1.7\n" : "PK";
  const out = new Uint8Array(size);
  const head = new TextEncoder().encode(magic);
  out.set(head.slice(0, size), 0);
  // Filler that is not zero, so a truncated write is distinguishable from this.
  for (let i = head.length; i < size; i += 1) out[i] = 65 + (i % 26);
  return out;
}

export function makeFakes(options: FakeOptions = {}): Fakes {
  const recorded = emptyRecord();
  const journalStore = new MemoryJournalStore();
  const gateStore = new MemoryGateStore();
  const chain = new AuditChain({ store: new InMemoryAuditStore() });
  /** The object store's contents, so a generated document can be read back. */
  const blobs = new Map<string, Uint8Array>();
  let context = runContext(options.context);
  const patches: Array<Partial<RunContext>> = [];
  const repo: RepoRef = { project: APP.adoProject, repo: APP.adoRepo };

  const deps: ActivityDeps = {
    runs: {
      get: () => Promise.resolve(context),
      patch: (_ticket, changes) => {
        patches.push(changes);
        context = { ...context, ...changes };
        return Promise.resolve();
      },
    },
    gates: gateStore,
    params: {
      escalationLadder: () => Promise.resolve(LADDER),
      notifyRouting: () => Promise.resolve(ROUTING),
      routingRules: () => Promise.resolve(options.rules ?? []),
      publishTargets: () => Promise.resolve(["jira"]),
    },
    directory: {
      membersOf: (group) => Promise.resolve(options.members?.(group) ?? [`${group}@bank`]),
      // Default: the role IS the group, which is the configuration-free case.
      // `options.groupForRole` lets a test give the two different names, the
      // way a real Jira site does.
      groupForRole: (role) => Promise.resolve(options.groupForRole?.(role) ?? role),
    },
    work: {
      verifyWebhook: NOT_WIRED("verifyWebhook"),
      getTicket: () => Promise.resolve(options.ticket ?? SNAPSHOT),
      addComment: (key, body) => {
        recorded.comments.push({ ticket: key, body });
        return Promise.resolve({ commentId: `c${recorded.comments.length}` });
      },
      updateComment: () => Promise.resolve(),
      setLabels: (_key, labels) => {
        recorded.labels.push(labels);
        return Promise.resolve();
      },
      assign: (ticket, to) => {
        if (options.assignFails === true) return Promise.reject(new Error("jira: assign 403"));
        recorded.assignments.push({ ticket, to });
        return Promise.resolve();
      },
      createLinkedIssue: (_parent, fields) => {
        recorded.children.push({ summary: fields.summary, description: fields.description });
        return Promise.resolve({ key: `PAY-${200 + recorded.children.length}` });
      },
      parseCommand: () => Promise.resolve(null),
      verifyMembership: () => Promise.resolve(options.verifyMembership ?? true),
      transition: NOT_WIRED("transition"),
    },
    scm: {
      resolveRepo: () => Promise.resolve(repo),
      createBranch: () => Promise.resolve(),
      getPushCredential: NOT_WIRED("getPushCredential"),
      openPr: () => Promise.resolve({ prId: 77 }),
      activatePr: () => Promise.resolve(),
      listPrThreads: () => Promise.resolve([]),
      replyThread: () => Promise.resolve(),
      getPrStatus: () =>
        Promise.resolve({
          prId: 77,
          state: options.prState?.state ?? "completed",
          mergeSha: options.prState === undefined ? "abcdef1" : options.prState.mergeSha,
        }),
    },
    llm: {
      generateObject: (req, schema) => {
        recorded.llm.push({ role: req.role, schemaName: req.schemaName, input: req.input });
        const outcome = options.generateObject?.(req.schemaName);
        if (outcome === undefined) throw new Error(`fake llm: no answer for ${req.schemaName}`);
        if (outcome.status !== "ok") return Promise.resolve(outcome);
        return Promise.resolve({ ...outcome, value: schema.parse(outcome.value) });
      },
      agentSession: () => {
        const outcome = options.agentSession?.();
        if (outcome === undefined) throw new Error("fake llm: no agent session answer");
        return Promise.resolve(outcome);
      },
    },
    scan: {
      run: async (tool) => {
        recorded.scans.push(tool);
        if (options.scan === undefined) throw new Error("fake scan: not wired");
        return options.scan(tool);
      },
    },
    storage: {
      put: (key, data) => {
        blobs.set(key, data);
        recorded.stored.push({ key, bytes: data.byteLength });
        return Promise.resolve();
      },
      get: (key) => {
        const found = blobs.get(key);
        if (found === undefined) return Promise.reject(new Error(`fake storage: no object at ${key}`));
        return Promise.resolve(found);
      },
      list: () => Promise.resolve(recorded.stored.map((s) => s.key)),
      delete: () => Promise.resolve(),
      presign: NOT_WIRED("presign"),
    },
    secrets: { get: NOT_WIRED("secret.get"), issueShortLived: NOT_WIRED("issueShortLived"), set: NOT_WIRED("secret.set") },
    notify: {
      send: (notification) => {
        recorded.notifications.push(notification);
        return Promise.resolve();
      },
    },
    publish: {
      publish: (req, markdown) => {
        recorded.published.push({ doc: req.doc, markdown, targets: [...req.targets] });
        const receipts: PublishReceipt[] = req.targets.map((target) => {
          if (target !== "docx" && target !== "pdf") return { target, ref: "ref-1" };
          /**
           * The binary targets behave like the real `BinaryDocPublisher`: they
           * put a FILE in the store and hand back the key. A fake that returned
           * a bare ref would let the delivery pass without ever proving the
           * bytes it attaches are the bytes that were retained.
           */
          const key = `evidence/${req.runId}/${target}`;
          const bytes = options.docBytes?.(target) ?? fakeDocBytes(target);
          blobs.set(key, bytes);
          recorded.stored.push({ key, bytes: bytes.byteLength });
          return { target, ref: key };
        });
        return Promise.resolve(receipts);
      },
    },
    memory: {
      store: journalStore,
      masker: createJournalMasker({ policy: defaultPiiPolicy(), dataClass: "dahili" }),
      clock: { now: () => "2026-08-09T09:00:00+03:00" },
    },
    execution: {
      runTurn: (req) => {
        recorded.turns.push(req);
        if (options.runTurn === undefined) throw new Error("fake execution: not wired");
        return Promise.resolve(options.runTurn(req));
      },
      endRun: () => undefined,
    },
    audit: chain,
    idempotency: new InMemoryIdempotency(),
    // The Cloud driver's capability, as the composition root passes it in.
    // Left out entirely for `noDocAttacher`, which is the DC deployment.
    ...(options.noDocAttacher === true
      ? {}
      : {
          docAttacher: {
            addAttachment: (ticket, fileName, bytes, contentType) => {
              if (options.attachFails === true) return Promise.reject(new Error("jira: attachment 413"));
              recorded.attached.push({ ticket, fileName, bytes: bytes.byteLength, contentType });
              return Promise.resolve({ ids: [`att-${String(recorded.attached.length)}`] });
            },
          },
        }),
    // The Cloud driver's OTHER capability, wired the same way. Left out
    // entirely for `noStatusMover`, which is the Data Center deployment.
    ...(options.noStatusMover === true
      ? {}
      : {
          statusMover: {
            move: (ticket, statusName) => {
              if (options.statusMoverThrows === true) {
                return Promise.reject(new Error("jira: transitions 500"));
              }
              recorded.moved.push({ ticket, statusName });
              return Promise.resolve(options.statusMove?.(statusName) ?? { moved: true });
            },
          },
        }),
    // Catalog lookups are echoed so a missing key is visible in an assertion
    // instead of silently rendering as an empty string.
    translate: (locale, key, params) => `${key}(${Object.values(params ?? {}).join(",")})`,
    now: () => new Date("2026-08-09T09:00:00+03:00"),
  };

  return { deps, recorded, journalStore, gateStore, chain, patches };
}
