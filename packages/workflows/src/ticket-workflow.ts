import { condition, continueAsNew, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type {
  DataClass,
  FlowType,
  RiskTier,
  StepId,
  TicketKey,
  WorkMode,
  WorkflowRunState,
  WorkflowRunStatus,
} from "@maestro/contracts";
import type {
  EngineeringResult,
  MaestroActivities,
  PrRef,
  StatusMovePoint,
} from "./activities.js";
import { awaitGreenBuild, runEngineeringLoop } from "./engineering-loop.js";
import { answerModeRequests, assertNotKilled, awaitGate } from "./gate-loop.js";
import { gatesFor, planFor } from "./gates.js";
import { countRejection, emptyInbox, initialRunState, rejectionCounts } from "./run-state.js";
import {
  ciResultSignal,
  clarificationAnsweredSignal,
  gateDecisionSignal,
  killSwitchSignal,
  modeChangeSignal,
  prChangesRequestedSignal,
  runStateQuery,
} from "./signals.js";

/**
 * The delivery workflow: one Temporal execution per ticket, from the webhook
 * that created it to the merge that closes it.
 *
 * Three properties this file exists to guarantee, and which every change here
 * must preserve:
 *
 *  1. **It waits without cost.** A gate open for sixteen days is a `condition`,
 *     not a poll. Nothing is auto-approved, ever, and nothing times out into a
 *     decision — only reminders escalate (M88).
 *  2. **Context survives.** Engineering resumes the SAME agent session after a
 *     rejection, a CI failure or a PR thread (M30), and the resume token is
 *     carried across `continueAsNew` in the input — a rejection loop is a
 *     continuation, not a restart (M29).
 *  3. **It fails closed.** Scans, CI origin, gate authority and the kill switch
 *     all stop the flow rather than let it through. The only way forward is a
 *     positive result.
 *
 * Determinism: no `Math.random()`, no `process.env`, no I/O, and the only clock
 * reading is `workflowNow()` below. Everything real is an activity; every
 * decision is a pure function in `gates.ts`.
 */

const acts = proxyActivities<MaestroActivities>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 3 },
});

/**
 * Thinking roles get a patient proxy. `queued` (M55: the subscription pool is
 * full) comes back as a retryable failure, and waiting for a quota window is a
 * legitimate hours-long wait — a three-attempt budget would drop the run.
 *
 * The budget is UNLIMITED rather than fifty, because fifty attempts on the
 * ladder below tops out around fifty hours, and a WEEKLY subscription quota can
 * legitimately be spent for longer than that: a run told "come back on Monday"
 * must not be dropped on Saturday. This is not an infinite-retry hazard — a
 * quota failure carries `nextRetryDelay` naming the moment the window reopens,
 * so the run sleeps until then and costs nothing.
 *
 * What this policy CANNOT promise is that every non-quota fault stops early:
 * to Temporal a plain thrown error is retryable, so a driver exception would
 * ride this same unlimited ladder. The classification therefore lives in the
 * ACTIVITIES, where it is replay-safe to change: `resolveOutcome` throws
 * `blocked` non-retryably, and `guardModelCall` (impl/outcome.ts) bounds a
 * rejected model key at `AUTH_RETRY_MAX_ATTEMPTS` with a journal line per
 * attempt — the install rehearsal found a 403'd key retrying here for days
 * with the run silently `running`. The retry OPTIONS below are deliberately
 * untouched by that fix: they are recorded into workflow history when an
 * activity is scheduled, so editing them would change the commands a replay
 * regenerates, while activity-side classification changes nothing Temporal
 * compares.
 *
 * `POSITIVE_INFINITY` is the SDK's spelling of "no limit": it drops the field,
 * which is the protocol's default. A literal `0` does NOT mean unlimited here —
 * `compileRetryPolicy` rejects it, and the run fails on its first thinking call.
 */
const thinkActs = proxyActivities<MaestroActivities>({
  startToCloseTimeout: "30 minutes",
  retry: {
    maximumAttempts: Number.POSITIVE_INFINITY,
    initialInterval: "1 minute",
    maximumInterval: "1 hour",
    backoffCoefficient: 2,
  },
});

