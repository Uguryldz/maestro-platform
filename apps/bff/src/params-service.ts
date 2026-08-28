import { canonicalize, humanBehind, isHumanActor } from "@maestro/audit";
import { ParamChange, type ParamDefinition } from "@maestro/contracts";
import type { PendingParamChange, ResolvedDeps } from "./deps.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { isMasterApprover } from "./platform/master-approver.js";

/**
 * Operational parameters live in the database and are edited from Studio,
 * versioned and audited (M71). Some of them decide who may approve what and
 * when the flow stops; those are `guarded` and take four eyes (M32/M78) — one
 * person proposes, a DIFFERENT person confirms the exact same value.
 *
 * "Different person" counts PEOPLE, not tokens. `ugur@corp` and
 * `ai-via:ugur@corp` are one pair of eyes holding two credentials, so every
 * comparison below runs through `humanBehind` (M32/M101). An AI delegate may
 * leave the first signature — M101 grants the MCP surface "admin-öneri" — but
 * approving is a human channel, the same rule that governs gates.
 */

export interface ParamPutRequest {
  key: string;
  scopeRef: string | null;
  value: unknown;
  /** Audit actor of the caller; also the identity four-eyes compares. */
  actor: string;
  /**
   * The caller's directory groups. When present and they include the
   * four-eyes group, a master admin may confirm their OWN guarded proposal
   * (single-admin self-approval, recorded in the audit trail). Absent/empty =
   * no exemption, so every existing caller keeps the strict two-person rule
   * until it opts in by passing groups. See platform/master-approver.ts.
   */
  actorGroups?: readonly string[];
}

export type ParamPutResult =
  | { status: "applied"; change: ParamChange }
  | { status: "pending"; pending: PendingParamChange };

export interface ParamsView {
  definitions: readonly ParamDefinition[];
  values: readonly ParamChange[];
  pending: readonly PendingParamChange[];
}

/**
 * Parameter keys whose VALUE is a secret (a bearer credential in a URL, a
 * token). Their stored `{ url: "..." }` must never leave the BFF in full: the
 * params screen renders the raw value, so an unmasked secret would sit in a
 * table a console can screenshot. Read is masked; the dedicated screen (e.g. the
 * notify Teams webhook field) owns entry and shows only a recognition mask.
 */
const SECRET_PARAM_KEYS: ReadonlySet<string> = new Set(["notify.teams.webhook"]);

/**
 * Replace a secret parameter's value with a recognition mask ("…<last 6>"),
 * never the full credential. Non-secret keys pass through untouched. The stored
 * shape is `{ url: string }`; an empty or malformed value masks to an empty
 * marker rather than throwing — a read must not fail on a hand-broken row.
 */
function maskParamValue(key: string, value: unknown): unknown {
  if (!SECRET_PARAM_KEYS.has(key)) return value;
  const url = typeof value === "object" && value !== null ? (value as { url?: unknown }).url : undefined;
  const text = typeof url === "string" ? url.trim() : "";
  return { url: text === "" ? "" : `…${text.length <= 6 ? text : text.slice(-6)}` };
}

export async function readParams(deps: ResolvedDeps): Promise<ParamsView> {
  const [definitions, values, pending] = await Promise.all([
    deps.params.definitions(),
    deps.params.values(),
    deps.params.pending(),
  ]);
  // Mask secret values on the way out — the raw credential never reaches a
  // screen. Both the history rows and any pending proposal are masked.
  const maskedValues = values.map((change) =>
    SECRET_PARAM_KEYS.has(change.key) ? { ...change, value: maskParamValue(change.key, change.value) } : change,
  );
  const maskedPending = pending.map((item) =>
    SECRET_PARAM_KEYS.has(item.key) ? { ...item, value: maskParamValue(item.key, item.value) } : item,
  );
  return { definitions, values: maskedValues, pending: maskedPending };
}

