import type { AuditAction } from "@maestro/contracts";
import { AI_VIA_PREFIX, parseActor } from "@maestro/audit";
import { McpDefinitionError } from "./errors.js";
import type { CallerIdentity, ToolScope } from "./scopes.js";

/**
 * The actor string every MCP tool call is recorded under (M101).
 *
 * `ai-via:<user>` — the AI holds no identity, it holds a person's token, and
 * the record keeps that person visible. `@maestro/audit.parseActor` is the
 * single authority on the accepted forms; calling it here means an actor this
 * package mints can never be one the audit chain would refuse at append time.
 */
export function aiViaActor(caller: CallerIdentity): string {
  const actor = `${AI_VIA_PREFIX}${caller.user.trim()}`;
  const identity = parseActor(actor);
  if (identity?.kind !== "ai_delegated") {
    throw new McpDefinitionError(
      `caller "${caller.user}" is not a corporate account; an MCP token must belong to a person (M101)`,
    );
  }
  return actor;
}

/**
 * `attempted` is the first half of the two-phase record every state-changing
 * call now carries (verifier B1).
 *
 * The chain used to be written after the handler, so a sink that was down let
 * the effect land and then threw: the CALL failed, the WORK did not, and the
 * run existed with no row naming it. `attempted` is written before the handler
 * and, crucially, the handler does not run if that write fails — which turns
 * an unrecordable effect into an effect that never happens. It is closed by an
 * `ok` or `error` row on the same tool and subject, so gap detection (M33) sees
 * a dangling `attempted` as the anomaly it is.
 */
export type ToolOutcome = "attempted" | "ok" | "denied" | "error";

/**
 * One audited MCP tool call.
 *
 * `action` carries a contract `AuditAction` where one describes the call
 * truthfully (`start_workflow` → `RUN_STARTED`, `assign_app` → `ASSIGN_APP`)
 * and `null` otherwise. Reads have no action code because the frozen enum has
 * none, and `propose_param_change` deliberately does NOT claim `PARAM_CHANGED`:
 * nothing changed, a proposal entered a four-eyes queue, and an audit line
 * saying otherwise would be the most misleading row in the file.
 * RAPOR.md carries the request for an `MCP_TOOL_CALL` action.
 */
export interface ToolAuditRecord {
  readonly at: string;
  /** Always `ai-via:<user>` — see `aiViaActor`. */
  readonly actor: string;
  readonly server: string;
  readonly tool: string;
  /** `null` only when the name matched no tool, so no scope was ever in play. */
  readonly scope: ToolScope | null;
  /**
   * What the call was about — a ticket key, a run id, a repo-relative path.
   * Derived by the tool from VALIDATED arguments and nothing else: raw
   * arguments never reach the audit record, because free-text tool input is
   * exactly where customer data would ride into a table that is kept for
   * years and never masked (M20/M82).
   */
  readonly subject: string;
  readonly outcome: ToolOutcome;
  readonly action: AuditAction | null;
  readonly meta: Readonly<Record<string, unknown>>;
}

/**
 * The seam onto the hash chain (`@maestro/audit` + the `AuditLog` table). This
 * package writes no database: the composition root hands it a sink, exactly as
 * M44 requires, and tests hand it an array.
 *
 * A sink that throws stops the call — see `ToolAuditError`. An MCP tool call
 * that cannot be recorded is a call nobody can account for afterwards, and the
 * whole point of M101 is that a conversation with an AI leaves the same trail
 * as a click in Studio.
 */
export interface ToolAuditSink {
  record(entry: ToolAuditRecord): Promise<void>;
}

/** Collecting sink for tests, seeds and the offline demo. */
export class InMemoryToolAuditSink implements ToolAuditSink {
  private readonly entries: ToolAuditRecord[] = [];

  record(entry: ToolAuditRecord): Promise<void> {
    this.entries.push(Object.freeze({ ...entry }));
    return Promise.resolve();
  }

  all(): readonly ToolAuditRecord[] {
    return this.entries;
  }

  forTool(tool: string): readonly ToolAuditRecord[] {
    return this.entries.filter((entry) => entry.tool === tool);
  }
}
