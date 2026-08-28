import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ListeningRuleRecord, ListeningStore } from "../listening-store.js";
import { ASSIGNED_MATCH_VALUE, FLOW_TYPES, MATCH_KINDS, StatusMapSchema } from "../listening-store.js";
import { seedProjectDefaults } from "../listening-seed.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { assertWritable } from "../platform/propose.js";
import { unwired } from "./unwired.js";

/**
 * The listening-rules surface ("dinleme kuralları").
 *
 * An admin defines, from Studio, which tickets Maestro picks up and how it runs
 * them: "in project X, a ticket assigned to the bot whose <status|issuetype> is
 * <value> runs as <analiz|duzeltme|gelistirme>". These rows replace the
 * hard-coded `discoveryJql` (`apps/pilot/src/config.ts`), so the pilot's
 * discovery becomes configuration, not code.
 *
 * A rule is a trigger-to-flow mapping — not a model choice or a data-class
 * decision — so it is NOT four-eyes-guarded (unlike `dataclass.policy`). It is a
 * simple admin CRUD, gated the same way connections are: reads for admin +
 * tech-lead, writes for admin. Every write is audited.
 */

const READ_ROLES = ["admin", "tech-lead"] as const;
const WRITE_ROLES = ["admin"] as const;
/**
 * Who may trigger the default-rule seed. Wider than `WRITE_ROLES` on purpose:
 * seeding is the "works out of the box" step of onboarding (an admin/tech-lead
 * surface), it only ADDS the platform's own conservative defaults and never
 * touches an existing rule, so it is gated like onboarding rather than like a
 * free-form rule edit.
 */
const SEED_ROLES = ["admin", "tech-lead"] as const;

/** The seed endpoint's body: which project to seed defaults for. */
const SeedBody = z.object({ projectKey: z.string().trim().min(1).max(32) }).strict();

/** The `:id` path param — a rule id is an opaque token. */
const IdParam = z.object({ ruleId: z.string().min(1).max(64) });

/**
 * The write body a route accepts. Mirrors the DB CHECK domains: `matchKind` and
 * `flowType` are closed enums here so an invalid value is a 400, not a row the
 * database rejects with a 500-shaped constraint error.
 */
/**
 * An optional agent-variant reference (Faz 3): absent, null and "" all mean
 * "the default agent" and normalise to `null`, so the DB stores one shape and
 * the pilot mirror never sees an empty string masquerading as a choice.
 */
const VariantRef = z
  .string()
  .trim()
  .max(64)
  .nullish()
  .transform((value) => (value == null || value === "" ? null : value));

/**
 * The Jira status map (durum eşlemesi), optional per rule. Absent, null and the
 * empty object all normalise to `null` — comment-only mode, today's behaviour —
 * so the DB stores ONE shape for "this rule does not move tickets" and a UI that
 * renders an empty form does not accidentally look like a configured map.
 *
 * `StatusMapSchema` is `.strict()`, so a misspelt key (`onDoneX`) and a
 * non-string value are both a 400 through the same `invalid_listening_rule`
 * code the rest of this body already uses. That is deliberate: a silently
 * dropped key would show up much later as tickets that mysteriously never move,
 * with nothing on the screen to explain why.
 */
const StatusMapRef = StatusMapSchema.nullish().transform((value) =>
  value == null || Object.keys(value).length === 0 ? null : value,
);

const RuleBody = z.object({
  projectKey: z.string().trim().min(1).max(32),
  assigneeAccountId: z.string().trim().min(1).max(128),
  matchKind: z.enum(MATCH_KINDS as unknown as [string, ...string[]]),
  /**
   * The status or issue-type name that triggers the rule. Still required for an
   * `assigned` rule, whose value is normalised below — the column is NOT NULL
   * and the unique trigger index needs a real string to collide on.
   */
  matchValue: z.string().trim().min(1).max(128),
  flowType: z.enum(FLOW_TYPES as unknown as [string, ...string[]]),
  priority: z.number().int().min(0).max(10_000).default(100),
  enabled: z.boolean().default(true),
  /** Which agent variant runs the analysis side; null → default agent. */
  analystVariantId: VariantRef,
  /** Which agent variant runs the engineering side; null → default agent. */
  engineerVariantId: VariantRef,
  /** The Jira status map; null → comment-only mode (Maestro never moves the ticket). */
  statusMap: StatusMapRef,
});

/**
 * The rule as it is STORED, from the rule as it was sent.
 *
 * One normalisation, and it exists for the unique index rather than for taste.
 * An `assigned` rule ("bota atanan her ticket") compares no field, so whatever
 * the client put in `matchValue` is meaningless — but if two clients send two
 * different meaningless strings, the (projectKey, assigneeAccountId, matchKind,
 * matchValue) index sees two distinct triggers and a project quietly ends up
 * with several catch-all rules that all match every ticket. Pinning the value
 * to one literal here makes "at most one catch-all per project and bot" a
 * database guarantee, enforced against every client including a hand-rolled
 * curl, instead of a rule the Studio form happens to follow.
 */
function storedRule<T extends { matchKind: string; matchValue: string }>(body: T): T {
  return body.matchKind === "assigned" ? { ...body, matchValue: ASSIGNED_MATCH_VALUE } : body;
}

function listeningDeps(deps: ResolvedDeps): { store: ListeningStore } {
  if (deps.listening === undefined) unwired("listening");
  return { store: deps.listening };
}

