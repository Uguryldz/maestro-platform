import {
  JournalActor,
  TicketKey,
  type WorkflowRunState,
  type WorkflowRunStatus,
} from "@maestro/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import type { RunRecord } from "../read-models.js";
import { badRequest, notFound } from "../errors.js";
import { workflowIdFor } from "../gateway.js";
import { classifyingFields, runIntake } from "../jira-intake.js";
import { assertProjectAccess } from "./access.js";
import { blankAsAbsent } from "./paging.js";
import { pageBody, pageOf, visibleProjects } from "./paging.js";

/**
 * The run-shaped half of Studio's read surface: the ticket list, the detail
 * header, and the three sub-resources a detail screen opens (journal, summary,
 * evidence). Every one of them authenticates and every one is scoped to the
 * projects the caller belongs to (M86) — a session is not a licence to read a
 * stranger's ticket, and the filtering happens in the STORE rather than after,
 * so the page size a caller asked for is a page of rows they may actually see.
 *
 * It also holds the one WRITE on this surface: starting a run by hand.
 */

/** Who may put a ticket on the engine by hand. Mirrors the pilot's write roles. */
export const RUN_START_ROLES = ["admin", "tech-lead"] as const;

export async function studioRunRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = authGuard(deps);

  /**
   * Start a run for a ticket, by hand.
   *
   * Intake has one caller today — the Jira webhook — and that is not enough on
   * its own. Jira Cloud's driver cannot verify a webhook signature at all
   * (`verifyWebhook` throws `CapabilityNotSupported`), and a Data Center behind
   * a firewall may not be able to reach this service either. Without an
   * operator-triggered path, such a deployment has a workflow engine nothing
   * can put work on.
   *
   * It goes through `runIntake` rather than straight to `signalWithStart`, so a
   * hand-started run passes the same gates a webhook-started one does: the
   * project must be bound and active, the kill switch must be off, and an
   * application must resolve. `explicit: true` says a person asked for this by
   * name, which is what satisfies the opt-in rule (M48a) — the same thing
   * `/ai-start` does from a Jira comment.
   *
   * The ticket is READ before intake so this path can answer the question
   * `flow-decision.ts` asks: which ListeningRule matches? A caller that omits
   * `issueType`/`assignee` matches NO rule and silently falls back to the
   * deployment default — which cost OPS-57 its status map. The webhook knows
   * these fields because the event carries them; pressing Start does not, so
   * we fetch them. Without this the two entry points run the same ticket under
   * two different flows, and the hand-started one is the quiet, wrong half.
   */
  app.post(
    "/studio/runs/:ticket/start",
    { preHandler: [preHandler, requireAnyRole(...RUN_START_ROLES)] },
    async (request, reply) => {
      const parsed = TicketKey.safeParse((request.params as { ticket?: string }).ticket);
      if (!parsed.success) throw badRequest("ticket_key");
      const ticket = parsed.data;

      assertProjectAccess(sessionOf(request), ticket);

      const outcome = await runIntake(deps, {
        ticket,
        actor: sessionOf(request).userId,
        explicit: true,
        // Best-effort: a Jira that will not answer must not block a hand start.
        // See `classifyingFields` — it degrades to the pre-existing behaviour
        // rather than turning a reachable engine into a 500.
        ...(await classifyingFields(deps, ticket, (error) => {
          request.log.warn({ err: error, ticket }, "ticket snapshot unavailable at hand start");
        })),
      });
      // 202, not 200: the run is accepted onto the engine, and what happens
      // next is a workflow's business rather than this request's result.
      return reply.code(202).send(outcome);
    },
  );

  /**
   * Archive or un-archive a run (0019).
   *
   * WHAT THIS IS NOT: a delete. There is no route that deletes a run and there
   * must not be — the row is pointed at by its journal, its step events and its
   * evidence package, and the M33 chain records what it did. This endpoint
   * writes ONE nullable column that decides which listing the row appears in by
   * default. The audit trail is untouched; the dashboard is what changes.
   *
   * WHY IT EXISTS: twelve `fail` rows from an evening of experiments sat on the
   * board for a day, all stopped at the same step, nineteen to twenty-two hours
   * old, and a new operator opening the panel read them as "the product is
   * broken". The runs are real history that must survive, and the board is a
   * working surface that must not be permanently occupied by work already dealt
   * with. Those two requirements only fit together if "retired from the view"
   * is a thing an operator can say.
   *
   * REVERSIBLE, and that is load-bearing rather than a nicety. `archived:
   * false` is a first-class body value, not a hidden admin path, because an
   * operator who cannot undo will not archive at all — and a board nobody dares
   * tidy is the state this endpoint exists to end. It is also why the store
   * writes `NULL` rather than appending to an archive table.
   *
   * `RUN_START_ROLES` (admin, tech-lead), mirrored deliberately: deciding what
   * the whole team's dashboard shows is the same weight of decision as putting
   * a ticket on the engine, and both are the kind an operator has to be able to
   * point at a name for afterwards. A viewer may read the archive — the list
   * route takes any session — but may not move a run into or out of it.
   */
  app.put(
    "/studio/runs/:ticket/archive",
    { preHandler: [preHandler, requireAnyRole(...RUN_START_ROLES)] },
    async (request, reply) => {
      const ticket = ticketParam(request.params);
      assertProjectAccess(sessionOf(request), ticket);

      const body = ArchiveBody.safeParse(request.body);
      if (!body.success) throw badRequest("invalid_archive_request");

      // The clock comes from `deps`, not `new Date()`: the timestamp written to
      // the column and the `at` on the audit entry below have to be the same
      // moment, or the record and the chain disagree about when an operator did
      // this — and the chain is the half a reviewer trusts.
      const at = body.data.archived ? deps.clock.now() : null;
      // 404 BEFORE the audit entry, deliberately: an entry for a ticket that
      // does not exist would put a fictional operator action into an
      // append-only chain, where it can never be corrected.
      if (!(await deps.read.runs.setArchived(ticket, at))) throw notFound("no_run", { ticket });

      // `PARAM_CHANGED`, matching how `listening.ts` and `connections.ts` audit
      // their writes: this is an operator changing how the platform PRESENTS a
      // record, which is the same governance category as changing a rule. It is
      // deliberately NOT `RETENTION_ARCHIVE` — that action means data was moved
      // or destroyed under a retention policy (`packages/runners` records it
      // when a workspace volume is actually removed), and borrowing it here
      // would tell an auditor that a run's evidence had been disposed of when
      // every byte of it is still in place.
      await deps.audit.append({
        actor: sessionActor(sessionOf(request)),
        action: "PARAM_CHANGED",
        subject: `run:${ticket}`,
        at: deps.clock.now(),
        meta: { surface: "runs", verb: body.data.archived ? "archived" : "unarchived" },
      });

      return reply.code(200).send({ ticketKey: ticket, archivedAt: at?.toISOString() ?? null });
    },
  );

  /**
   * The ticket list (Studio's `tickets` screen). Joins the workflow's own state
   * — step, status, risk — onto the platform record, because a list that showed
   * one without the other would make a caller open every row to find the gate.
   */
  app.get("/studio/runs", { preHandler }, async (request, reply) => {
    const filters = ListQuery.safeParse(request.query);
    if (!filters.success) throw badRequest("invalid_query");
    const page = pageOf(request.query);
    const session = sessionOf(request);

    const records = await deps.read.runs.list({
      ...page,
      appId: filters.data.appId ?? null,
      projectKeys: visibleProjects(session),
      // DEFAULT ACTIVE (0019). This is the whole read half of archiving: a
      // caller that says nothing gets the board without the runs an operator
      // has already dealt with. Twelve day-old `fail` rows greeting a new
      // operator as "the product is broken" is the reason the column exists,
      // and defaulting the other way would leave them there.
      //
      // The default lives HERE rather than in the store so the store has no
      // opinion to disagree with, and so this line is the one place to read to
      // know what an unqualified `GET /studio/runs` means.
      archived: filters.data.archived ?? "active",
    });

    const rows = [];
    for (const record of records.items) {
      // A query that FAILS is not a run with no state — it is one whose state
      // could not be read, and the two must not share a fate. The engine
      // answers per workflow: a single execution left behind by an older build
      // ("no such function is exported by the workflow bundle"), or a worker
      // that is momentarily down, made this loop throw and took the WHOLE list
      // with it. Studio then rendered "no workflows yet" over a catalog holding
      // twenty-two of them — the exact failure `read-models.ts` exists to
      // prevent, arriving through the engine instead of the store.
      //
      // So the row survives with `state: null`, which the client already
      // renders as "not started". `request.log.warn` keeps the reason where an
      // operator can find it; it must not reach the response, where it would
      // leak engine internals to a browser.
      let state = null;
      try {
        state = await deps.runs.queryRunState(workflowIdFor(record.ticketKey));
      } catch (error) {
        request.log.warn(
          { err: error, ticket: record.ticketKey },
          "run state unreadable; listing the row without it",
        );
      }
      state = reconciledState(record, state);
      // A platform record with no execution is a run that has not started yet;
      // it is still the caller's ticket, so it is listed with a null state
      // rather than hidden — hiding it would make the queue look empty.
      //
      // The status filter runs here rather than in the store because status
      // lives in the workflow engine, not in the catalog. That makes a filtered
      // page a SUBSET of a full one: `nextCursor` still advances by the rows the
      // store returned, so paging keeps making progress instead of stalling on
      // a page whose every row was filtered out.
      if (filters.data.status !== undefined && state?.status !== filters.data.status) continue;
      rows.push({ ...record, state });
    }

    return reply.code(200).send(pageBody({ items: rows, nextCursor: records.nextCursor }));
  });

  /**
   * The detail header. Returns the platform record and the live workflow state
   * together: Studio's detail screen renders both, and two round trips would
   * let it paint a step from one moment beside a status from another.
   */
  app.get("/studio/runs/:ticket", { preHandler }, async (request, reply) => {
    const ticket = ticketParam(request.params);
    assertProjectAccess(sessionOf(request), ticket);

    const record = await deps.read.runs.get(ticket);
    if (record === null) throw notFound("no_run", { ticket });
    // Same guard as the list above, and for the same reason: a query that
    // FAILS is not a run with no state. Six executions left behind by an older
    // build made this route answer 500 for six of twenty-two tickets — the
    // first row of the list among them, so the first click a reviewer made
    // landed on an error page for a run whose record was right there.
    // The same reconciliation the list applies, for the same reason and so the
    // two can never disagree: a row the list shows as `fail` must not turn back
    // into `running` the moment a reviewer clicks it.
    const state = reconciledState(record, await queryStateOrNull(deps, request, ticket));
    const app_ = record.appId === null ? null : await deps.read.apps.get(record.appId);

    return reply.code(200).send({ run: record, state, application: app_ });
  });

  /**
   * The ticket journal (M30). Append-only upstream and read-only here: there is
   * no route that writes an entry, because an entry Studio could author would
   * be an entry the evidence package cannot vouch for.
   */
  app.get("/studio/runs/:ticket/journal", { preHandler }, async (request, reply) => {
    const ticket = ticketParam(request.params);
    assertProjectAccess(sessionOf(request), ticket);

    const filter = JournalQuery.safeParse(request.query);
    if (!filter.success) throw badRequest("invalid_query");

    const runId = await runIdOf(deps, ticket);
    const page = await deps.read.journal.list(runId, {
      ...pageOf(request.query),
      actor: filter.data.actor ?? null,
    });
    return reply.code(200).send(pageBody(page));
  });

  /** The living summary (M30) — derived from the journal, never authored here. */
  app.get("/studio/runs/:ticket/summary", { preHandler }, async (request, reply) => {
    const ticket = ticketParam(request.params);
    assertProjectAccess(sessionOf(request), ticket);

    const runId = await runIdOf(deps, ticket);
    const text = await deps.read.journal.summary(runId);
    // `null` is an answer, not a 404: the run exists and has simply not
    // produced a summary yet, and a 404 would make Studio show "no such run".
    return reply.code(200).send({ ticketKey: ticket, runId, summary: text });
  });

  /**
   * The evidence package manifest (M56). The manifest only — the files
   * themselves live behind the storage port and are fetched with their own
   * signed URLs, so this route never becomes a way to stream an archive
   * through the API process.
   */
  app.get("/studio/runs/:ticket/evidence", { preHandler }, async (request, reply) => {
    const ticket = ticketParam(request.params);
    assertProjectAccess(sessionOf(request), ticket);

    const runId = await runIdOf(deps, ticket);
    const manifest = await deps.read.evidence.get(runId);
    if (manifest === null) throw notFound("no_evidence", { ticket });
    return reply.code(200).send(manifest);
  });

  /**
   * Per-run consumption (M16/M55). Rows come from the gateway call log, so the
   * totals are a sum of records that exist rather than a number this route
   * invented — `usd` is null on subscription drivers and stays null here.
   */
  app.get("/studio/runs/:ticket/cost", { preHandler }, async (request, reply) => {
    const ticket = ticketParam(request.params);
    assertProjectAccess(sessionOf(request), ticket);

    const runId = await runIdOf(deps, ticket);
    const page = await deps.read.cost.calls({ ...pageOf(request.query), runId });
    return reply.code(200).send({ ...pageBody(page), totals: totalsOf(page.items) });
  });
}

