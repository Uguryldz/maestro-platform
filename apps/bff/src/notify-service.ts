import { EscalationLadder, NotifyRouting } from "@maestro/notify";
import { z } from "zod";
import type { ResolvedDeps } from "./deps.js";
import { badRequest } from "./errors.js";
import { putParam, type ParamPutResult } from "./params-service.js";

/**
 * The reminder ladder and channel routing (M45/M71/M88), as the `notify`
 * screen reads and edits them.
 *
 * Both live in the M71 parameter store — `escalation.ladder` and
 * `notify.routing` — and this module is the projection between what is STORED
 * (per-step channel and action, an event→channel map) and what the screen
 * shows (rungs with a kind and a channel list). Nothing here holds a second
 * copy of either: a default compiled in here would be a second answer to "what
 * is the ladder", and it would win exactly when the database row is missing,
 * which is when an operator most needs to be told it is.
 */

/** The parameter keys this module reads. Named so the catalog guard sees them once. */
export const NOTIFY_PARAM_KEYS = {
  ladder: "escalation.ladder",
  routing: "notify.routing",
  teamsWebhook: "notify.teams.webhook",
} as const;

/** The stored Teams webhook URL shape (a bearer credential in its path). */
const TeamsWebhook = z.object({ url: z.string() });

/**
 * A Teams webhook URL masked for read — a bearer credential lives in the path,
 * so a GET must never return it in full. Empty stays empty (not yet set); a set
 * URL becomes "https://…<last 6 chars>" so an admin can recognise it without the
 * screen ever holding the secret.
 */
function maskWebhook(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return "";
  const tail = trimmed.length <= 6 ? trimmed : trimmed.slice(-6);
  return `…${tail}`;
}

export interface EscalationStepView {
  afterHours: number;
  channels: readonly string[];
  /** `delegate` and `report` rungs render differently from a plain reminder. */
  kind: "notify" | "delegate" | "report";
}

export interface DelegationView {
  role: string;
  primary: string;
  backup: string | null;
  lastResort: string | null;
}

export interface WaitingGateView {
  ticketKey: string;
  step: string;
  waitingHours: number;
  /** Catalog key for what last happened on this gate, or null when nothing has. */
  lastActionKey: string | null;
  lastActionParams?: Record<string, string>;
}

export interface NotifyView {
  ladder: readonly EscalationStepView[];
  delegations: readonly DelegationView[];
  waiting: readonly WaitingGateView[];
  /** The stored routing, so the screen's editor round-trips exactly. */
  routing: NotifyRouting;
  /**
   * The Teams webhook URL, MASKED — "…<last 6>" when set, "" when not. The full
   * URL is a bearer credential and never leaves the server; this tells the
   * screen only whether one is configured and lets an admin recognise it.
   */
  teamsWebhookMask: string;
  /**
   * The stored ladder verbatim (per-step id/channel/event/threshold), so the
   * editor can change a THRESHOLD and PUT the same steps back with their ids
   * intact — a projected rung has no id, and re-deriving one would re-escalate
   * every open gate (see `EscalationStep.id`).
   */
  ladderRaw: EscalationLadder;
}

/**
 * `PUT /notify` accepts the two parameters together, because they are edited
 * together: moving escalation off Teams means touching the routing map and the
 * rung that names the channel, and applying one without the other leaves a
 * ladder pointing at a channel nobody watches.
 *
 * Both fields are optional; an absent one is left alone rather than reset.
 */
export const NotifyUpdate = z
  .object({
    ladder: EscalationLadder.optional(),
    routing: NotifyRouting.optional(),
    /** The Teams webhook URL to store, or "" to clear it. */
    teamsWebhook: z.string().optional(),
  })
  .refine(
    (value) =>
      value.ladder !== undefined || value.routing !== undefined || value.teamsWebhook !== undefined,
    { message: "send at least one of ladder, routing or teamsWebhook" },
  );
export type NotifyUpdate = z.infer<typeof NotifyUpdate>;

/**
 * What the notify screen shows.
 *
 * A missing parameter row THROWS rather than rendering an empty ladder: an
 * escalation ladder with no rungs and one that was never seeded look identical
 * on screen, and the second means no gate in the bank is being chased.
 */
