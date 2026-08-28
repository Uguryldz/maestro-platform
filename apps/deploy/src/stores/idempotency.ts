import type { IdempotencyGuard } from "@maestro/workflows";

/**
 * Table-backed `IdempotencyGuard` (M33).
 *
 * `InMemoryIdempotency` is correct for exactly one worker process. The moment a
 * second one joins the task queue, two workers retrying the same activity each
 * believe they are the first: the ticket gets two Jira comments and the audit
 * chain gets two records claiming the same predecessor. This guard makes the
 * memory a row, so it is shared by every worker and survives a restart.
 *
 * The protocol is three steps and the ORDER is the whole correctness argument:
 *
 *   1. CLAIM   `INSERT ... ON CONFLICT DO NOTHING`. Exactly one caller inserts.
 *              The claim is written BEFORE the effect runs — a claim taken
 *              after would leave a window in which both callers see no row.
 *   2. RUN     Only the winner runs `fn`, then writes the result and flips the
 *              row to `done` in one UPDATE.
 *   3. REPLAY  Every loser polls that row until it is `done` and returns the
 *              winner's result. It never runs `fn`.
 *
 * `SELECT ... FOR UPDATE` would be the other way to write step 3, and it is
 * the wrong one here: the effect is a network call to Jira or ADO that can take
 * a minute, and holding a row lock across it means a database connection held
 * for the same minute, times every retry. Polling costs a query a second and
 * holds nothing.
 */

/** The claim as stored. `resultJson` is `undefined`-safe — see `encode`. */
export interface IdempotencyRow {
  key: string;
  state: string;
  resultJson: unknown;
  completedAt: Date | null;
}

export interface IdempotencyDelegate {
  findUnique(args: { where: { key: string } }): Promise<IdempotencyRow | null>;
  update(args: {
    where: { key: string };
    /**
     * `resultJson` is the envelope `encode` builds — an object, not `unknown`.
     * Prisma's JSON input type cannot accept `unknown` (it demands a
     * recursively-serialisable type), and declaring the envelope here is what
     * keeps the delegate assignable from the real client without a cast.
     */
    data: { state: string; resultJson: object; completedAt: Date };
  }): Promise<unknown>;
  delete(args: { where: { key: string } }): Promise<unknown>;
}

/**
 * `INSERT ... ON CONFLICT DO NOTHING` — the atomic claim.
 *
 * Prisma's `create` throws P2002 on conflict, which works but makes the happy
 * path of a retry an exception, and makes "did I win?" a question about an
 * error code. The raw statement answers it with a row count instead, which is
 * what the protocol actually asks.
 */
export interface ClaimExecutor {
  /** True if THIS caller inserted the row; false if it already existed. */
  claim(key: string, at: Date): Promise<boolean>;
}

export class IdempotencyTimeoutError extends Error {
  constructor(key: string, ms: number) {
    // The key is a caller-built identifier (`decision:5:81390`), not a secret,
    // and it is the only thing that makes this message actionable.
    super(`idempotency: timed out after ${ms}ms waiting for another worker to finish ${key}`);
    this.name = "IdempotencyTimeoutError";
  }
}

export interface PrismaIdempotencyOptions {
  /** How long a loser waits for the winner before giving up. */
  readonly waitTimeoutMs?: number;
  /** Poll interval while waiting. */
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
  /** Injected so the tests do not sleep in real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Ten minutes, matched to the activity timeouts an effect can legitimately
 * take (an engineering turn's push, an ADO PR creation under retry). Shorter
 * and a slow-but-healthy winner gets abandoned, and the waiter would run the
 * effect a second time — the exact thing this class exists to prevent.
 */
const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export class PrismaIdempotencyGuard implements IdempotencyGuard {
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly keys: IdempotencyDelegate,
    private readonly claims: ClaimExecutor,
    options: PrismaIdempotencyOptions = {},
  ) {
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? ((): Date => new Date());
    this.sleep = options.sleep ?? ((ms): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  }

  async once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Fast path: a key that finished long ago is one SELECT, no INSERT.
    const existing = await this.keys.findUnique({ where: { key } });
    if (existing !== null && existing.state === "done") return decode<T>(existing.resultJson);

    const won = await this.claims.claim(key, this.now());
    if (!won) return this.awaitResult<T>(key);

    let value: T;
    try {
      value = await fn();
    } catch (error) {
      /**
       * A failure is NOT remembered — the same rule the in-memory guard
       * follows, and for the same reason: the guard exists to make a RETRY
       * safe, and a remembered failure would make the effect permanently
       * unrunnable. The claim is released so the next attempt can take it.
       *
       * If the release itself fails the original error still wins: the caller
       * needs to know why the effect failed, not why the cleanup did. The
       * stale `running` row is recoverable (the retention sweep, or the
       * timeout above), a swallowed root cause is not.
       */
      await this.keys.delete({ where: { key } }).catch(() => undefined);
      throw error;
    }

    await this.keys.update({
      where: { key },
      data: { state: "done", resultJson: encode(value), completedAt: this.now() },
    });
    return value;
  }

