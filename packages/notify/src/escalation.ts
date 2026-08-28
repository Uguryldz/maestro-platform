import {
  IsoDateTime,
  type Locale,
  NonEmpty,
  Notification,
  NotifyChannel,
  NotifyEventKey,
} from "@maestro/contracts";
import { z } from "zod";
import { BusinessCalendar, addWorkingMinutes, workingMinutesBetween } from "./calendar.js";
import { NotifyConfigError, NotifyRecipientError } from "./errors.js";

/**
 * Escalation ladder (M88) — FULLY parametric: the steps, their delays, their
 * channels, the message keys, the recipients and the working calendar all come
 * from the `escalation.ladder` parameter in the DB (M71).
 *
 * There is deliberately NO default ladder in this package. Settings live in the
 * database (M71), and a second copy compiled in here is a second answer to
 * "what is the ladder?" — the shipped default is
 * `DEFAULT_PARAM_DEFINITIONS["escalation.ladder"]` in `@maestro/db`, and
 * `packages/db/test/notify-params.test.ts` parses it with the schema below so
 * the two cannot drift.
 */
export const EscalationAction = z.enum(["notify", "delegate"]);
export type EscalationAction = z.infer<typeof EscalationAction>;

export const EscalationStep = z.object({
  /** Delay from the anchor (the moment the gate opened). Fractions allowed. */
  afterHours: z.number().positive().max(24 * 365),
  channel: NotifyChannel,
  event: NotifyEventKey,
  /**
   * Persistent identity, REQUIRED and seeded with the parameter. It is what
   * `firedStepIds` remembers, so it must not be derived from the content:
   * editing a threshold from 72h to 48h in Studio would then mint a new id and
   * instantly re-escalate every open gate.
   */
  id: NonEmpty,
  /** Catalog key (M104); defaults to `notify.<event>`. */
  messageKey: NonEmpty.optional(),
  /** Fixed audience for this step; otherwise the caller resolves it. */
  to: z.array(NonEmpty).min(1).optional(),
  /** "delegate" = hand the gate to the deputy; the caller performs it. */
  action: EscalationAction.default("notify"),
});
export type EscalationStep = z.infer<typeof EscalationStep>;

export const EscalationLadder = z.object({
  steps: z.array(EscalationStep).min(1),
  /** false = wall-clock hours; true = the calendar below applies. */
  businessHoursOnly: z.boolean().default(false),
  calendar: BusinessCalendar.prefault({}),
});
export type EscalationLadder = z.infer<typeof EscalationLadder>;

export interface ResolvedStep extends EscalationStep {
  /** The step's own `id` — stable across every edit except a rename. */
  stepId: string;
  thresholdMinutes: number;
}

/**
 * Ids come from the parameter and are checked for uniqueness here: two steps
 * sharing an id would make `firedStepIds` ambiguous, and one of them would
 * either fire twice or never.
 */
export function resolveSteps(ladder: EscalationLadder): ResolvedStep[] {
  const seen = new Set<string>();
  return ladder.steps.map((step) => {
    if (seen.has(step.id)) {
      throw new NotifyConfigError(`escalation ladder has a duplicate step id: "${step.id}"`);
    }
    seen.add(step.id);
    return { ...step, stepId: step.id, thresholdMinutes: Math.round(step.afterHours * 60) };
  });
}

export interface LadderQuery {
  /**
   * When the clock started: the gate opened, the question was asked… Both are
   * `IsoDateTime` (offset REQUIRED), the same shape `Notification.at` demands —
   * `Date.parse` alone accepted "2026-08-02", which then travelled all the way
   * to a driver and died there as a permanent failure.
   */
  openedAt: string;
  now: string;
  /** Steps already sent — the ladder never fires the same step twice. */
  firedStepIds?: readonly string[];
}

export interface EscalationDecision {
  /** Steps that must fire at `now`, in ladder order. */
  due: ResolvedStep[];
  /** The next step and the instant it becomes due — feeds a Temporal timer. */
  next: { step: ResolvedStep; dueAt: string } | null;
  /** Elapsed time under the ladder's own time model. */
  elapsedMinutes: number;
}

/**
 * THE pure function: "at instant `now`, which step must fire?". No I/O, no
 * ambient clock, no hidden state — the answer depends only on its arguments,
 * so a workflow replay and a unit test agree by construction.
 */
