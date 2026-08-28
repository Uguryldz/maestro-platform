import type { RetryPolicy } from "./config.js";
import type { Sleep } from "./deps.js";
import { NotifyDeliveryError, NotifyFanoutError, NotifyTransientError, type TargetFailure } from "./errors.js";

/**
 * Delivery guarantee (spec §7): a send failure is NEVER swallowed.
 *
 * - transient failure  → retried, at most `maxAttempts` times;
 * - permanent failure  → no retry, surfaced immediately;
 * - out of attempts    → surfaced.
 *
 * Every exit that is not success throws `NotifyDeliveryError`, so a caller
 * cannot mistake "gave up" for "sent". Retrying beyond a few attempts is
 * Temporal's job — this loop only absorbs a blip.
 */
export interface RetryContext {
  driver: string;
  event: string;
  policy: RetryPolicy;
  sleep: Sleep;
}

export async function sendWithRetry(ctx: RetryContext, attempt: () => Promise<void>): Promise<void> {
  const maxAttempts = Math.max(1, ctx.policy.maxAttempts);
  let lastError: unknown;

  for (let n = 1; n <= maxAttempts; n += 1) {
    try {
      await attempt();
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof NotifyTransientError) || n === maxAttempts) {
        throw new NotifyDeliveryError(ctx.driver, ctx.event, n, error);
      }
      await ctx.sleep(backoffMs(ctx.policy, n, error.retryAfterMs));
    }
  }

  /* c8 ignore next -- the loop always returns or throws; belt and braces. */
  throw new NotifyDeliveryError(ctx.driver, ctx.event, maxAttempts, lastError);
}

/**
 * Fan a notification out to several targets (webhook channels, ticket keys).
 *
 * Every target is attempted even when an earlier one failed — one dead webhook
 * must not silence the rest — and the failures are then reported together, so
 * a partial delivery is never mistaken for a full one.
 *
 * Repeated targets are collapsed first: `to: ["ops", "ops", "ops"]` (a Studio
 * copy-paste, or two routing rules naming the same channel) must post once, not
 * three times.
 */
export async function sendToEachTarget(
  ctx: RetryContext,
  targets: readonly string[],
  attempt: (target: string) => Promise<void>,
): Promise<void> {
  const unique = [...new Set(targets)];
  const failures: TargetFailure[] = [];
  for (const target of unique) {
    try {
      await sendWithRetry(ctx, () => attempt(target));
    } catch (error) {
      // `sendWithRetry` already reports how many attempts it made and keeps the
      // driver's own error as `cause`; both are carried over rather than
      // wrapped again, so `attempts` never silently becomes a target count.
      failures.push(
        error instanceof NotifyDeliveryError
          ? { target, attempts: error.attempts, cause: error.cause }
          : { target, attempts: 1, cause: error },
      );
    }
  }
  if (failures.length === 0) return;
  throw new NotifyFanoutError(ctx.driver, ctx.event, failures, unique.length);
}

/**
 * Exponential, capped, and deliberately without jitter: with at most a handful
 * of attempts the thundering-herd argument is weaker than being able to assert
 * exact delays in a test.
 */
export function backoffMs(policy: RetryPolicy, attempt: number, retryAfterMs?: number): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const wanted = retryAfterMs !== undefined && retryAfterMs > exponential ? retryAfterMs : exponential;
  return Math.min(wanted, policy.maxDelayMs);
}
