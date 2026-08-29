import { parseCommandFromComment } from "@maestro/adapter-jira";
import { handleCommand, projectKeyOf, type ResolvedDeps } from "@maestro/bff";
import type { TicketKey } from "@maestro/contracts";

/**
 * Reading Jira commands by polling, because the webhook cannot always reach us.
 *
 * `/approve`, `/reject <sebep>` and the rest arrive as ticket comments, and the
 * only path that reads them is `POST /webhooks/jira`. Two deployments cannot
 * use it: Jira Cloud's driver has no `verifyWebhook` at all
 * (`CapabilityNotSupportedError`), and a Data Center behind a firewall may not
 * be able to call in. Both then have a workflow engine that opens gates nobody
 * can close.
 *
 * The pilot solved this the same way and for the same reason
 * (`apps/pilot/src/poll.ts`). This is that loop, feeding the command handler
 * the platform already has rather than a second copy of its rules.
 *
 * It lives beside the BFF rather than inside the workflow: an activity may not
 * poll (Temporal replays it), and a workflow that slept between polls would
 * bill a timer per ticket per interval.
 */

/**
 * Reading comments is not on `WorkPort`.
 *
 * The port carries what the WORKFLOW needs — a ticket, a comment to post, a
 * transition — and reading a comment thread is not part of that: the engine is
 * signalled, it does not look. The Cloud and Data Center drivers both offer it
 * on their concrete types, and the pilot reaches it the same way
 * (`apps/pilot/src/poll.ts` takes a `JiraCloudWorkPort`).
 *
 * Asking for the one method rather than the whole driver keeps this loop
 * testable and says exactly how much of Jira it touches.
 */
export interface CommentReader {
  listComments(ticket: TicketKey): Promise<unknown[]>;
}

export interface PollerOptions {
  readonly deps: ResolvedDeps;
  /** The driver that can read a comment thread; see {@link CommentReader}. */
  readonly comments: CommentReader;
  /** Tickets to watch. Read fresh each round, so a new gate is picked up. */
  readonly openTickets: () => Promise<readonly TicketKey[]>;
  readonly intervalMs: number;
  readonly log?: (message: string) => void;
}

/**
 * Comments already answered.
 *
 * Keyed by author and timestamp, not by content: two people may write
 * `/approve` and the second one is a real second decision. Process-local by design — a restart
 * re-reads the window, and `decideGate` refuses a decision on a gate that is
 * already closed, so the worst case is a duplicate refusal in the log rather
 * than a duplicate approval.
 */
type Seen = Set<string>;

/**
 * Whether a work driver can read a comment thread at all.
 *
 * Same shape as the sweep's `canSearch`, and for the same reason: the
 * composition root used to cast `ports.work` to a comment reader with `as
 * unknown as`, which TypeScript accepts and the runtime does not.
 * `listComments` exists ONLY on the Jira Cloud driver — a Data Center install
 * has no such method, so every ticket threw once per interval and the error was
 * swallowed per-ticket. The visible effect is the one that matters in a bank:
 * `/approve` written on a ticket is never read, so an approval gate waits
 * forever and nobody can say why.
 */
export function canReadComments(
  driver: unknown,
): driver is { listComments(t: TicketKey): Promise<unknown[]> } {
  return (
    typeof driver === "object" &&
    driver !== null &&
    typeof (driver as { listComments?: unknown }).listComments === "function"
  );
}

export function startJiraPoller(options: PollerOptions): { stop: () => void } {
  const seen: Seen = new Set();
  const log = options.log ?? ((message: string) => console.log(message));
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let tickets: readonly TicketKey[] = [];
    try {
      tickets = await options.openTickets();
    } catch (error) {
      log(`[poller] açık ticket listesi okunamadı: ${String(error)}`);
      return;
    }
    for (const ticket of tickets) {
      if (stopped) return;
      try {
        await pollTicket(options.deps, options.comments, ticket, seen, log);
      } catch (error) {
        // One ticket's failure must not stop the others: a comment on a ticket
        // whose project was unbound mid-run would otherwise freeze every gate.
        log(`[poller] ${ticket}: ${String(error)}`);
      }
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  // Do not hold the process open for a reporting loop.
  timer.unref?.();
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function pollTicket(
  deps: ResolvedDeps,
  reader: CommentReader,
  ticket: TicketKey,
  seen: Seen,
  log: (m: string) => void,
): Promise<void> {
  const comments = await reader.listComments(ticket);
  for (const comment of comments) {
    const { envelope } = parseCommandFromComment(ticket, comment);
    if (envelope === null) continue;

    // Keyed by author AND timestamp: the comment id is not on the parsed
    // envelope, and two commands from one person at one instant is not a case
    // Jira produces. Content is deliberately not part of the key — a second
    // `/approve` from a second person is a second decision, not a repeat.
    const id = `${ticket}:${envelope.author}:${envelope.at}`;
    if (seen.has(id)) continue;
    seen.add(id);

    // The author is the Jira account that wrote the comment, which is exactly
    // what the gate's membership check needs — no mapping from a local login
    // to a directory identity, because the decision was made IN the directory.
    const outcome = await handleCommand(deps, envelope);
    log(`[poller] ${ticket} ${envelope.command.name} → ${JSON.stringify(outcome)}`);
  }
}

/** Project key of a ticket, re-exported so callers filter without a second parser. */
export { projectKeyOf };
