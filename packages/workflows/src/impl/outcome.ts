import type { LlmOutcome } from "@maestro/ports";
import { activityInfo } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { ActivityDeps, RunContext } from "./deps.js";
import { audit, notifyEvent, record } from "./record.js";

/**
 * The four ends of an LLM call (M18/M55/M97), turned into the two things an
 * activity can do: return a value, or stop.
 *
 * `queued` and `blocked` both stop the activity, and it matters enormously
 * which one: a quota wait is a RETRYABLE failure, so Temporal holds the run
 * and comes back when the window opens — no work is lost and no human is
 * disturbed. A policy block is NON-retryable, because retrying a decision the
 * compliance policy already made just burns the retry budget.
 */

export const QUOTA_WAIT = "LlmQuotaWait";
export const LLM_BLOCKED = "LlmBlocked";
export const LLM_AUTH_REJECTED = "LlmAuthRejected";

/**
 * How many activity attempts an auth-rejected key is given before the run is
 * handed to a human (see `guardModelCall`).
 *
 * On the thinking ladder (1 minute doubling to a 1-hour cap) attempt 30 lands
 * roughly a full day after the first 401/403. That window is chosen for the
 * case the two status codes cannot distinguish: OpenRouter answers the SAME
 * 403 for a key whose prepaid limit is exhausted — which heals the moment the
 * operator tops up — and for a key that was revoked, which never heals. A day
 * is enough for "the quota returns in the morning" and short enough that a
 * dead key becomes a named handover instead of a run that is `running`
 * forever with nothing on the panel saying why.
 */
export const AUTH_RETRY_MAX_ATTEMPTS = 30;

/**
 * The gateway's `LlmAuthError` (401/403), recognised STRUCTURALLY.
 *
 * This package may not import `@maestro/llm-gateway` — M44 keeps every
 * concrete driver out of the core, and the seam it does import (`LlmPort`)
 * deliberately leaves real failures as exceptions. Matching on the error's
 * class NAME is the same classification Temporal itself performs when it turns
 * a thrown error into a failure `type`; it is not the message-string matching
 * the gateway's error taxonomy exists to prevent.
 */
function isLlmAuthError(err: unknown): err is Error & { status?: number } {
  return err instanceof Error && err.name === "LlmAuthError";
}

/**
 * The current attempt number, when running inside a Temporal activity.
 *
 * Outside one (a unit test calling the activity function directly) there is no
 * context and the answer is 1 — the guard then behaves like a first attempt,
 * which is the only honest default.
 */
function currentAttempt(): number {
  try {
    return activityInfo().attempt;
  } catch {
    return 1;
  }
}

/**
 * Run one model call and refuse to let an auth failure retry in silence.
 *
 * THE DEFECT THIS CLOSES. `LlmAuthError` is thrown by the driver — it is a
 * real failure, not an `LlmOutcome`, so it never reaches `resolveOutcome` —
 * and a plain thrown error is RETRYABLE to Temporal. Under the thinking
 * proxy's unlimited/1-hour ladder (built for M55 quota waits) a rejected key
 * therefore retried forever, and the run's row sat `running` for days with
 * nothing in the panel saying why (the install rehearsal's OPS-78/OPS-79).
 *
 * The policy is BOUNDED retries rather than fail-fast, because the provider
 * cannot tell us which auth failure this is: a quota-exhausted prepaid key and
 * a revoked key both come back 403, and waiting is exactly right for the first
 * (the run resumes on its own when the operator tops up, no restart needed).
 * What was missing is the bound and the trace, and both are added here: every
 * attempt leaves a journal line naming the count, and the attempt after
 * `AUTH_RETRY_MAX_ATTEMPTS` stops retrying, hands the ticket to a human (M97
 * machinery — journal + audit + notification), and dies non-retryably with
 * `LLM_AUTH_REJECTED`.
 *
 * Every other error passes through untouched: this guard exists for the one
 * failure class whose retry semantics were wrong, not to re-classify the rest.
 */
