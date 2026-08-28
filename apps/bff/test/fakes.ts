import {
  commandFromWebhook,
  JIRA_SIGNATURE_HEADER,
  parseWebhookEvent,
  signWebhookBody,
  verifyWebhookSignature,
} from "@maestro/adapter-jira";
import type {
  CiResultSignal,
  CommandEnvelope,
  TicketKey,
  TicketSnapshot,
  WorkflowRunState,
} from "@maestro/contracts";
import { CapabilityNotSupportedError, type CiPort, type CiWebhookRequest, type WorkPort } from "@maestro/ports";
import type {
  CommandDiagnosis,
  CommandDiagnostics,
  WorkEvent,
  WorkEventReader,
} from "../src/deps.js";
import type {
  RunGateway,
  RunSummary,
  SignalOutcome,
  SignalWithStartInput,
  StartOutcome,
} from "../src/gateway.js";

export const WEBHOOK_SECRET = "maestro-test-webhook-secret";
export { JIRA_SIGNATURE_HEADER, signWebhookBody };

/**
 * The Jira fake wraps the REAL driver functions for signature verification and
 * command parsing. A hand-written grammar here would make the M105 tests
 * tautological: they would only prove that the test agrees with itself.
 */
export class FakeWorkPort implements WorkPort, CommandDiagnostics {
  readonly comments: Array<{ ticket: string; body: string }> = [];
  readonly membershipCalls: Array<{ userId: string; group: string }> = [];
  private readonly groups = new Map<string, Set<string>>();
  private commentId = 0;

  constructor(
    private readonly secret: string = WEBHOOK_SECRET,
    groups: Record<string, readonly string[]> = {},
  ) {
    for (const [group, members] of Object.entries(groups)) {
      this.groups.set(group, new Set(members.map((member) => member.toLowerCase())));
    }
  }

  verifyWebhook(rawBody: string | Uint8Array, headers: Record<string, string>): Promise<void> {
    const header = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === JIRA_SIGNATURE_HEADER,
    )?.[1];
    verifyWebhookSignature(rawBody, header, this.secret);
    return Promise.resolve();
  }

  parseCommand(rawBody: unknown): Promise<CommandEnvelope | null> {
    return Promise.resolve(commandFromWebhook(rawBody).envelope);
  }

  parseCommandDetailed(rawBody: unknown): CommandDiagnosis {
    return commandFromWebhook(rawBody);
  }

  addComment(key: TicketKey, body: unknown): Promise<{ commentId: string }> {
    this.comments.push({ ticket: key, body: String(body) });
    this.commentId += 1;
    return Promise.resolve({ commentId: String(this.commentId) });
  }

  verifyMembership(userId: string, group: string): Promise<boolean> {
    this.membershipCalls.push({ userId, group });
    return Promise.resolve(this.groups.get(group)?.has(userId.trim().toLowerCase()) ?? false);
  }

  /** Last comment posted to `ticket`, or undefined. */
  lastComment(ticket: string): string | undefined {
    return this.comments.filter((comment) => comment.ticket === ticket).at(-1)?.body;
  }

  /**
   * Snapshots a test has seeded with `putTicket`. Unseeded, `getTicket` throws
   * the way it always has — that is the DEGRADED path (a Jira that will not
   * answer), and it stays the default so every test written before the ticket
   * read existed goes on exercising the behaviour it was written for.
   */
  private readonly tickets = new Map<string, TicketSnapshot>();
  /** Records every `getTicket`, so a test can prove a path did not ask. */
  readonly ticketReads: string[] = [];

  putTicket(snapshot: TicketSnapshot): void {
    this.tickets.set(snapshot.key, snapshot);
  }

  getTicket(key: TicketKey): Promise<TicketSnapshot> {
    this.ticketReads.push(key);
    const snapshot = this.tickets.get(key);
    // Unseeded is "this Jira will not answer for that ticket", which is exactly
    // what the real DC driver does for an issue the token cannot see.
    if (snapshot === undefined) throw new CapabilityNotSupportedError("WorkPort", "getTicket");
    return Promise.resolve(snapshot);
  }
  updateComment(_key: TicketKey, _commentId: string, _body: unknown): Promise<void> {
    throw new CapabilityNotSupportedError("WorkPort", "updateComment");
  }
  setLabels(_key: TicketKey, _labels: string[]): Promise<void> {
    throw new CapabilityNotSupportedError("WorkPort", "setLabels");
  }
  assign(_key: TicketKey, _accountId: string | null): Promise<void> {
    throw new CapabilityNotSupportedError("WorkPort", "assign");
  }
  createLinkedIssue(): Promise<{ key: TicketKey }> {
    throw new CapabilityNotSupportedError("WorkPort", "createLinkedIssue");
  }
  transition(_key: TicketKey, _transitionId: string): Promise<void> {
    throw new CapabilityNotSupportedError("WorkPort", "transition");
  }
}

/** Reads a verified Jira payload through the real driver parser. */
export class FakeWorkEventReader implements WorkEventReader {
  read(payload: unknown): WorkEvent {
    const event = parseWebhookEvent(payload);
    if (event.kind === "issue") {
      // Status/issuetype/assignee are read the same way the real reader
      // (`apps/deploy/src/work-events.ts`) reads them, so a flow-selection test
      // driving a real signed delivery exercises the real payload shape.
      const status = nameOf(event.issue, "status");
      const issueType = nameOf(event.issue, "issuetype");
      const assignee = assigneeOf(event.issue);
      return {
        kind: "issue",
        ticketKey: event.ticketKey,
        labels: labelsOf(event.issue),
        ...(status === null ? {} : { status }),
        ...(issueType === null ? {} : { issueType }),
        ...(assignee === null ? {} : { assignee }),
      };
    }
    if (event.kind === "comment") return { kind: "comment", ticketKey: event.ticketKey };
    return { kind: "other" };
  }
}

