import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCsvFileName, auditEventsToCsv, filterAuditEvents } from "../audit-filter.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest } from "../errors.js";
import { pageBody, pageOf, visibleProjects } from "./paging.js";

/**
 * The operator's half of Studio: what is waiting on a human, what the fleet is
 * doing, what the quota looks like, and what the trail says. The fleet, quota
 * and health screens are M86's admin surface — a developer does not need to
 * know which runner is draining — while the gate board is scoped per project
 * like everything else, because it is a work list rather than an inventory.
 */
export const OPS_ROLES = ["admin", "tech-lead"] as const;

/** Only the trail's own auditors read the whole trail (M33/M86). */
export const AUDIT_ROLES = ["admin", "internal-audit"] as const;

export async function studioOpsRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = authGuard(deps);
  const opsHandler = [preHandler, requireAnyRole(...OPS_ROLES)];

  /**
   * Open gates — Studio's `notify` board and the same list `list_pending_gates`
   * serves over MCP. Read-only by construction: closing one is a signal
   * (`POST /runs/:ticket/signals/gateDecision`), and there is no method on the
   * gate board that could be mistaken for a decision.
   */
  app.get("/studio/gates", { preHandler }, async (request, reply) => {
    const filter = GateQuery.safeParse(request.query);
    if (!filter.success) throw badRequest("invalid_query");
    const session = sessionOf(request);

    const page = await deps.read.gates.listOpen({
      ...pageOf(request.query),
      ownerGroup: filter.data.ownerGroup ?? null,
      projectKeys: visibleProjects(session),
    });

    // The waiting time is computed here rather than stored: a duration that was
    // written down at open time is wrong by the time anybody reads it.
    const now = deps.clock.now().getTime();
    const items = page.items.map((gate) => ({
      ...gate,
      waitingDays: waitingDays(gate.openedAt, now),
    }));
    return reply.code(200).send(pageBody({ items, nextCursor: page.nextCursor }));
  });

  /** Runner fleet health (M60). Admin surface: it describes the platform, not the work. */
  app.get("/studio/runners", { preHandler: opsHandler }, async (request, reply) => {
    const page = await deps.read.runners.list(pageOf(request.query));
    return reply.code(200).send({
      ...pageBody(page),
      pools: poolsOf(page.items),
    });
  });

  /**
   * Live sandboxes and the workspaces they left behind (M31/M65). Listed here
   * rather than deleted: an idle workspace is archived by the retention job on
   * its own schedule, and a delete button in an operator's hand is how somebody
   * destroys the session a human was mid-way through.
   */
  app.get("/studio/sandboxes", { preHandler: opsHandler }, async (request, reply) => {
    const page = await deps.read.runners.sandboxes(pageOf(request.query));
    return reply.code(200).send(pageBody(page));
  });

  /**
   * The subscription pool and its quota windows (M55). Exposed as accounts
   * rather than a single percentage because the pool is what queues work: one
   * exhausted account with three ready ones is not a platform at 100%.
   */
  app.get("/studio/quota", { preHandler: opsHandler }, async (_request, reply) => {
    const accounts = await deps.read.quota.accounts();
    return reply.code(200).send({ accounts, pool: poolState(accounts) });
  });

  /** Dependency health (M6), beyond the unauthenticated `/readyz` probe. */
  app.get("/studio/health", { preHandler: opsHandler }, async (_request, reply) => {
    const services = await deps.read.health.services();
    // `not_configured` never colours the aggregate: an LLM nobody has set up
    // is a to-do on the settings screen, not a platform that deserves an
    // amber banner — and letting it degrade the overall state would teach
    // operators to ignore that banner, which is how a real outage gets missed.
    const worst = services.some((service) => service.state === "down")
      ? "down"
      : services.some((service) => service.state === "degraded")
        ? "degraded"
        : "healthy";
    return reply.code(200).send({ state: worst, services });
  });

  const auditHandler = [preHandler, requireAnyRole(...AUDIT_ROLES)];

  /**
   * The audit trail (M33). Narrower than the rest of the ops surface: the trail
   * records who approved what, so reading all of it is an auditor's privilege
   * rather than an operator's convenience. Filterable by a time window, an
   * exact actor/action and a free-text needle (B13) — the same filter the CSV
   * export honours, so the screen and the file can never disagree.
   */
  app.get("/studio/audit", { preHandler: auditHandler }, async (request, reply) => {
    const filter = AuditQuery.safeParse(request.query);
    if (!filter.success) throw badRequest("invalid_query");

    const page = await deps.read.audit.list({
      ...pageOf(request.query),
      actor: filter.data.actor ?? null,
      subject: filter.data.subject ?? null,
      from: filter.data.from ?? null,
      to: filter.data.to ?? null,
      action: filter.data.action ?? null,
      q: filter.data.q ?? null,
    });
    return reply.code(200).send(pageBody(page));
  });

  /**
   * The regulator export (B13): the SAME filters, but the WHOLE filtered
   * window as one CSV file — the deliberate exception to the paging rule in
   * paging.ts, because a regulator asks for a file, not page one of it. Rows
   * come out in chain order (ascending seq), read through the chain itself so
   * the export can never show a record the trail does not contain.
   */
  app.get("/studio/audit.csv", { preHandler: auditHandler }, async (request, reply) => {
    const filter = AuditQuery.safeParse(request.query);
    if (!filter.success) throw badRequest("invalid_query");

    const events = filterAuditEvents(await deps.audit.read(), filter.data);
    return reply
      .code(200)
      .header("content-type", "text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="${auditCsvFileName(deps.clock.now())}"`,
      )
      .send(auditEventsToCsv(events));
  });

  /**
   * Recompute the hash chain (M33). A GET because it changes nothing — it
   * recomputes and compares, and a verification that could repair the chain
   * would be a verification nobody should believe.
   */
  app.get(
    "/studio/audit/verification",
    { preHandler: auditHandler },
    async (_request, reply) => {
      const result = await deps.read.audit.verify();
      // 200 either way: "the chain is broken" is a successful answer to the
      // question, and an error status would make a tampered trail look like an
      // endpoint that failed to load.
      return reply.code(200).send(result);
    },
  );
}