export function escalationDueAt(ladder: EscalationLadder, query: LadderQuery): EscalationDecision {
  const openedAt = parseInstant("openedAt", query.openedAt);
  const now = parseInstant("now", query.now);
  if (now < openedAt) {
    throw new NotifyConfigError(`now (${query.now}) is before openedAt (${query.openedAt})`);
  }
  const fired = new Set(query.firedStepIds ?? []);
  const elapsedMinutes = ladder.businessHoursOnly
    ? workingMinutesBetween(openedAt, now, ladder.calendar)
    : Math.floor((now - openedAt) / 60_000);

  const steps = resolveSteps(ladder);
  const due = steps.filter((step) => step.thresholdMinutes <= elapsedMinutes && !fired.has(step.stepId));
  const pending = steps
    .filter((step) => step.thresholdMinutes > elapsedMinutes && !fired.has(step.stepId))
    .sort((a, b) => a.thresholdMinutes - b.thresholdMinutes);

  const nextStep = pending[0];
  const next = nextStep
    ? { step: nextStep, dueAt: new Date(dueInstant(ladder, openedAt, nextStep.thresholdMinutes)).toISOString() }
    : null;

  return { due, next, elapsedMinutes };
}

function dueInstant(ladder: EscalationLadder, openedAt: number, thresholdMinutes: number): number {
  return ladder.businessHoursOnly
    ? addWorkingMinutes(openedAt, thresholdMinutes, ladder.calendar)
    : openedAt + thresholdMinutes * 60_000;
}

export interface EscalationContext extends LadderQuery {
  locale: Locale;
  /** Catalog parameters shared by every step ({ticket}, {gate}, {days}…). */
  params: Record<string, string>;
  /** Audience for a step without its own `to` (gate owner, deputy, ops…). */
  recipients: (step: ResolvedStep) => readonly string[];
}

export interface EscalationPlan extends EscalationDecision {
  /** One notification per due step, ready for `NotifyPort.send`. */
  notifications: Notification[];
  /** Due steps whose action is "delegate": the caller must reassign. */
  delegations: ResolvedStep[];
}

/**
 * Catalog key for a step (M104). A `delegate` step announces a DELEGATION, not
 * another escalation: sending "gate unanswered for 7 days" while quietly
 * handing the gate to the deputy tells the deputy nothing about why it landed
 * on their desk.
 */
function messageKeyOf(step: ResolvedStep): string {
  if (step.messageKey !== undefined) return step.messageKey;
  return step.action === "delegate" ? "notify.delegated" : `notify.${step.event}`;
}

/**
 * Turns the decision into notifications. Message text stays in the catalog
 * (M104): a step contributes a KEY, never a sentence. A step that resolves to
 * no recipient throws — a notification addressed to nobody is exactly the
 * silent death this ladder exists to prevent.
 *
 * Every notification is parsed against the frozen contract HERE, so a bad
 * ladder or a bad `now` fails in the planner, where the parameter can be fixed,
 * instead of in a driver three hops later.
 */
export function planEscalation(ladder: EscalationLadder, ctx: EscalationContext): EscalationPlan {
  const decision = escalationDueAt(ladder, ctx);
  const notifications = decision.due.map((step) => {
    const to = [...(step.to ?? ctx.recipients(step))];
    if (to.length === 0) {
      throw new NotifyRecipientError(step.channel, step.stepId, "escalation step resolved to no recipient");
    }
    const parsed = Notification.safeParse({
      event: step.event,
      channel: step.channel,
      to,
      locale: ctx.locale,
      messageKey: messageKeyOf(step),
      params: ctx.params,
      at: ctx.now,
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new NotifyConfigError(`escalation step "${step.stepId}" produced an invalid notification: ${issues}`);
    }
    return parsed.data;
  });

  return {
    ...decision,
    notifications,
    delegations: decision.due.filter((step) => step.action === "delegate"),
  };
}

function parseInstant(field: string, iso: string): number {
  if (!IsoDateTime.safeParse(iso).success) {
    throw new NotifyConfigError(`${field} is not an ISO-8601 instant with an offset: "${iso}"`);
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new NotifyConfigError(`${field} is not an ISO-8601 instant: "${iso}"`);
  return ms;
}