function fieldsOf(issue: unknown): Record<string, unknown> | null {
  const fields = (issue as { fields?: unknown } | null)?.fields;
  return typeof fields === "object" && fields !== null ? (fields as Record<string, unknown>) : null;
}

function labelsOf(issue: unknown): string[] {
  const labels = fieldsOf(issue)?.["labels"];
  return Array.isArray(labels) ? labels.filter((label): label is string => typeof label === "string") : [];
}

function nameOf(issue: unknown, field: string): string | null {
  const value = fieldsOf(issue)?.[field];
  const name = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["name"] : undefined;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

function assigneeOf(issue: unknown): string | null {
  const value = fieldsOf(issue)?.["assignee"];
  if (typeof value !== "object" || value === null) return null;
  const assignee = value as Record<string, unknown>;
  for (const key of ["accountId", "name", "key", "emailAddress"]) {
    const found = assignee[key];
    if (typeof found === "string" && found.trim().length > 0) return found.trim();
  }
  return null;
}

/** Basic-auth Service Hook authentication, the shape the ADO driver expects. */
export class FakeCiPort implements CiPort {
  constructor(
    private readonly expectedAuthorization: string,
    private readonly signal: CiResultSignal | null,
  ) {}

  parseBuildEvent(request: CiWebhookRequest): Promise<CiResultSignal | null> {
    const header = Object.entries(request.headers).find(
      ([name]) => name.toLowerCase() === "authorization",
    )?.[1];
    if (header !== this.expectedAuthorization) {
      throw new Error("ado webhook: authentication failed");
    }
    // Authenticated but unparseable payloads are "not a build result", never a
    // reason to pretend one happened.
    return Promise.resolve(typeof request.body === "object" && request.body !== null ? this.signal : null);
  }
}

export class FakeRunGateway implements RunGateway {
  readonly states = new Map<string, WorkflowRunState>();
  readonly signals: Array<{ workflowId: string; name: string; arg: unknown }> = [];
  readonly started: SignalWithStartInput[] = [];
  pingFails = false;

  ping(): Promise<void> {
    return this.pingFails ? Promise.reject(new Error("temporal down")) : Promise.resolve();
  }

  list(options?: { limit?: number; onlyRunning?: boolean }): Promise<RunSummary[]> {
    const runs = [...this.states.values()]
      .filter((state) => options?.onlyRunning !== true || state.status !== "done")
      .map<RunSummary>((state) => ({
        workflowId: `maestro-${state.ticketKey}`,
        ticketKey: state.ticketKey,
        runId: state.runId,
        status: state.status === "done" ? "completed" : "running",
        startedAt: state.startedAt,
        closedAt: null,
      }));
    return Promise.resolve(options?.limit === undefined ? runs : runs.slice(0, options.limit));
  }

  queryRunState(workflowId: string): Promise<WorkflowRunState | null> {
    return Promise.resolve(this.states.get(workflowId) ?? null);
  }

  /**
   * An exact lookup over every execution, with no page limit — the property
   * the real gateway's `RunId=` query has and the scan it replaced did not.
   * A fake that only searched its first N entries would let the horizon bug
   * back in through the test double.
   */
  findByRunId(runId: string): Promise<RunSummary | null> {
    for (const [workflowId, state] of this.states) {
      if (state.runId !== runId) continue;
      return Promise.resolve({
        workflowId,
        ticketKey: state.ticketKey,
        runId: state.runId,
        status: state.status === "done" ? "completed" : "running",
        startedAt: state.startedAt,
        closedAt: null,
      });
    }
    return Promise.resolve(null);
  }

  signal(workflowId: string, name: string, arg: unknown): Promise<SignalOutcome> {
    if (!this.states.has(workflowId)) return Promise.resolve("no_run");
    this.signals.push({ workflowId, name, arg });
    return Promise.resolve("delivered");
  }

  signalWithStart(input: SignalWithStartInput): Promise<StartOutcome> {
    const workflowId = `maestro-${input.ticket}`;
    const existed = this.states.has(workflowId);
    this.started.push(input);
    if (!existed) {
      this.states.set(workflowId, {
        runId: `run-${input.ticket}`,
        ticketKey: input.ticket,
        step: "0",
        status: "running",
        startedAt: "2026-08-09T09:00:00.000Z",
        updatedAt: "2026-08-09T09:00:00.000Z",
      });
    }
    if (input.signal !== undefined) {
      this.signals.push({ workflowId, name: input.signal.name, arg: input.signal.args[0] });
    }
    return Promise.resolve({ workflowId, started: !existed });
  }

  /** Put a run at an open gate so a decision has something to close. */
  openGate(ticket: TicketKey, step: WorkflowRunState["step"]): void {
    const workflowId = `maestro-${ticket}`;
    this.states.set(workflowId, {
      runId: `run-${ticket}`,
      ticketKey: ticket,
      step,
      status: "gate",
      startedAt: "2026-08-09T09:00:00.000Z",
      updatedAt: "2026-08-09T09:00:00.000Z",
    });
  }

}