export async function listeningRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const readHandler = [authGuard(deps), requireAnyRole(...READ_ROLES)];
  const writeHandler = [authGuard(deps), requireAnyRole(...WRITE_ROLES)];

  /** List every rule, ordered (projectKey, priority). */
  app.get("/studio/listening-rules", { preHandler: readHandler }, async (_request, reply) => {
    const { store } = listeningDeps(deps);
    const rules = await store.list();
    return reply.code(200).send({ rules });
  });

  /**
   * Is the ticket sweep running, and what did it last find?
   *
   * The rules screen could show what Maestro is SUPPOSED to pick up and had no
   * way to say whether anything was actually looking. An operator whose
   * tickets never arrive has to distinguish three states that need three
   * different fixes: the sweep is off, it runs and finds nothing, or it is
   * failing. This answers exactly that.
   */
  app.get("/studio/listening-status", { preHandler: readHandler }, async (_request, reply) => {
    const read = deps.discoveryStatus;
    return reply.code(200).send(
      read === undefined
        ? {
            enabled: false,
            intervalMs: 0,
            lastRunAt: null,
            lastStarted: 0,
            rulesSearched: 0,
            lastError: null,
          }
        : read(),
    );
  });

  /** Create a rule. A duplicate trigger (unique index) becomes a 409. */
  app.post("/studio/listening-rules", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store } = listeningDeps(deps);

    const body = RuleBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_listening_rule");

    const ruleId = `lr_${randomBytes(9).toString("hex")}`;
    const record: ListeningRuleRecord = {
      ruleId,
      ...storedRule(body.data as Omit<ListeningRuleRecord, "ruleId">),
    };
    try {
      await store.put(record);
    } catch (error) {
      // The unique (projectKey, assigneeAccountId, matchKind, matchValue) index
      // rejects a second rule for the same trigger — that is a 409, not a 500.
      if (isUniqueViolation(error)) throw badRequest("duplicate_listening_rule");
      throw error;
    }
    await audit(deps, request, ruleId, "created");
    return reply.code(201).send({ rule: record });
  });

  /**
   * Seed the DEFAULT rules for a project — the "works out of the box" step.
   *
   * Reads the project's real issue types off live Jira (via the stored Jira
   * connection that knows the bot account) and creates one `issuetype` rule per
   * non-subtask type: bug-like types run `duzeltme`, everything else `analiz`,
   * and `gelistirme` is never assigned automatically (see listening-seed.ts).
   * IDEMPOTENT — existing triggers are skipped, so an admin's hand-edited flow
   * type survives any number of re-seeds.
   *
   * Honesty rules: a missing Jira connection or an untested one (no bot
   * account) is a NAMED 409 the operator can fix; a Jira read that fails is the
   * fail-soft fallback — NO rules are written (never invented type names) and
   * the response says why with `created: 0`.
   */
  app.post(
    "/studio/listening-rules/seed-defaults",
    { preHandler: [authGuard(deps), requireAnyRole(...SEED_ROLES)] },
    async (request, reply) => {
      await assertWritable(deps);
      listeningDeps(deps); // 503-by-name before anything else when unwired

      const body = SeedBody.safeParse(request.body);
      if (!body.success) throw badRequest("invalid_listening_seed");

      const outcome = await seedProjectDefaults(deps, body.data.projectKey);
      if (!outcome.ok) {
        if (outcome.reason === "listening_unwired") unwired("listening");
        if (outcome.reason === "connections_unwired") unwired("connections");
        if (outcome.reason === "issue_types_unavailable") {
          // The fallback: Jira's type list could not be read, so nothing was
          // seeded and no type name was invented. Not an error status — the
          // store is exactly as the caller left it, and the reason is named.
          return reply
            .code(200)
            .send({ created: 0, skipped: 0, rules: [], reason: outcome.reason });
        }
        // no_jira_connection / bot_account_unknown: deployment facts an
        // operator can act on (add a Jira connection / run its live test).
        throw conflict(outcome.reason, { projectKey: body.data.projectKey });
      }

      if (outcome.created > 0) {
        await audit(deps, request, `seed:${body.data.projectKey}`, "seeded");
      }
      return reply
        .code(200)
        .send({ created: outcome.created, skipped: outcome.skipped, rules: outcome.rules });
    },
  );

  /** Replace a rule by id. */
  app.put("/studio/listening-rules/:ruleId", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store } = listeningDeps(deps);

    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_listening_rule_id");
    const body = RuleBody.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_listening_rule");

    if ((await store.get(params.data.ruleId)) === null) throw notFound("no_such_listening_rule");

    const record: ListeningRuleRecord = {
      ruleId: params.data.ruleId,
      ...storedRule(body.data as Omit<ListeningRuleRecord, "ruleId">),
    };
    try {
      await store.put(record);
    } catch (error) {
      if (isUniqueViolation(error)) throw badRequest("duplicate_listening_rule");
      throw error;
    }
    await audit(deps, request, params.data.ruleId, "updated");
    return reply.code(200).send({ rule: record });
  });

  /** Delete a rule. */
  app.delete("/studio/listening-rules/:ruleId", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store } = listeningDeps(deps);

    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_listening_rule_id");

    const removed = await store.remove(params.data.ruleId);
    if (!removed) throw notFound("no_such_listening_rule");
    await audit(deps, request, params.data.ruleId, "deleted");
    return reply.code(204).send();
  });
}

/** A Postgres unique-constraint violation (Prisma P2002 or a raw 23505). */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2002" || code === "23505";
}

/**
 * The audit row for a listening-rule change. Uses `PARAM_CHANGED` — a listening
 * rule is platform configuration in the same governance category — and carries
 * the rule id and the verb.
 */
async function audit(
  deps: ResolvedDeps,
  request: Parameters<typeof sessionOf>[0],
  ruleId: string,
  verb: string,
): Promise<void> {
  await deps.audit.append({
    actor: sessionActor(sessionOf(request)),
    action: "PARAM_CHANGED",
    subject: `listening-rule:${ruleId}`,
    at: deps.clock.now(),
    meta: { surface: "listening", verb },
  });
}