export async function readNotify(deps: ResolvedDeps): Promise<NotifyView> {
  const ladder = await readParam(deps, NOTIFY_PARAM_KEYS.ladder, EscalationLadder);
  const routing = await readParam(deps, NOTIFY_PARAM_KEYS.routing, NotifyRouting);

  // The Teams webhook is optional and may never have been seeded on an older
  // database; a missing row means "not set", not an error — unlike the ladder.
  const teamsWebhook = await readOptionalParam(deps, NOTIFY_PARAM_KEYS.teamsWebhook, TeamsWebhook);

  return {
    ladder: ladderView(ladder, routing),
    delegations: await delegations(deps),
    waiting: await waiting(deps),
    routing,
    ladderRaw: ladder,
    teamsWebhookMask: maskWebhook(teamsWebhook?.url ?? ""),
  };
}

/**
 * Apply an edit.
 *
 * It goes through `putParam`, which is the whole point: that function owns the
 * four-eyes rule (M32/M78), the version bump and the audit line. Writing to the
 * store directly here would be a second write path around the guard, and the
 * guarded flag on a parameter would then depend on which screen edited it.
 */
export async function updateNotify(
  deps: ResolvedDeps,
  update: NotifyUpdate,
  actor: string,
): Promise<readonly ParamPutResult[]> {
  const results: ParamPutResult[] = [];
  if (update.ladder !== undefined) {
    results.push(
      await putParam(deps, {
        key: NOTIFY_PARAM_KEYS.ladder,
        scopeRef: null,
        value: update.ladder,
        actor,
      }),
    );
  }
  if (update.routing !== undefined) {
    results.push(
      await putParam(deps, {
        key: NOTIFY_PARAM_KEYS.routing,
        scopeRef: null,
        value: update.routing,
        actor,
      }),
    );
  }
  if (update.teamsWebhook !== undefined) {
    results.push(
      await putParam(deps, {
        key: NOTIFY_PARAM_KEYS.teamsWebhook,
        scopeRef: null,
        value: { url: update.teamsWebhook.trim() },
        actor,
      }),
    );
  }
  return results;
}

/**
 * The stored ladder as rungs.
 *
 * A step's channel list is the routing map's answer for the step's EVENT, not
 * the step's own single `channel` — the routing map is what actually decides
 * where a notification goes, so showing the step's channel alone would show a
 * plan the platform does not follow. The step's channel joins it, because a
 * step that names one is delivered there too.
 *
 * `report` is the last rung when it is a plain notify: M29 says a pause is not
 * a decision, so the ladder ends by telling a human rather than timing out,
 * and the screen renders that differently from a mid-ladder reminder.
 */
function ladderView(ladder: EscalationLadder, routing: NotifyRouting): readonly EscalationStepView[] {
  const steps = [...ladder.steps].sort((left, right) => left.afterHours - right.afterHours);
  const rungs = steps.map((step, index) => {
    const routed = routing.byEvent[step.event] ?? routing.default;
    const channels = [...new Set<string>([...routed, step.channel])].sort();
    return {
      afterHours: step.afterHours,
      channels,
      kind: (step.action === "delegate"
        ? "delegate"
        : index === steps.length - 1
          ? "report"
          : "notify") as EscalationStepView["kind"],
    };
  });

  /**
   * Merge rungs that would render identically.
   *
   * Two steps can sit at the same hour on different events — the shipped
   * ladder has a 72h `escalation` and the reminder that rides with it — and
   * once each has been resolved through the routing map they become the same
   * row: same hour, same kind, same channels. The screen keys its rungs on
   * `kind-afterHours`, so emitting both produced a React duplicate-key error
   * and drew two identical arrows an operator cannot tell apart. Found by
   * opening the page against the seeded database, not by a test.
   *
   * Merging rather than de-duplicating by key: rungs at the same hour with
   * DIFFERENT channels are combined into one row carrying both, because that
   * is what actually happens at that hour — two notifications go out.
   */
  const merged: { afterHours: number; channels: string[]; kind: EscalationStepView["kind"] }[] = [];
  for (const rung of rungs) {
    const existing = merged.find(
      (candidate) => candidate.afterHours === rung.afterHours && candidate.kind === rung.kind,
    );
    if (existing === undefined) {
      merged.push({ ...rung, channels: [...rung.channels] });
      continue;
    }
    existing.channels = [...new Set<string>([...existing.channels, ...rung.channels])].sort();
  }
  return merged;
}