/** Long jobs get their own budget; the engineer may legitimately run for hours. */
const longActs = proxyActivities<MaestroActivities>({
  startToCloseTimeout: "4 hours",
  retry: { maximumAttempts: 1 },
});

/**
 * The workflow clock, as an ISO string.
 *
 * Inside the Temporal sandbox `Date.now()` is replaced by the SDK with the
 * deterministic workflow time, so this replays identically. It is wrapped here,
 * once, so the rule the rest of this file follows — no ambient time anywhere
 * else — stays mechanically checkable.
 */
function workflowNow(): string {
  return new Date(Date.now()).toISOString();
}

export interface TicketWorkflowInput {
  ticket: TicketKey;
  /**
   * The PRIMARY application this ticket runs against — OPTIONAL, because an
   * analysis-only binding legitimately has none: the analysis document is
   * written from the ticket text, and the repository only ever ENRICHED it
   * (step 3ö's read-only discovery). Intake refuses to start a code-writing
   * flow without one (`no_application`, M99 tier ③), so absence here means
   * "an `analiz` run in ticket-text mode" and nothing else.
   *
   * REPLAY SAFETY: every run started before this field widened carries an
   * appId, and the appId-present path below is command-for-command what it was
   * — the only new branch (skip discovery, journal why) is reachable only when
   * the field is absent, which no recorded history has.
   */
  appId?: string;
  mode: WorkMode;
  dataClass: DataClass;
  /**
   * State that must OUTLIVE a `continueAsNew` (M29). A rejection loop starts a
   * new execution with a fresh history, so anything held in a local is gone:
   * the strike counter would reset (M54 never fires) and the agent session
   * would be lost on the second rejection (M30). Carrying it in the input is
   * what makes the continuation a continuation rather than a restart.
   */
  rejectionCounts?: Record<string, number>;
  /** The agent session to resume; `null`/absent starts a fresh one. */
  resumeToken?: string | null;
  /** The tier the analysis established, so a continuation reuses its gate set. */
  risk?: RiskTier;
  /**
   * What the listening rule asked for (`planFor`). Absent means the full
   * pipeline — a ticket is never silently under-processed because no rule
   * matched.
   */
  flow?: FlowType | null;
  /**
   * Where the listening rule wants the ticket to SIT on the board at each point
   * of the flow ("durum eşlemesi"). Absent, null or empty is comment-only mode
   * — what every run did before this existed, and still the default.
   *
   * It travels in the input for the same three reasons `flow` does, and one
   * more:
   *
   *  - `packages/workflows` may not read a database (M44), so the rules cannot
   *    be looked up from in here.
   *  - Re-reading them from an ACTIVITY would work, but it would mean a run
   *    could close under a different rule than the one that started it: an
   *    admin editing a rule at lunchtime would change where a morning's tickets
   *    land, and the run's own history would not say why.
   *  - Pinning the map at start makes the whole thing REPLAYABLE. The workflow
   *    decides whether to move at all, and a decision derived from an argument
   *    replays identically forever.
   *
   * The shape is declared here rather than imported from `apps/bff` (which owns
   * `StatusMap`, and depends on this package, not the other way round). It is
   * deliberately a plain optional-string record: this side never validates the
   * names — the BFF's Zod schema did that on the way in — it only decides which
   * of them to hand to the activity.
   */
  statusMap?: TicketStatusMap | null;
}

/**
 * The five points a rule may map, as the workflow reads them. Mirrors
 * `StatusMapSchema` in `apps/bff/src/listening-store.ts`; that file is the
 * validator and this is the consumer, so a field added there and not here is
 * simply a point this workflow does not act on yet.
 */
export interface TicketStatusMap {
  onStart?: string;
  onNeedInfo?: string;
  onReview?: string;
  onRejected?: string;
  onDone?: string;
  reassignOnNeedInfo?: boolean;
}