const ListQuery = z.object({
  // `blankAsAbsent`, not a bare `.optional()`: a browser serialises an unset
  // filter as `?appId=&status=`, and rejecting that failed the WHOLE request —
  // the dashboard's archive list showed "0" for every bucket while the data
  // was right there. See `blankAsAbsent` in ./paging.ts.
  appId: blankAsAbsent(z.string().min(1).max(64)).optional(),
  status: blankAsAbsent(
    z.enum(["running", "gate", "queued", "fail", "handover", "done", "cancelled"]),
  ).optional(),
  /**
   * Which side of the archive line to list (0019). Absent means `"active"` —
   * see the route, which owns that default.
   *
   * `blankAsAbsent` for the same reason the two filters above use it: Studio
   * serialises an unset toggle as `?archived=`, and rejecting that would fail
   * the WHOLE request, blanking a dashboard whose data was right there. That
   * exact bug has already been paid for once on this endpoint.
   */
  archived: blankAsAbsent(z.enum(["active", "archived", "all"])).optional(),
});

/**
 * The archive endpoint's body (0019).
 *
 * `.strict()` and a REQUIRED boolean: "archive this" and "un-archive this" are
 * opposite instructions, and a defaulted or misspelled field would let a
 * request that meant one silently perform the other. An operator pressing
 * "Geri al" must not be able to archive the run again because a key name
 * drifted.
 */