  /**
   * Wait for the winner. Gives up rather than running the effect: after ten
   * minutes we still do not know whether the other worker posted the comment,
   * and "probably not" is not a basis for posting a second one to a bank's
   * ticket. Temporal will retry the activity, and the retry re-reads the row —
   * by which time the winner has either finished or released its claim.
   */
  private async awaitResult<T>(key: string): Promise<T> {
    const deadline = this.now().getTime() + this.waitTimeoutMs;
    for (;;) {
      const row = await this.keys.findUnique({ where: { key } });
      // The winner failed and released its claim; this caller may now try.
      if (row === null) return this.retryAfterRelease<T>(key);
      if (row.state === "done") return decode<T>(row.resultJson);
      if (this.now().getTime() >= deadline) {
        throw new IdempotencyTimeoutError(key, this.waitTimeoutMs);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * The released-claim path, split out so it cannot recurse indefinitely: it
   * makes exactly one more attempt at the claim, and a caller that loses THAT
   * race goes back to waiting rather than starting a third round.
   */
  private async retryAfterRelease<T>(key: string): Promise<T> {
    const won = await this.claims.claim(key, this.now());
    if (!won) return this.awaitResult<T>(key);
    // Undo the claim: `once` is the only place allowed to run `fn`, and this
    // method has no `fn`. Releasing lets the caller's own retry take it.
    await this.keys.delete({ where: { key } }).catch(() => undefined);
    throw new Error(
      `idempotency: the worker holding ${key} released it without a result; retry the activity`,
    );
  }
}

/**
 * `undefined` is not JSON, and plenty of effects return it (a notification, a
 * label update). Storing it as SQL NULL and reading it back would be
 * indistinguishable from an effect that returned `null`, and the column's own
 * NULL already means "no result yet" — three different things collapsing onto
 * one value.
 *
 * So the envelope records the ABSENCE rather than substituting a value: an
 * `undefined` result is `{}` (no `v` key at all) and a `null` result is
 * `{ v: null }`. JSON keeps those apart, and `decode` reads the difference
 * back. Substituting `null` for `undefined` here — the obvious shortcut —
 * would make `once` return `null` where the effect returned `undefined`, which
 * is a different value reaching a caller that already committed to the first.
 */
export function encode(value: unknown): { v?: unknown } {
  return value === undefined ? {} : { v: value };
}

export function decode<T>(stored: unknown): T {
  if (typeof stored === "object" && stored !== null) {
    // No `v` key: the effect returned `undefined`, and that is a real result.
    if (!("v" in stored)) return undefined as T;
    return (stored as { v: unknown }).v as T;
  }
  // A `done` row whose result does not carry the envelope was written by
  // something other than `encode`. Returning it raw would hand the caller a
  // shape it never produced; refusing names the row instead.
  throw new Error("idempotency: stored result is not in the expected envelope");
}

/**
 * The claim statement, bound to a `SqlExecutor`.
 *
 * `$1`/`$2` are parameters, so the key never reaches the SQL text. The
 * statement returns a row only when it inserted one, which is exactly the
 * "did I win" answer the protocol needs.
 */
export function sqlClaimExecutor(sql: {
  query<R>(text: string, params: readonly unknown[]): Promise<R[]>;
}): ClaimExecutor {
  return {
    async claim(key: string, at: Date): Promise<boolean> {
      const rows = await sql.query<{ key: string }>(
        `INSERT INTO "IdempotencyKey" ("key", "state", "resultJson", "claimedAt", "completedAt")
         VALUES ($1, 'running', NULL, $2, NULL)
         ON CONFLICT ("key") DO NOTHING
         RETURNING "key"`,
        [key, at],
      );
      return rows.length > 0;
    },
  };
}
