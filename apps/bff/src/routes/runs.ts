import { ClarificationAnswerSignal, TicketKey, WorkMode } from "@maestro/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isHumanChannel, sessionActor } from "../actor.js";
import { authGuard, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps, SessionRecord } from "../deps.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { decideGate } from "../gate-decision.js";
import { workflowIdFor } from "../gateway.js";
import { projectKeyOf } from "../jira-intake.js";
import { isStudioSignal, SIGNALS, STUDIO_SIGNALS } from "../signal-names.js";
import { assertProjectAccess, canSeeProject } from "./access.js";

/** Project visibility now lives in `access.js`; re-exported for existing callers. */
export { CROSS_PROJECT_ROLES, projectGroupFor } from "./access.js";

/**
 * Run visibility and Studio's secondary decision path (M51: Jira is the main
 * one). Everything here is authenticated, and the signal endpoint is an
 * allow-list rather than a passthrough — a generic "send any signal" route
 * would let a logged-in user forge a build result or a kill switch.
 *
 * Authentication is not authorisation (M86). A session says who you are; it
 * does not say that this ticket is any of your business. Without the project
 * check below, any account with a login could drive a stranger's run to
 * full_auto or answer a requirement in their name.
 */
export async function runRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = authGuard(deps);

  app.get("/runs", { preHandler }, async (request, reply) => {
    const query = z
      .object({ limit: z.coerce.number().int().positive().max(500).optional() })
      .safeParse(request.query);
    if (!query.success) throw badRequest("invalid_query");
    const session = sessionOf(request);
    const runs = await deps.runs.list(
      query.data.limit === undefined ? {} : { limit: query.data.limit },
    );
    // Filtered rather than refused: a list is "your work", not an error.
    const visible = runs.filter((run) => canSeeProject(session, projectKeyOf(run.ticketKey)));
    return reply.code(200).send({ runs: visible });
  });

  app.get("/runs/:ticket", { preHandler }, async (request, reply) => {
    const ticket = ticketParam(request.params);
    // Checked BEFORE the run is looked up: answering 404 for a project the
    // caller cannot see would turn this route into a ticket oracle.
    assertProjectAccess(sessionOf(request), ticket);
    const state = await deps.runs.queryRunState(workflowIdFor(ticket));
    if (state === null) throw notFound("no_run", { ticket });
    return reply.code(200).send(state);
  });

  app.post("/runs/:ticket/signals/:name", { preHandler }, async (request, reply) => {
    const ticket = ticketParam(request.params);
    const name = signalParam(request.params);
    const session = sessionOf(request);
    assertProjectAccess(session, ticket);

    if (name === SIGNALS.gateDecision) {
      return reply.code(200).send(await studioGateDecision(deps, ticket, session, request.body));
    }
    if (name === SIGNALS.clarificationAnswered) {
      return reply.code(202).send(await studioClarification(deps, ticket, session, request.body));
    }
    return reply.code(202).send(await studioModeChange(deps, ticket, session, request.body));
  });
}

const GateBody = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(1).optional(),
});

/**
 * A gate decision from Studio. The identity is the SESSION's, never the body's
 * — a payload field naming the approver would be a signature anybody could
 * forge — and an AI holding a delegated token is refused outright (M32/M101).
 */
async function studioGateDecision(
  deps: ResolvedDeps,
  ticket: TicketKey,
  session: SessionRecord,
  body: unknown,
): Promise<unknown> {
  if (!isHumanChannel(session)) throw forbidden("human_channel_only");

  const parsed = GateBody.safeParse(body);
  if (!parsed.success) throw badRequest("invalid_signal_body");
  if (parsed.data.decision === "reject" && parsed.data.reason === undefined) {
    throw badRequest("reject_needs_reason");
  }

  const result = await decideGate(deps, {
    ticket,
    decision: parsed.data.decision,
    actor: sessionActor(session),
    membershipId: session.username,
    source: "studio",
    at: deps.clock.now().toISOString(),
    ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
  });

  if (result.ok) return { accepted: true, step: result.step, signatureSeq: result.signatureSeq };
  if (result.reason === "not_member") throw forbidden("not_gate_owner", { group: result.group });
  if (result.reason === "no_run") throw notFound("no_run", { ticket });
  throw conflict(result.reason, { step: result.step });
}

const ClarificationBody = z.object({ text: z.string().trim().min(1) });

async function studioClarification(
  deps: ResolvedDeps,
  ticket: TicketKey,
  session: SessionRecord,
  body: unknown,
): Promise<unknown> {
  const parsed = ClarificationBody.safeParse(body);
  if (!parsed.success) throw badRequest("invalid_signal_body");

  const at = deps.clock.now().toISOString();
  const signal = ClarificationAnswerSignal.parse({
    ticketKey: ticket,
    answeredBy: sessionActor(session),
    text: parsed.data.text,
    at,
  });
  const delivered = await deps.runs.signal(
    workflowIdFor(ticket),
    SIGNALS.clarificationAnswered,
    signal,
  );
  if (delivered === "no_run") throw notFound("no_run", { ticket });

  await deps.audit.append({
    actor: sessionActor(session),
    action: "CLARIFICATION_ANSWERED",
    subject: ticket,
    at,
    meta: { source: "studio" },
  });
  return { accepted: true };
}

const ModeBody = z.object({ mode: WorkMode });

async function studioModeChange(
  deps: ResolvedDeps,
  ticket: TicketKey,
  session: SessionRecord,
  body: unknown,
): Promise<unknown> {
  const parsed = ModeBody.safeParse(body);
  if (!parsed.success) throw badRequest("invalid_signal_body");

  const actor = sessionActor(session);
  const delivered = await deps.runs.signal(workflowIdFor(ticket), SIGNALS.modeChange, {
    mode: parsed.data.mode,
    actor,
  });
  if (delivered === "no_run") throw notFound("no_run", { ticket });

  await deps.audit.append({
    actor,
    action: "MODE_CHANGED",
    subject: ticket,
    at: deps.clock.now(),
    meta: { mode: parsed.data.mode, source: "studio" },
  });
  return { accepted: true, mode: parsed.data.mode };
}

function ticketParam(params: unknown): TicketKey {
  const parsed = z.object({ ticket: TicketKey }).safeParse(params);
  if (!parsed.success) throw badRequest("invalid_ticket_key");
  return parsed.data.ticket;
}

function signalParam(params: unknown): (typeof STUDIO_SIGNALS)[number] {
  const parsed = z.object({ name: z.string() }).safeParse(params);
  if (!parsed.success || !isStudioSignal(parsed.data.name)) {
    throw forbidden("signal_not_allowed", { allowed: STUDIO_SIGNALS });
  }
  return parsed.data.name;
}