export async function putParam(
  deps: ResolvedDeps,
  request: ParamPutRequest,
): Promise<ParamPutResult> {
  const definitions = await deps.params.definitions();
  const definition = definitions.find((candidate) => candidate.key === request.key);
  if (definition === undefined) throw notFound("unknown_param", { key: request.key });

  const typeError = checkValue(definition, request.value);
  if (typeError !== null) throw badRequest("param_value", { key: request.key, error: typeError });

  if (!definition.guarded) {
    return { status: "applied", change: await apply(deps, request, null) };
  }

  const pendingChanges = await deps.params.pending();
  const open = pendingChanges.find(
    (candidate) => candidate.key === request.key && candidate.scopeRef === request.scopeRef,
  );

  if (open === undefined) {
    const proposal: PendingParamChange = {
      key: request.key,
      scopeRef: request.scopeRef,
      value: request.value,
      proposedBy: request.actor,
      at: deps.clock.now().toISOString(),
    };
    await deps.params.putPending(proposal);
    return { status: "pending", pending: proposal };
  }

  // The proposer confirming their own proposal is one pair of eyes, however
  // many times they press the button and whichever token they hold. Re-proposing
  // a different value simply replaces the pending entry — it still waits for
  // somebody else.
  //
  // EXCEPTION: a master admin (four-eyes group) may confirm their own guarded
  // proposal so a single-admin install is not deadlocked. It still must be a
  // real human (an AI delegate is refused below) and the confirm must match the
  // pending value byte for byte — the same review the second human would do.
  if (samePerson(open.proposedBy, request.actor)) {
    const masterSolo =
      isHumanActor(request.actor) &&
      isMasterApprover(request.actorGroups ?? []) &&
      canonicalize(open.value) === canonicalize(request.value);
    if (!masterSolo) {
      const proposal: PendingParamChange = { ...open, value: request.value, at: deps.clock.now().toISOString() };
      await deps.params.putPending(proposal);
      return { status: "pending", pending: proposal };
    }
    // Master admin solo-approves: apply now, recording themselves as approver,
    // and waive the store's "approver ≠ author" guard (allowSelfApprove).
    const soloChange = await apply(deps, { ...request, actor: open.proposedBy }, request.actor, true);
    await deps.params.clearPending(request.key, request.scopeRef);
    return { status: "applied", change: soloChange };
  }

  // A different person, but not a person: an AI delegate proposes, never
  // approves (M101). Refused here rather than at the audit chain so the caller
  // gets a 403 with a reason instead of a 500.
  if (!isHumanActor(request.actor)) {
    throw forbidden("human_channel_only", { key: request.key });
  }

  // The second approver confirms a value, not a key: if the two do not agree
  // byte for byte, nobody has actually reviewed what is about to be written.
  if (canonicalize(open.value) !== canonicalize(request.value)) {
    throw conflict("param_value_mismatch", { key: request.key, pending: open.value });
  }

  const change = await apply(deps, { ...request, actor: open.proposedBy }, request.actor);
  await deps.params.clearPending(request.key, request.scopeRef);
  return { status: "applied", change };
}

async function apply(
  deps: ResolvedDeps,
  request: ParamPutRequest,
  approvedBy: string | null,
  allowSelfApprove = false,
): Promise<ParamChange> {
  const values = await deps.params.values();
  const previous = values
    .filter((value) => value.key === request.key && value.scopeRef === request.scopeRef)
    .reduce((highest, value) => Math.max(highest, value.version), 0);

  const change = ParamChange.parse({
    key: request.key,
    scopeRef: request.scopeRef,
    value: request.value,
    version: previous + 1,
    changedBy: request.actor,
    approvedBy,
    at: deps.clock.now().toISOString(),
  });

  await deps.params.apply(change, allowSelfApprove ? { allowSelfApprove: true } : undefined);
  await deps.audit.append({
    actor: approvedBy ?? request.actor,
    action: "PARAM_CHANGED",
    subject: `param:${request.key}`,
    at: change.at,
    meta: {
      scopeRef: request.scopeRef,
      version: change.version,
      value: request.value,
      changedBy: change.changedBy,
      approvedBy,
      // True only when a master admin approved a guarded change they proposed
      // themselves — the four-eyes exemption, recorded so it is auditable.
      soloApproval: allowSelfApprove,
    },
  });
  return change;
}

/**
 * Same human behind two actor strings, seeing through `ai-via:` delegation
 * (M32/M101). System actors have no human behind them and never match, so a
 * `maestro-worker` proposal cannot be confirmed by another `maestro-worker`.
 */
function samePerson(left: string, right: string): boolean {
  const leftHuman = humanBehind(left);
  const rightHuman = humanBehind(right);
  return leftHuman !== null && leftHuman === rightHuman;
}

/** `null` when the value fits the definition, otherwise the reason it does not. */
function checkValue(definition: ParamDefinition, value: unknown): string | null {
  switch (definition.type) {
    case "string":
      return typeof value === "string" ? null : "expected string";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "expected finite number";
    case "boolean":
      return typeof value === "boolean" ? null : "expected boolean";
    case "enum": {
      const allowed = definition.enumValues ?? [];
      if (allowed.length === 0) return "definition declares no enum values";
      return typeof value === "string" && allowed.includes(value)
        ? null
        : `expected one of ${allowed.join(", ")}`;
    }
    case "json":
      return value === undefined ? "expected a JSON value" : null;
  }
}
