import type { LlmCallLog } from "@maestro/contracts";

/**
 * Persisting model calls: what the cost and PII screens read.
 *
 * The gateway reports every call through its optional `onCallLog` hook
 * (`packages/llm-gateway/src/gateway.ts`); this turns that report into an
 * `LlmCall` row. It lives here rather than inline in an entrypoint because two
 * services need it — the worker, which makes the calls, and the pilot launcher,
 * which made them before the workflow path existed — and a second hand-written
 * copy is how the two drift into recording different columns.
 *
 * Only a service that owns the database pool can supply it, which is why
 * `bootPlatform` takes it as an option rather than building one: the platform
 * must not import a Prisma client (M44).
 */

/** The one `PrismaClient.llmCall` method this writer uses. */
export interface LlmCallDelegate {
  create(args: { data: LlmCallRow }): Promise<unknown>;
}

/**
 * The row as written.
 *
 * `role` and `dataClass` are taken from the contract rather than widened to
 * `string`: both are Prisma enums, and the generated client rejects a widened
 * type. That rejection is the useful kind — it is what stops a typo'd role from
 * becoming a row no report groups correctly.
 */
export interface LlmCallRow {
  at: Date;
  /** Null for calls that precede or outlive a run row — the column has no FK. */
  runId: string | null;
  role: LlmCallLog["role"];
  variantId: string;
  driver: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Null when the driver reports no cache-hit ratio. */
  cachePct: number | null;
  /** Null for subscription drivers, which bill a seat rather than a call (M55). */
  usd: number | null;
  dataClass: LlmCallLog["dataClass"];
}

/**
 * Build the `onCallLog` hook.
 *
 * Fire-and-forget on purpose, and this is the one place where that is the right
 * call: the hook runs on the model-call path, and awaiting a reporting write
 * would put the cost ledger between an agent and its answer. A failed insert
 * costs a row in a spend report; a failed insert that also fails the run costs
 * the run.
 *
 * The failure is logged rather than swallowed. A silently missing row is how a
 * cost screen ends up quietly under-reporting a bank's spend.
 */
export function llmCallRecorder(
  delegate: LlmCallDelegate,
  onError: (message: string) => void = (message) => console.warn(message),
): (log: LlmCallLog) => void {
  return (log) => {
    void delegate
      .create({
        data: {
          at: new Date(log.at),
          runId: log.runId,
          role: log.role,
          variantId: log.variantId,
          driver: log.driver,
          model: log.model,
          tokensIn: log.tokensIn,
          tokensOut: log.tokensOut,
          cachePct: log.cachePct,
          usd: log.usd,
          dataClass: log.dataClass,
        },
      })
      .catch((error: unknown) => {
        onError(`[maestro] LlmCall kaydı yazılamadı (raporlama): ${String(error)}`);
      });
  };
}