export async function guardModelCall<T>(
  deps: ActivityDeps,
  run: RunContext,
  what: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!isLlmAuthError(err)) throw err;

    const attempt = currentAttempt();
    const status = typeof err.status === "number" ? `HTTP ${err.status}` : "HTTP 401/403";

    if (attempt < AUTH_RETRY_MAX_ATTEMPTS) {
      // The panel must show the wait: one line per attempt, keyed on the
      // attempt so a Temporal retry of THIS attempt's writes collapses while
      // the next attempt still gets its own line. Bounded by the attempt cap,
      // so this can never flood the journal.
      await record(deps, run, {
        kind: "other",
        title: "model anahtarı reddedildi",
        detail: `${what} · ${status} · yeniden denenecek (${attempt}/${AUTH_RETRY_MAX_ATTEMPTS})`,
        key: `auth-retry:${what}:${attempt}`,
      });
      // Rethrown as-is: the proxy's own ladder decides when the next attempt
      // runs, and the original error keeps its name for Temporal's record.
      throw err;
    }

    // The budget is spent. Same shape as the M18 `blocked` branch: a human
    // takes the ticket, the reason is on the record BEFORE the activity dies,
    // and the failure type is named so nothing upstream mistakes it for quota.
    await handOver(
      deps,
      run,
      `${what}: model anahtarı reddedildi (${status}, ${attempt} deneme) — Ayarlar > Bağlantılar'dan anahtarı düzeltin`,
      `auth-rejected:${what}`,
    );
    throw ApplicationFailure.create({
      message: `LLM auth rejected for ${what} after ${attempt} attempts (${status}); fix the model key in Ayarlar > Bağlantılar`,
      type: LLM_AUTH_REJECTED,
      nonRetryable: true,
    });
  }
}

export type Resolved<T> =
  | { readonly status: "ok"; readonly value: T }
  /** M18 `degrade_ai_assist`: the flow continues, human-led (M97). */
  | { readonly status: "degraded"; readonly messageKey: string };

/**
 * Wait for a quota window (M55). Retryable on purpose, with the delay the
 * gateway itself named: the run sits in Temporal, costs nothing, and resumes
 * on its own.
 */
export function quotaWait(resumeAt: string, now: Date): ApplicationFailure {
  const delayMs = Math.max(0, new Date(resumeAt).getTime() - now.getTime());
  return ApplicationFailure.create({
    message: `LLM quota exhausted; retry after ${resumeAt}`,
    type: QUOTA_WAIT,
    nonRetryable: false,
    nextRetryDelay: delayMs,
  });
}

/**
 * Branch on the outcome of one thinking-role call and leave the right trace.
 *
 * The exhaustive switch is the point: `LlmOutcome` adding a fifth state must
 * break compilation here rather than fall through to "treat it as ok".
 */
export async function resolveOutcome<T>(
  deps: ActivityDeps,
  run: RunContext,
  what: string,
  outcome: LlmOutcome<T>,
): Promise<Resolved<T>> {
  switch (outcome.status) {
    case "ok":
      return { status: "ok", value: outcome.value };

    case "queued": {
      await record(deps, run, {
        kind: "quota",
        title: "LLM kotası doldu",
        detail: `${what} · ${outcome.reason} · ${outcome.resumeAt}`,
        key: `quota:${what}:${outcome.resumeAt}`,
      });
      await audit(deps, run, {
        action: "QUOTA_WARN",
        meta: { what, resumeAt: outcome.resumeAt },
        key: `quota:${what}:${outcome.resumeAt}`,
      });
      throw quotaWait(outcome.resumeAt, deps.now());
    }

    case "degraded": {
      // M18/M97: no permitted backend may see this data class, so the work
      // still happens — a human does it, in ai-assist mode.
      await deps.runs.patch(run.ticket, { mode: "ai_assist" });
      await record(deps, run, {
        kind: "other",
        title: "ai_assist moduna düşüldü",
        detail: `${what} · ${outcome.messageKey} · ${outcome.dataClass}`,
        key: `degrade:${what}`,
      });
      await audit(deps, run, {
        action: "MODE_CHANGED",
        meta: { what, to: "ai_assist", messageKey: outcome.messageKey },
        key: `degrade:${what}`,
      });
      return { status: "degraded", messageKey: outcome.messageKey };
    }

    case "blocked": {
      // M18 `block`: there is no ai-assist fallback. A human takes the ticket
      // and the compliance decision is on the record before the activity dies.
      await handOver(deps, run, `${what}: ${outcome.messageKey}`, `blocked:${what}`);
      throw ApplicationFailure.create({
        message: `LLM policy blocked ${what}: ${outcome.messageKey}`,
        type: LLM_BLOCKED,
        nonRetryable: true,
      });
    }
  }
}

/**
 * Hand the ticket to a human, with everything they need to continue: the
 * journal entry, the audit record and the notification. Shared by the blocked
 * branch above, by M52/M54 handovers and by the workflow's own `handOverToHuman`.
 */
export async function handOver(
  deps: ActivityDeps,
  run: RunContext,
  reason: string,
  key: string,
): Promise<void> {
  await deps.runs.patch(run.ticket, { mode: "ai_assist" });
  await record(deps, run, {
    kind: "handover",
    title: "insana devredildi",
    detail: reason,
    key: `handover:${key}`,
  });
  await audit(deps, run, { action: "HANDOVER", meta: { reason }, key: `handover:${key}` });
  await notifyEvent(deps, run, {
    event: "handover",
    messageKey: "notify.handover",
    params: { ticket: run.ticket, reason },
    to: await deps.directory.membersOf("tech-leads"),
    key: `handover:${key}`,
  });
}
