import type { JournalEntry, ParamKey, RepoCard, WorkflowRunState } from "@maestro/contracts";
import type {
  KnowledgeHit,
  MaestroPlatform,
  ParamView,
  PendingGate,
  QuotaStatus,
  RunDetail,
  RunnerHealth,
} from "@maestro/mcp-servers";
import type { ResolvedDeps, SessionRecord } from "../deps.js";
import { forbidden, notFound } from "../errors.js";
import { workflowIdFor } from "../gateway.js";
import { projectKeyOf } from "../jira-intake.js";
import { visibleKnowledge } from "../knowledge-policy.js";
import { canSeeProject } from "../routes/access.js";
import { visibleProjects } from "../routes/paging.js";
import { waitingDays } from "../routes/studio-ops.js";
import { scopeOf } from "./actor-scope.js";
import { runOf } from "./run-lookup.js";

/**
 * The read half of `MaestroPlatform` (M101). Every method resolves the acting
 * user to the same authorisation subject the REST guard produces and then
 * reaches for the same read models Studio does — which is the point of the
 * interface: MCP and Studio must not have two sources of truth that can
 * disagree about what a run's status is.
 */

/**
 * Ceiling on what a single tool call may pull back, whatever it asked for.
 *
 * This is a bound on ONE page, and on this interface it is also the last page:
 * `listRuns` returns `readonly WorkflowRunState[]` with no cursor field, so a
 * caller asking for more runs than this gets the first `PLATFORM_MAX_LIMIT` and
 * no way to tell that more existed. That is a real gap and it is not fixable
 * here — the return shape is in the frozen `MaestroPlatform`; see the interface
 * request in `deploy/RAPOR-duzeltme.md`.
 *
 * What was fixable is everything keyed by an exact id. `runOf` and the
 * `ticketKey` filter no longer search a page: they look the key up directly, so
 * "which run is this" and "show me this ticket" stopped depending on how
 * recently the run was touched. A truncated LIST is a smaller answer; a
 * truncated LOOKUP was a wrong one.
 */
export const PLATFORM_MAX_LIMIT = 200;

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 1;
  return Math.min(Math.floor(limit), PLATFORM_MAX_LIMIT);
}

export type ReadHalf = Pick<
  MaestroPlatform,
  | "listRuns"
  | "getRun"
  | "getJournal"
  | "getParams"
  | "getRepoCard"
  | "searchKnowledge"
  | "listPendingGates"
  | "quotaStatus"
  | "runnerHealth"
>;