export async function ticketWorkflow(input: TicketWorkflowInput): Promise<WorkflowRunStatus> {
  const ticket = input.ticket;
  const state = initialRunState({
    startedAt: new Date(workflowInfo().startTime).toISOString(),
    mode: input.mode,
    risk: input.risk ?? "orta",
    resumeToken: input.resumeToken ?? null,
    rejectionCounts: input.rejectionCounts,
  });
  const inbox = emptyInbox();

  setHandler(runStateQuery, (): WorkflowRunState => ({
    runId: workflowInfo().runId,
    ticketKey: ticket,
    step: state.step,
    status: state.status,
    risk: state.risk,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  }));

  // Handlers only ever PUSH. Nothing here consumes, decides or clears — the
  // loops below do that, which is what stops a signal from being overwritten
  // between arriving and being read.
  setHandler(gateDecisionSignal, (d) => void inbox.decisions.push(d));
  setHandler(clarificationAnsweredSignal, () => void (inbox.clarified = true));
  setHandler(ciResultSignal, (s) => void inbox.ciResults.push(s));
  setHandler(prChangesRequestedSignal, (t) => void (inbox.changesRequested = t.text));
  setHandler(modeChangeSignal, (m) => void inbox.modeRequests.push(m));
  setHandler(killSwitchSignal, (k) => void (state.killed = k.level));

  const gate = (at: StepId) => awaitGate(acts, state, inbox, ticket, at);
  const stopIfKilled = () => assertNotKilled(acts, state, ticket);

  /**
   * Move the ticket on the operator's board, if their rule asked for it.
   *
   * Two things are load-bearing about this being a local function rather than
   * an unconditional activity call at each point.
   *
   * First, an unmapped point schedules NOTHING. A run in comment-only mode
   * (every rule written before the status map existed, and every rule that
   * deliberately stays that way) produces exactly the history it produced
   * before — no activity, no journal line, no retry budget spent on a decision
   * that was already "do not move". "Absent means do not move at that point" is
   * the map's central promise, and it is kept HERE, in the deterministic half,
   * rather than by an activity that would have to be scheduled to say no.
   *
   * Second, the result is DISCARDED on purpose, and nothing branches on it. The
   * policy the user chose is warn-but-continue: a ticket that could not be
   * moved is a board that is out of date, while a run that stopped over it is
   * work that did not get done. The activity never rejects (see
   * `impl/status-move.ts`) and writes its own journal line with the reason, so
   * the operator learns why without the flow ever learning it happened.
   */
  const moveStatus = async (at: StatusMovePoint, to: string | undefined): Promise<void> => {
    const alsoReporter = at === "need_info" && input.statusMap?.reassignOnNeedInfo === true;
    if (to === undefined && !alsoReporter) return;
    await acts.moveTicketStatus(ticket, {
      at,
      ...(to === undefined ? {} : { status: to }),
      ...(alsoReporter ? { toReporter: true } : {}),
    });
  };

  /**
   * Every step transition goes through here, which is what makes this the one
   * place the kill switch has to be checked. Guarding individual loops instead
   * left whole chains of steps running after the stop — scans, reviews and test
   * runs are all new sandbox work — because each loop only looked once, at its
   * own top.
   */
  const goto = async (next: StepId, note: string): Promise<void> => {
    await stopIfKilled();
    await answerModeRequests(acts, state, inbox, ticket);
    state.step = next;
    // D1: this used to report `startedAt` forever, so a run that had been
    // working for six hours looked untouched in Studio.
    state.updatedAt = workflowNow();
    await acts.journal(ticket, "other", `adım ${next}`, note);
  };

  const handOver = async (reason: string): Promise<WorkflowRunStatus> => {
    state.status = "handover";
    await acts.handOverToHuman(ticket, reason);
    return state.status;
  };

  const continueRun = (): Promise<never> =>
    continueAsNew<typeof ticketWorkflow>({
      ...input,
      risk: state.risk,
      resumeToken: state.resumeToken,
      rejectionCounts: rejectionCounts(state),
    });

  // ── 0 · work mode ────────────────────────────────────────────────────────
  await goto("0", `work mode: ${state.mode} · veri sınıfı: ${input.dataClass}`);
  if (state.mode === "human_only") {
    // M73: the humans do the work; Maestro only keeps the record.
    await acts.journal(ticket, "other", "human-only", "Maestro yalnız kanıt topluyor");
    return handOver("human_only");
  }

  // ── 2 · intake, 2b · clarification ───────────────────────────────────────
  await goto("2", "ticket tamlık kontrolü");
  const intake = await thinkActs.runIntake(ticket);
  if (!intake.complete) {
    await goto("2b", "reporter'a soru soruldu");
    state.status = "gate";
    // Before the question, not after: the board should say "waiting on the
    // reporter" by the time the reporter is looking at the comment that asks
    // them for something. `reassignOnNeedInfo` rides along here too, so the
    // ticket lands in their queue as well as in their column.
    await moveStatus("need_info", input.statusMap?.onNeedInfo);
    await acts.askClarification(ticket, intake.question ?? "");
    // Unbounded on purpose (M61): no auto-reject, no timeout into a decision.
    await condition(() => inbox.clarified);
    state.status = "running";
  }

  // ── 3ö · discovery, 3 · analysis ─────────────────────────────────────────
  await goto("3o", "salt-okunur repo keşfi");
  // The ticket is being WORKED now — intake either passed or was answered — so
  // this is the first honest moment to claim the card. Moving it at step 0
  // instead would put a ticket in "Devam Ediyor" that is still only being read,
  // and a ticket that then goes back to the reporter would have visited the
  // in-progress column for nothing.
  await moveStatus("start", input.statusMap?.onStart);
  if (input.appId === undefined) {
    // Analysis-only binding: there is no repository to discover, and that is a
    // configuration the operator chose, not a degradation to hide. The journal
    // line is the run's own record of WHY step 3ö did nothing — without it an
    // operator comparing two analiz runs would see one discover twelve files
    // and the other nothing, with no sentence anywhere explaining the gap.
    await acts.journal(
      ticket,
      "discovery",
      "keşif atlandı",
      "kod deposu bağlı değil — keşif atlandı, analiz ticket metninden üretilecek",
    );
  } else {
    await acts.discoverRepo(ticket, input.appId);
  }

  await goto("3", "analiz üretiliyor");
  const written = await thinkActs.writeAnalysis(ticket, input.appId);
  state.analysis = written.analysis;
  state.risk = written.risk;
  await acts.publishAnalysis(ticket, state.analysis);
  const children = await acts.fanOutChildren(ticket, state.analysis);
  if (children.length > 0) {
    await acts.journal(ticket, "analysis", "fan-out", `${children.length} alt ticket açıldı`);
  }

  // ── 4-5 · analysis gates, with the rejection loop ────────────────────────
  const required = gatesFor(state.risk);
  const plan = planFor(input.flow);
  const analysisGates = plan.analysisGate ? required.filter((g) => g === "4" || g === "5") : [];
  // Once, on the way INTO the gate set, not once per gate: `onReview` says
  // "a human is now looking at this", and a `yuksek` ticket that opens 4 and
  // then 5 has not stopped being reviewed in between. A per-gate call would
  // also be a second transition to the column the ticket is already in, which
  // the driver answers `already` — a journal line saying nothing happened,
  // written every time something did.
  if (analysisGates.length > 0) await moveStatus("review", input.statusMap?.onReview);
  for (const at of analysisGates) {
    await goto(at, "insan onayı bekleniyor");
    const verdict = await gate(at);
    if (verdict.decision === "reject") {
      const strike = countRejection(state, at);
      if (strike.exhausted) return handOver(`${at} kapısında ${strike.count} ret (M54)`);

      // Off the review column before the rewrite starts, so the board stops
      // showing an approver something they have already answered. Ahead of
      // `goto` on purpose: the rewrite is minutes of thinking, and a ticket
      // that sits in "İNCELEMEDE" through all of it invites a second reviewer
      // to pick up work that is already back with the agent.
      await moveStatus("rejected", input.statusMap?.onRejected);
      // Back to analysis with the reason — the agent keeps its context (M30).
      await goto("3", `ret: ${verdict.reason ?? ""} — analiz yeniden yazılıyor`);
      const redone = await thinkActs.writeAnalysis(ticket, input.appId);
      state.analysis = redone.analysis;
      // The rewrite may have re-tiered the ticket; keeping the old value would
      // send the continuation through the wrong gate set.
      state.risk = redone.risk;
      await acts.publishAnalysis(ticket, state.analysis);
      return continueRun();
    }
  }

  /**
   * ── analiz akışı burada BİTER ────────────────────────────────────────────
   *
   * The analysis document is the deliverable, and it has been written,
   * published and approved. Everything below builds software; running it for
   * an `analiz` ticket is not a bigger service, it is the wrong job — and on a
   * deployment configured for analysis only it is also a guaranteed failure
   * (OPS-38 died in `runEngineering` for exactly this reason).
   *
   * Closed as `done`, not handed over: nothing is stuck and nobody is waiting.
   */
  if (!plan.engineering) {
    await goto("13", "analiz teslim edildi");
    await acts.deliverAnalysis(ticket, state.analysis);
    await acts.journal(ticket, "closure", "analiz teslim edildi", "akış: analiz");
    // Before `closeTicket`, so the ticket is already in its final column when
    // the closing comment tells the requester it is finished. Afterwards the
    // reporter would read "tamamlandı" on a card still sitting in review.
    await moveStatus("done", input.statusMap?.onDone);
    await acts.closeTicket(ticket);
    state.status = "done";
    return state.status;
  }

  // ── 6a-10 · engineering loop ─────────────────────────────────────────────
  // Unreachable without an application by construction — intake refuses to
  // start a code-writing flow with no appId (`no_application`), and the
  // `analiz` flow returned above — so this guard is the assertion of that
  // claim, not a path anything is expected to take. It fails CLOSED into a
  // handover rather than letting the engineering loop open a session against
  // a repository that does not exist. Replay-safe: it schedules nothing when
  // `appId` is present, which every in-flight history is.
  if (input.appId === undefined) {
    return handOver("uygulama bağlı değil — mühendislik adımları uygulamasız çalıştırılamaz");
  }
  const built = await runEngineeringLoop({ acts, longActs, goto, gate }, state, inbox, ticket, required);
  if (built.kind === "handover") return handOver(built.reason);
  const attempt = built.attempts;

  // ── 10b · PR and the CI gate ─────────────────────────────────────────────
  await stopIfKilled();
  const pr: PrRef = await acts.openPullRequest(ticket);
  await acts.activatePullRequest(ticket, pr);
  await goto("10b", `PR #${pr.prId} · build validation bekleniyor`);

  const green = await awaitGreenBuild({ acts, longActs }, state, inbox, ticket, attempt);
  if (green.kind === "handover") return handOver(green.reason);

  // ── 11-12 · QA result and PR approval ────────────────────────────────────
  for (const at of required.filter((g) => g === "11" || g === "12")) {
    await goto(at, "insan onayı bekleniyor");
    const verdict = await gate(at);
    if (verdict.decision === "reject") {
      const strike = countRejection(state, at);
      if (strike.exhausted) return handOver(`${at} kapısında ${strike.count} ret (M54)`);

      inbox.changesRequested = verdict.reason ?? "";
      await goto("12b", "PR yorum döngüsü — aynı oturum devam");
      const fix: EngineeringResult = await longActs.runEngineering(
        ticket,
        state.resumeToken,
        inbox.changesRequested,
        // A round of its own: the 12b fix is neither the last 6a turn nor the
        // last CI fix repeated, and each must leave its own record.
        green.attempts + strike.count,
      );
      state.resumeToken = fix.resumeToken;
      if (!fix.ok && fix.handoverReason !== undefined) return handOver(fix.handoverReason);
      return continueRun();
    }
  }

  // ── 13 · merge, evidence, closure ────────────────────────────────────────
  // The last gate is closed and everything below is irreversible. This check
  // cannot be skipped: an emergency stop that does not stop the MERGE has not
  // stopped the only thing in this system that cannot be undone.
  await stopIfKilled();
  await acts.mergePullRequest(ticket, pr);
  await goto("13", "kanıt paketi");
  const evidence = await acts.buildEvidencePackage(ticket);
  await acts.journal(ticket, "closure", "kanıt paketi", `${evidence.files} dosya`);
  // The engineering flow's `onDone`, for the same reason as the analysis one
  // above: the merge is done and the evidence is packaged, so the card belongs
  // in the finished column before the closing comment says it is.
  await moveStatus("done", input.statusMap?.onDone);
  await acts.closeTicket(ticket);
  state.status = "done";
  return state.status;
}