/**
 * Who a gate falls to. Built from the gate directory's owner groups — the same
 * source the gate guard uses, so the screen cannot show a deputy the platform
 * would not actually escalate to.
 *
 * Empty is honest here and only here: a platform with no delegation configured
 * has none, and the screen says so. It is not a stand-in for an unreachable
 * store, which throws above.
 */
async function delegations(deps: ResolvedDeps): Promise<readonly DelegationView[]> {
  const ladder = await readParam(deps, NOTIFY_PARAM_KEYS.ladder, EscalationLadder);
  const delegate = ladder.steps.find((step) => step.action === "delegate");
  // `to` on the delegate rung is the fixed audience the parameter names. When
  // the rung leaves it unset the audience is resolved per gate at escalation
  // time, and there is no platform-wide answer to show.
  const audience = delegate?.to ?? [];
  if (audience.length === 0) return [];

  const [primary, ...rest] = audience;
  return [
    {
      role: "tech-lead",
      primary: primary ?? "",
      backup: rest[0] ?? null,
      lastResort: rest[1] ?? null,
    },
  ];
}

/** Gates waiting right now, with how long they have been open. */
async function waiting(deps: ResolvedDeps): Promise<readonly WaitingGateView[]> {
  const page = await deps.read.gates.listOpen({
    limit: 50,
    cursor: null,
    ownerGroup: null,
    projectKeys: null,
  });
  const now = deps.clock.now().getTime();

  return page.items.map((gate) => ({
    ticketKey: gate.ticketKey,
    step: gate.step,
    // Computed, never stored: a duration written down when the gate opened is
    // wrong by the time anybody reads it.
    waitingHours: Math.max(0, Math.round((now - Date.parse(gate.openedAt)) / 3_600_000)),
    lastActionKey: gate.delegatedTo === null ? null : "notify.delegated",
    ...(gate.delegatedTo === null ? {} : { lastActionParams: { to: gate.delegatedTo } }),
  }));
}

/**
 * Read one parameter at global scope, parsed with the CONSUMING package's own
 * schema. A JSON column holds whatever was written into it, and a ladder with
 * a malformed step would otherwise surface as an escalation that never fires.
 */
async function readParam<T>(deps: ResolvedDeps, key: string, schema: z.ZodType<T>): Promise<T> {
  const values = await deps.params.values();
  const rows = values.filter((value) => value.key === key && value.scopeRef === null);
  const newest = rows.reduce<(typeof rows)[number] | null>(
    (best, row) => (best === null || row.version > best.version ? row : best),
    null,
  );
  if (newest === null) {
    throw badRequest("param_not_seeded", {
      key,
      reason: "settings live in the database (M71) and this service holds no compiled-in default",
    });
  }

  const parsed = schema.safeParse(newest.value);
  if (!parsed.success) {
    throw badRequest("param_unusable", {
      key,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    });
  }
  return parsed.data;
}

/**
 * Like `readParam`, but a MISSING row is `null` rather than an error.
 *
 * The Teams webhook is optional — a fresh or older database has no row, and that
 * means "not configured", not "misconfigured". A row that exists but is
 * malformed still throws, so a corrupt value is never silently treated as unset.
 */
async function readOptionalParam<T>(
  deps: ResolvedDeps,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const values = await deps.params.values();
  const rows = values.filter((value) => value.key === key && value.scopeRef === null);
  const newest = rows.reduce<(typeof rows)[number] | null>(
    (best, row) => (best === null || row.version > best.version ? row : best),
    null,
  );
  if (newest === null) return null;
  const parsed = schema.safeParse(newest.value);
  if (!parsed.success) {
    throw badRequest("param_unusable", {
      key,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    });
  }
  return parsed.data;
}