export function readHalf(deps: ResolvedDeps): ReadHalf {
  return {
    async listRuns(actingUser, filter): Promise<readonly WorkflowRunState[]> {
      const session = await scopeOf(deps, actingUser);

      // A ticket key is an exact key, so it is answered by a lookup rather
      // than by paging until the ticket turns up. Filtering a recency-ordered
      // page AFTER fetching it made `ticketKey` mean "this ticket, if it is
      // among the most recent runs" — an empty answer for an older ticket that
      // exists, which reads as "no such run" and is not one.
      if (filter.ticketKey !== undefined) {
        const record = await deps.read.runs.get(filter.ticketKey);
        if (record === null) return [];
        if (!canSeeProject(session, projectKeyOf(record.ticketKey))) return [];
        const state = await deps.runs.queryRunState(workflowIdFor(record.ticketKey));
        if (state === null) return [];
        if (filter.status !== undefined && state.status !== filter.status) return [];
        return [state];
      }

      const page = await deps.read.runs.list({
        limit: clampLimit(filter.limit),
        cursor: null,
        appId: filter.appId ?? null,
        projectKeys: visibleProjects(session),
        // The same default the HTTP list applies (0019): a run an operator has
        // retired from the board is retired from this surface too. The
        // alternative would let a delegated caller report yesterday's
        // dealt-with failures back at the human who archived them, which is
        // the confusion the column was added to end. Note the exact-ticket
        // branch above deliberately does NOT filter: asking for one ticket by
        // name is asking about that run, archived or not.
        archived: "active",
      });

      const states: WorkflowRunState[] = [];
      for (const record of page.items) {
        const state = await deps.runs.queryRunState(workflowIdFor(record.ticketKey));
        if (state === null) continue;
        if (filter.status !== undefined && state.status !== filter.status) continue;
        states.push(state);
      }
      return states;
    },

    async getRun(actingUser, runId): Promise<RunDetail> {
      const session = await scopeOf(deps, actingUser);
      const { record, state } = await runOf(deps, session, runId);

      const gates = await deps.read.gates.listOpen({
        limit: PLATFORM_MAX_LIMIT,
        cursor: null,
        ownerGroup: null,
        projectKeys: [projectKeyOf(record.ticketKey)],
      });
      const open = gates.items.find((gate) => gate.ticketKey === record.ticketKey);
      const now = deps.clock.now().getTime();

      return {
        state,
        appId: record.appId,
        mode: record.mode,
        pendingGate:
          open === undefined
            ? null
            : {
                step: open.step,
                ownerGroup: open.ownerGroup,
                openedAt: open.openedAt,
                waitingDays: waitingDays(open.openedAt, now),
              },
      };
    },

    async getJournal(actingUser, runId, range): Promise<readonly JournalEntry[]> {
      const session = await scopeOf(deps, actingUser);
      await runOf(deps, session, runId);
      const page = await deps.read.journal.list(runId, {
        limit: clampLimit(range.limit),
        cursor: null,
        actor: null,
      });
      return page.items.filter((entry) => entry.seq >= range.fromSeq);
    },

    async getParams(actingUser, filter): Promise<readonly ParamView[]> {
      const session = await scopeOf(deps, actingUser);
      // Parameters decide who approves what and when the flow stops (M71), so
      // reading them is the same admin surface `GET /params` guards, not
      // something a tool scope alone opens.
      assertRole(session, PARAM_READ_ROLES);

      const [definitions, values] = await Promise.all([
        deps.params.definitions(),
        deps.params.values(),
      ]);

      const views: ParamView[] = [];
      for (const definition of definitions) {
        if (filter.scope !== undefined && definition.scope !== filter.scope) continue;
        const latest = values
          .filter((value) => value.key === definition.key)
          .filter((value) => filter.scopeRef === undefined || value.scopeRef === filter.scopeRef)
          .reduce<(typeof values)[number] | null>(
            (best, value) => (best === null || value.version > best.version ? value : best),
            null,
          );
        views.push({
          key: definition.key as ParamKey,
          scope: definition.scope,
          scopeRef: latest?.scopeRef ?? null,
          // The DEFINITION's default when nothing was ever set — a param that
          // was never changed still has a live value, and reporting `null`
          // would read as "unset" for a key that is governing the flow.
          value: latest === null ? definition.defaultValue : latest.value,
          guarded: definition.guarded,
          version: latest?.version ?? 0,
        });
      }
      return views;
    },

    async getRepoCard(actingUser, appId): Promise<RepoCard> {
      await scopeOf(deps, actingUser);
      const card = await deps.read.apps.repoCard(appId);
      if (card === null) throw notFound("no_repo_card", { appId });
      return card;
    },

    async searchKnowledge(actingUser, query): Promise<readonly KnowledgeHit[]> {
      const session = await scopeOf(deps, actingUser);
      const page = await deps.read.knowledge.search({
        limit: clampLimit(query.limit),
        cursor: null,
        text: query.text,
        appId: query.appId ?? null,
      });

      // The same fail-closed classification the REST route applies. A `gizli`
      // hit is DROPPED rather than masked on this channel (M18/M63): a redacted
      // snippet still discloses that the document exists.
      return visibleKnowledge(page.items, session).visible.map((doc) => ({
        id: doc.id,
        title: doc.title,
        snippet: doc.snippet,
        source: doc.source,
        score: doc.score,
        dataClass: doc.dataClass,
      }));
    },

    async listPendingGates(actingUser, filter): Promise<readonly PendingGate[]> {
      const session = await scopeOf(deps, actingUser);
      const page = await deps.read.gates.listOpen({
        limit: clampLimit(filter.limit),
        cursor: null,
        ownerGroup: filter.ownerGroup ?? null,
        projectKeys: visibleProjects(session),
      });

      const now = deps.clock.now().getTime();
      return page.items
        .map((gate) => ({
          runId: gate.runId,
          ticketKey: gate.ticketKey,
          step: gate.step,
          ownerGroup: gate.ownerGroup,
          openedAt: gate.openedAt,
          waitingDays: waitingDays(gate.openedAt, now),
        }))
        .filter(
          (gate) => filter.olderThanDays === undefined || gate.waitingDays >= filter.olderThanDays,
        );
    },

    async quotaStatus(actingUser, filter): Promise<readonly QuotaStatus[]> {
      const session = await scopeOf(deps, actingUser);
      assertRole(session, OPS_READ_ROLES);

      const accounts = await deps.read.quota.accounts();
      const rows: QuotaStatus[] = [];
      for (const account of accounts) {
        if (filter.scopeRef !== undefined && account.accountId !== filter.scopeRef) continue;
        for (const window of account.windows) {
          if (filter.scope !== undefined && window.kind !== filter.scope) continue;
          rows.push({
            scope: window.kind,
            scopeRef: account.accountId,
            // Subscription quota is measured in percent of a window, not in
            // tokens (M55). Reported on a 0-100 scale so the two numbers are a
            // ratio the caller can actually divide, rather than a percentage
            // dressed up as a token count nobody metered.
            usedTokens: Math.round(window.usedPct),
            limitTokens: 100,
            windowEndsAt: window.resetsAt,
            throttled: account.state === "exhausted" || account.state === "cooling",
          });
        }
      }
      return rows;
    },

    async runnerHealth(actingUser): Promise<readonly RunnerHealth[]> {
      const session = await scopeOf(deps, actingUser);
      assertRole(session, OPS_READ_ROLES);

      const page = await deps.read.runners.list({ limit: PLATFORM_MAX_LIMIT, cursor: null });
      return page.items.map((runner) => ({
        runnerId: runner.runnerId,
        platform: runner.platform,
        state: runner.state,
        activeSandboxes: runner.activeSandboxes,
        lastHeartbeatAt: runner.lastHeartbeatAt,
      }));
    },
  };
}

/** Reading the governing parameters is the admin surface (M71/M86). */
export const PARAM_READ_ROLES = ["admin", "tech-lead"] as const;
/** Fleet and quota describe the platform, not the caller's work (M86). */
export const OPS_READ_ROLES = ["admin", "tech-lead"] as const;

function assertRole(session: SessionRecord, roles: readonly string[]): void {
  if (!roles.some((role) => session.roles.includes(role))) {
    throw forbidden("role_required", { anyOf: roles });
  }
}
