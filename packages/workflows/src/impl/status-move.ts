import type { TicketKey } from "@maestro/contracts";
import type { StatusMovePoint, StatusMoveRequest, StatusMoveResult } from "../activities.js";
import type { ActivityDeps, RunContext } from "./deps.js";
import { activitySeq, record } from "./record.js";

/**
 * Moving the ticket on the board — the "dinleme kuralı" status map, applied.
 *
 * Until this existed Maestro narrated a run in COMMENTS and never touched the
 * ticket's status, so a board watching a Maestro run showed a card sitting in
 * one column for a day and a half while the run went through intake, analysis,
 * two gates and a delivery. Everything Maestro did was in the ticket; none of
 * it was where a team actually looks.
 *
 * The map itself is an operator's choice, made per listening rule and carried
 * into the run in the workflow input (see `TicketWorkflowInput.statusMap` and
 * why it travels that way rather than being re-read here). This file is the
 * other half: given a status NAME the workflow resolved, ask the driver to move
 * the ticket there and write down what came back.
 *
 * ── the one rule this file exists to enforce ──────────────────────────────
 *
 * A move that does not happen is NEVER a reason to stop. Every failure mode is
 * somebody else's configuration — a column their workflow does not offer from
 * where the ticket stands, a service account without "Transition Issues", a
 * Data Center deployment with no transition API — and none of them says
 * anything about whether the analysis is worth delivering. So nothing here
 * throws, the outcome is data, and the journal carries the reason so the
 * absence of a move is explainable instead of mysterious. The degraded
 * behaviour is precisely today's behaviour: comments only.
 */

/** The journal title an operator scans for, per point. */
const TITLES: Readonly<Record<StatusMovePoint, string>> = {
  start: "durum: işe alındı",
  need_info: "durum: bilgi bekleniyor",
  review: "durum: incelemede",
  rejected: "durum: revizyona döndü",
  done: "durum: tamamlandı",
};

/**
 * How each `moved:false` reason reads to an operator.
 *
 * Written out rather than passed through raw because the reasons are the
 * driver's vocabulary and the journal is read by whoever configured the rule:
 * "no_transition" is a shrug, "bu durumdan o duruma geçiş yok" tells them to go
 * look at their workflow. An unknown reason falls through verbatim — a new
 * driver reason must still be visible, not swallowed by this table.
 */
const REASONS: Readonly<Record<string, string>> = {
  already: "ticket zaten bu durumda",
  no_transition: "bu durumdan hedef duruma geçiş tanımlı değil",
  forbidden: "servis hesabının geçiş yetkisi yok (Jira: Transition Issues)",
  read_failed: "Jira'dan mevcut durum/geçişler okunamadı",
  transition_failed: "geçiş uygulanamadı",
  bad_key: "ticket anahtarı geçersiz",
  bad_status_name: "kuralda hedef durum adı boş",
  no_capability: "bu kurulumun iş sürücüsü durum geçişi yapamıyor (yalnız yorum modu)",
  no_reporter: "ticket'ın talep sahibi okunamadı",
};

function explain(reason: string): string {
  return REASONS[reason] ?? reason;
}

/**
 * Move the ticket, and record the outcome. Total: it resolves for every input.
 *
 * The idempotency key is the run, the POINT and `activitySeq()` — Temporal's
 * own activity id. That last part is not decoration: `run.runId` is the
 * workflowId, which SURVIVES `continueAsNew`, and a rejection at gate 4 is a
 * continuation. Keying on the run and the point alone would mean the second lap
 * of the rejection loop found `start`/`review` already claimed and silently
 * skipped both moves — the ticket would go back to 'Devam Ediyor' on the first
 * rejection and then stay there through every later approval. `activitySeq()`
 * is stable across RETRIES of one invocation (which must collapse) and
 * different between two invocations (which must each move the ticket), which is
 * exactly the distinction `gate.journal` reaches for it to make.
 */
