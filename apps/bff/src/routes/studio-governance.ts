import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authGuard, requireAnyRole } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest } from "../errors.js";
import { pageOf } from "./paging.js";
import { unwired } from "./unwired.js";

/**
 * The two screens an auditor opens, and the two with nothing behind them.
 *
 * `/pii` and `/decisions` are role-gated: masking statistics describe where
 * customer data flows, and the decision ledger names who decided what. Neither
 * is something every account with a login should be able to enumerate, so both
 * ask for `admin` or `internal-audit` rather than a bare session.
 *
 * `/eval` and `/greenfield` refuse. Neither has a table, and — the part that
 * matters — neither has a PRODUCER: nothing in this platform runs a golden
 * ticket or writes an architecture proposal, so a table for either would be
 * columns nothing fills and every read would answer an empty page. See
 * `routes/unwired.ts` for why that is worse than the error.
 */

/**
 * Who may read masking statistics and the decision ledger (M86/M33).
 *
 * `admin` and `tech-lead`, matching `CATALOG_ROLES` on the other admin surface
 * — NOT an "internal-audit" role. There is no such role: `packages/contracts`
 * closes the set at `admin | tech-lead | product-owner | qa | developer |
 * viewer`, and the bank's `internal-audit` DIRECTORY GROUP maps to `viewer`
 * (`ROLE_BY_GROUP` in the deploy user store). Naming a role the contract does
 * not define would have produced a guard that can never pass — the auditor
 * would have been refused by the one screen written for them, and the refusal
 * would have looked like a permissions misconfiguration rather than a typo
 * here.
 *
 * Giving the audit group its own role is a directory-and-contract change, not
 * a change this route may make on its own; see the interface request in the
 * report.
 */
export const AUDIT_ROLES = ["admin", "tech-lead"] as const;

/**
 * The `/pii` wire shape.
 *
 * SECURITY, enforced HERE and not only in the store: this schema is `strict()`
 * at every level, so a store that ever starts returning a sample value, a
 * plaintext or an unmasked field makes this route THROW rather than forward it.
 * The v1 audit finding was an unmasked second copy kept for display; a
 * permissive output schema is how that comes back. Counts and rule identities
 * only — `matcher` is a field name or a pattern, never a value.
 */
const PiiOut = z
  .object({
    summary: z
      .object({
        maskedCalls: z.number().int().nonnegative(),
        totalCalls: z.number().int().nonnegative(),
        maskedFields: z.number().int().nonnegative(),
        exemptVariants: z.array(z.string().min(1)),
        onPremCalls: z.number().int().nonnegative(),
        archiveMasked: z.boolean(),
      })
      .strict(),
    rules: z.array(
      z
        .object({
          ruleId: z.string().min(1),
          kind: z.enum(["field", "regex"]),
          matcher: z.string().min(1),
          strategy: z.enum(["hash", "redact", "partial"]),
          hits: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

const DecisionsOut = z
  .object({
    decisions: z.array(
      z
        .object({
          decisionId: z.string().min(1),
          ref: z.string().min(1),
          question: z.string().min(1),
          /**
           * The decision, as its two machine parts rather than one joined
           * sentence — the screen translates `action` through
           * `audit.action.*` and composes the line. See `toDecision`.
           */
          action: z.string().min(1),
          actor: z.string().min(1),
          severity: z.string().min(1),
          status: z.string().min(1),
          decidedAt: z.string().min(1),
          basis: z
            .object({
              auditSeq: z.number().int().nonnegative(),
              chainVerified: z.boolean(),
            })
            .strict(),
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
    /**
     * Whether the hash chain these rows were read from still recomputes (M33).
     *
     * Sent alongside every page rather than as a separate "verified" badge the
     * screen could cache: a ledger rendered from a chain that no longer
     * verifies must say so on the same response that carried the rows, or the
     * two can drift and the operator reads yesterday's assurance over today's
     * data.
     */
    chainVerified: z.boolean(),
  })
  .strict();

export async function studioGovernanceRoutes(
  app: FastifyInstance,
  deps: ResolvedDeps,
): Promise<void> {
  const preHandler = authGuard(deps);
  const auditOnly = [preHandler, requireAnyRole(...AUDIT_ROLES)];

  /**
   * PII masking statistics (M20/M63).
   *
   * Counts and rules. There is no parameter that could ask for a value, no
   * field in the response that could carry one, and the output schema above
   * refuses any extra key a store might grow — so this endpoint cannot become
   * an unmasking channel by accident, only by somebody deliberately widening
   * three separate things at once.
   */
  app.get("/pii", { preHandler: auditOnly }, async (_request, reply) => {
    const reader = deps.studio.pii;
    if (reader === undefined) unwired("pii");

    const stats = await reader.stats();
    return reply.code(200).send(PiiOut.parse(stats));
  });

  /**
   * The decision ledger (M33).
   *
   * Every row carries the audit sequence it was derived from and whether the
   * chain still verifies, because "the platform says this was decided" is not
   * evidence — the chain recomputing is. The screen shows the rows; an auditor
   * who wants to check one has the seq to look it up with.
   *
   * The verification is recomputed per request rather than trusted from a
   * stored flag. A boolean somebody wrote once is exactly the thing an attacker
   * who rewrote the trail would also have rewritten.
   */
  app.get("/decisions", { preHandler: auditOnly }, async (request, reply) => {
    const reader = deps.studio.decisions;
    if (reader === undefined) unwired("decisions");

    const page = pageOf(request.query);
    const result = await reader.list(page);
    const chainVerified = result.items.every((row) => row.basis.chainVerified);

    return reply.code(200).send(
      DecisionsOut.parse({
        decisions: result.items,
        nextCursor: result.nextCursor,
        // An empty page proves nothing about a chain, so it is not "verified".
        chainVerified: result.items.length > 0 && chainVerified,
      }),
    );
  });

  /**
   * The greenfield wizard (M97) — REFUSED.
   *
   * A ticket whose repository does not exist yet runs analysis → AI
   * architecture proposal → HUMAN approval → repo and policy setup → skeleton
   * → first PR. Nothing in `packages/workflows` writes any of it: there is no
   * proposal record, no per-step state, no repo-setup row. The screen asks for
   * `?ticket=` and would get a step list and a proposal.
   *
   * An empty step list renders as a wizard nobody has started, not as a
   * capability that does not exist — and on a screen whose whole job is to show
   * where a NEW project stands, "not started" is a plausible-looking lie. The
   * ticket parameter is still validated below so a malformed request is a 400
   * rather than a 503 that hides a client bug behind a server-side excuse.
   */
  app.get("/greenfield", { preHandler }, async (request) => {
    const parsed = z
      .object({ ticket: z.string().trim().min(1).max(64) })
      .safeParse(request.query);
    if (!parsed.success) throw badRequest("invalid_ticket");
    unwired("greenfield");
  });
}