const GateQuery = z.object({ ownerGroup: z.string().trim().min(1).max(128).optional() });

const AuditQuery = z.object({
  actor: z.string().trim().min(1).max(256).optional(),
  subject: z.string().trim().min(1).max(256).optional(),
  /** ISO instants, compared lexically against `at`, both bounds inclusive. */
  from: z.string().trim().min(1).max(64).optional(),
  to: z.string().trim().min(1).max(64).optional(),
  action: z.string().trim().min(1).max(128).optional(),
  q: z.string().trim().min(1).max(256).optional(),
});

/** Whole days a gate has been open; floored, because "0 days" is honest on day one. */
export function waitingDays(openedAt: string, now: number): number {
  const opened = Date.parse(openedAt);
  if (Number.isNaN(opened)) return 0;
  return Math.max(0, Math.floor((now - opened) / 86_400_000));
}

/** Per-pool capacity, summed from the runners on this page. */
function poolsOf(
  runners: readonly { pool: string; capacity: number; activeSandboxes: number; state: string }[],
): { pool: string; capacity: number; busy: number; machines: number; unhealthy: number }[] {
  const pools = new Map<string, { pool: string; capacity: number; busy: number; machines: number; unhealthy: number }>();
  for (const runner of runners) {
    const entry = pools.get(runner.pool) ?? {
      pool: runner.pool,
      capacity: 0,
      busy: 0,
      machines: 0,
      unhealthy: 0,
    };
    entry.capacity += runner.capacity;
    entry.busy += runner.activeSandboxes;
    entry.machines += 1;
    if (runner.state === "unreachable" || runner.state === "draining") entry.unhealthy += 1;
    pools.set(runner.pool, entry);
  }
  return [...pools.values()];
}

/**
 * Whether the pool as a whole can still take work (M55). `exhausted` is the
 * state that makes a workflow QUEUE rather than fail, so it is reported as a
 * fact about the pool rather than folded into an average.
 */
function poolState(accounts: readonly { state: string }[]): {
  ready: number;
  cooling: number;
  exhausted: number;
  disabled: number;
  hasCapacity: boolean;
} {
  const count = (state: string): number => accounts.filter((a) => a.state === state).length;
  const ready = count("ready");
  return {
    ready,
    cooling: count("cooling"),
    exhausted: count("exhausted"),
    disabled: count("disabled"),
    hasCapacity: ready > 0,
  };
}