const ArchiveBody = z.object({ archived: z.boolean() }).strict();

const JournalQuery = z.object({ actor: JournalActor.optional() });

/** Sum of the rows on THIS page; a running total would need the whole log. */
function totalsOf(
  calls: readonly { usd: number | null; tokensIn: number; tokensOut: number }[],
): { usd: number; tokensIn: number; tokensOut: number; calls: number } {
  return {
    usd: calls.reduce((sum, call) => sum + (call.usd ?? 0), 0),
    tokensIn: calls.reduce((sum, call) => sum + call.tokensIn, 0),
    tokensOut: calls.reduce((sum, call) => sum + call.tokensOut, 0),
    calls: calls.length,
  };
}

/**
 * The run id the journal and the evidence package are keyed by. Resolved from
 * the live execution rather than derived from the ticket: a ticket that was
 * retried has more than one run id in its history, and guessing would serve
 * one run's journal under another's name.
 */
async function runIdOf(deps: ResolvedDeps, ticket: string): Promise<string> {
  // Unreadable is NOT the same as absent, but here both end the request: the
  // journal and the evidence package are keyed by run id, and serving them
  // under a guessed id would attribute one run's history to another. A 404
  // says "no run id to work from", which is true either way — and unlike a
  // 500, it is a sentence the screen already knows how to render.
  const state = await deps.runs.queryRunState(workflowIdFor(ticket)).catch(() => null);
  if (state === null) throw notFound("no_run", { ticket });
  return state.runId;
}