export async function moveTicketStatus(
  deps: ActivityDeps,
  ticket: TicketKey,
  move: StatusMoveRequest,
): Promise<StatusMoveResult> {
  const run = await deps.runs.get(ticket);
  const wanted = move.status?.trim() ?? "";
  const seq = activitySeq();

  const reassigned =
    move.toReporter === true ? await handBackToReporter(deps, run, ticket, move, seq) : false;

  // Assignment-only: `reassignOnNeedInfo` without `onNeedInfo`, which is a
  // board that models "waiting on the reporter" as an assignee. Nothing to
  // transition, and `handBackToReporter` has already journalled.
  if (wanted === "") return { moved: false, reason: "no_status", reassigned };

  const mover = deps.statusMover;
  if (mover === undefined) {
    await note(deps, run, move.at, seq, `${wanted} — ${explain("no_capability")}`, "no-capability");
    return { moved: false, reason: "no_capability", reassigned };
  }

  /**
   * `once` guards the WRITE, not the record: a Temporal retry of this activity
   * must not send a second transition. The driver already short-circuits an
   * already-there ticket, but that check costs a round trip and races a human
   * moving the card by hand between the two attempts.
   */
  const outcome = await deps.idempotency.once(`${run.runId}:status:${move.at}:${seq}`, async () => {
    // Belt and braces around a contract that is documented as total: a driver
    // is somebody else's code, and this function's caller — five points inside
    // the ticket workflow — must not be able to fail because one of them threw.
    try {
      return await mover.move(ticket, wanted);
    } catch (error) {
      return { moved: false, reason: `driver_threw: ${String(error)}` };
    }
  });

  const reason = outcome.reason ?? "";
  await note(
    deps,
    run,
    move.at,
    seq,
    outcome.moved
      ? `ticket '${wanted}' durumuna taşındı`
      : `'${wanted}' durumuna taşınamadı — ${explain(reason)} (akış etkilenmedi)`,
    outcome.moved ? "moved" : `not-moved:${reason}`,
  );

  return outcome.moved
    ? { moved: true, reassigned }
    : { moved: false, ...(reason === "" ? {} : { reason }), reassigned };
}

/**
 * Hand the ticket back to whoever raised it (`reassignOnNeedInfo`).
 *
 * Done through the FROZEN port's `assign` rather than the Cloud driver's
 * `returnToReporter`, on purpose. `returnToReporter` combines the assignment
 * with a transition of its OWN choosing — it picks any edge into the To-Do
 * category — and this rule already names the status it wants in `onNeedInfo`.
 * Using it here would mean two different answers to "where does the ticket go",
 * with the driver's guess overwriting the operator's configuration. It also
 * THROWS on a Jira error, which is the opposite of this file's contract.
 *
 * The reporter comes from the ticket snapshot, exactly as `deliverAnalysis`
 * already resolves the person to hand an analysis back to — one definition of
 * "whose ticket is this", not two.
 */
async function handBackToReporter(
  deps: ActivityDeps,
  run: RunContext,
  ticket: TicketKey,
  move: StatusMoveRequest,
  seq: string,
): Promise<boolean> {
  let reporter = "";
  try {
    reporter = (await deps.work.getTicket(ticket)).reporter?.trim() ?? "";
  } catch (error) {
    await note(deps, run, move.at, seq, `talep sahibi okunamadı: ${String(error)}`, "reporter-read-failed");
    return false;
  }

  if (reporter === "") {
    await note(deps, run, move.at, seq, explain("no_reporter"), "no-reporter");
    return false;
  }

  try {
    await deps.idempotency.once(`${run.runId}:status:${move.at}:${seq}:assign`, () =>
      deps.work.assign(ticket, reporter),
    );
    await note(deps, run, move.at, seq, `ticket talep sahibine geri atandı: ${reporter}`, "reassigned");
    return true;
  } catch (error) {
    // Same policy as the transition: an assignment Jira refused is a line in
    // the journal, never a stopped run.
    await note(deps, run, move.at, seq, `talep sahibine atanamadı: ${String(error)}`, "reassign-failed");
    return false;
  }
}

/**
 * One journal line per outcome, under the `other` kind.
 *
 * `other` rather than `closure`/`clarification`: the move is a fact about the
 * BOARD, not about the phase that triggered it, and giving it the phase's kind
 * would put "durum taşınamadı" in the middle of the closure record an evidence
 * package is built from. The title says which point it belongs to instead.
 */
async function note(
  deps: ActivityDeps,
  run: RunContext,
  at: StatusMovePoint,
  seq: string,
  detail: string,
  key: string,
): Promise<void> {
  await record(deps, run, {
    kind: "other",
    title: TITLES[at],
    detail,
    // Same discriminator as the write guard, for the same reason: a retry
    // repeats the line, a second lap of the rejection loop earns its own.
    key: `status:${at}:${seq}:${key}`,
  });
}