/**
 * The run's live state, or `null` when the engine cannot answer for it.
 *
 * Written once and used by both the list and the detail route so the two can
 * never drift: the list already treated an unreadable execution as `state:
 * null`, the detail route threw, and the same ticket therefore appeared in the
 * list and 500'd when clicked.
 */
/**
 * The statuses that mean "this run is over" — the same set the run-context
 * store enforces on the database side (`TERMINAL_STATUSES`, run-context.ts).
 * Kept as a literal here rather than imported because the BFF does not depend
 * on `apps/deploy`; the two agreeing is asserted by a test rather than by a
 * shared import that would invert the dependency.
 */
const TERMINAL: readonly WorkflowRunStatus[] = ["fail", "done", "cancelled"];

/**
 * Which of two sources tells the truth about a run's status.
 *
 * THE RULE: a TERMINAL platform record wins; anything else defers to the
 * engine.
 *
 * Both halves earn their place.
 *
 * **Terminal record wins.** A workflow whose activity exhausted its retries
 * dies inside that activity, so it never reaches the code that would record
 * how it ended. Temporal answers `queryRunState` from the last state the
 * workflow managed to write, which is the step it was on when it died — so a
 * dead run answers `running` indefinitely. That is not the engine lying; it is
 * the engine faithfully reporting a history that stopped. The reconciler
 * compares the two at boot and writes the verdict to `WorkflowRun.status`, and
 * that verdict is the platform's: once the platform considers a run closed, it
 * is closed whether or not the engine's own history says so. Measured on the
 * live board before this rule existed: eleven `fail` rows rendered as twelve
 * "running" and three "gate".
 *
 * **Otherwise the engine wins.** Step progress happens IN the engine and
 * reaches the row afterwards, so for a run that is genuinely alive the engine's
 * answer is the fresher of the two. A row still reading `running` while the
 * workflow has parked at a gate is a stale row, not a contradiction — and
 * showing `running` there would hide a gate waiting on a human, which is the
 * expensive direction to be wrong in.
 *
 * FAIL-CLOSED, and this is the asymmetry that decides ties: showing a finished
 * run as active buries a pending approval among work nobody needs to look at,
 * while showing an active run as finished merely draws an extra glance. So when
 * the two sources disagree about whether a run is OVER, "over" wins.
 *
 * `state === null` is preserved exactly: an engine that cannot answer must not
 * cost the row its place in the list (that regression blanked Studio over a
 * catalog of twenty-two runs). The record's own status is enough to synthesise
 * a state only when it is terminal — and even then only the fields the record
 * actually holds; `step` and `runId` are the engine's to know, and this route
 * does not invent them.
 */
export function reconciledState(
  record: RunRecord,
  state: WorkflowRunState | null,
): WorkflowRunState | null {
  // Neither source has a status: `null`, not a guess. A row still lists.
  if (record.status === null) return state;
  if (!TERMINAL.includes(record.status)) return state;
  // Terminal record, no engine answer: there is no `WorkflowRunState` to
  // return — `runId` and `step` are required and the catalog holds neither, and
  // filling them in would attribute a made-up step to a real run. The row is
  // listed with `state: null`, exactly as before.
  if (state === null) return null;
  // Terminal record over a live engine answer: keep the engine's step, runId
  // and clocks — they are real — and correct only the verdict.
  return { ...state, status: record.status };
}

async function queryStateOrNull(
  deps: ResolvedDeps,
  request: { log: { warn: (obj: unknown, msg: string) => void } },
  ticket: string,
): Promise<WorkflowRunState | null> {
  try {
    return await deps.runs.queryRunState(workflowIdFor(ticket));
  } catch (error) {
    request.log.warn({ err: error, ticket }, "run state unreadable; answering without it");
    return null;
  }
}

function ticketParam(params: unknown): string {
  const parsed = z.object({ ticket: TicketKey }).safeParse(params);
  if (!parsed.success) throw badRequest("invalid_ticket_key");
  return parsed.data.ticket;
}
