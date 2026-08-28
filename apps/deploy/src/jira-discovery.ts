import { type ResolvedDeps, runIntake } from "@maestro/bff";
import type { TicketKey } from "@maestro/contracts";

/**
 * Finding tickets by ASKING Jira, instead of waiting to be told.
 *
 * Until this existed a ticket could reach the platform by exactly two paths: a
 * Jira webhook, or a person typing `/ai-start`. Both are things somebody else
 * has to set up first — and when neither is in place the product looks broken
 * in the most confusing way possible: the panel is up, the connection tests
 * green, the rules are right, and no ticket ever appears. Measured on the
 * customer's own install, where the BFF had logged zero webhook deliveries
 * since the day it was built.
 *
 * A webhook is still the better path when it exists: it is instant and it costs
 * no polling. This is the path for everyone else — a Jira Cloud site whose
 * signature cannot be verified, a Data Center behind a firewall that cannot
 * call in, or an operator who simply has no admin rights on the Jira instance.
 *
 * It lives beside the BFF rather than inside the workflow for the reason the
 * comment poller gives: an activity may not poll (Temporal replays it), and a
 * workflow that slept between polls would bill a timer per ticket per interval.
 */

/**
 * Reading a search is not on `WorkPort`.
 *
 * The port carries what the WORKFLOW needs — a ticket, a comment, a transition
 * — and searching is not part of that: the engine is told which ticket to run,
 * it does not go looking. The Cloud driver offers it on its concrete type
 * (`searchIssues`), so asking for the one method keeps this loop testable and
 * states exactly how much of Jira it touches.
 */
export interface IssueSearcher {
  searchIssues(request: {
    jql: string;
    maxResults?: number;
    fields?: string[];
  }): Promise<{ issues: Array<{ key?: string }> }>;
}

/** One listening rule, as much of it as discovery needs. */
export interface DiscoveryRule {
  readonly projectKey: string;
  readonly assigneeAccountId: string;
  readonly matchKind: "status" | "issuetype" | "assigned";
  readonly matchValue: string;
  readonly enabled: boolean;
}

export interface DiscoveryOptions {
  readonly deps: ResolvedDeps;
  /** The driver that can run a JQL search; see {@link IssueSearcher}. */
  readonly search: IssueSearcher;
  /** The listening rules, re-read each round so a new rule is picked up. */
  readonly rules: () => Promise<readonly DiscoveryRule[]>;
  /** Ticket keys the platform already knows about — never started twice. */
  readonly known: () => Promise<readonly TicketKey[]>;
  readonly intervalMs: number;
  /**
   * The interval as the OPERATOR set it, in SECONDS, re-read each tick.
   *
   * `intervalMs` is the boot-time default from the environment; this is the
   * live value from `jira.discover_minutes`. Read per round rather than at
   * start-up so tightening it in the panel takes effect on the next sweep
   * instead of the next restart — which on a bank's server is a change
   * request, not a click.
   *
   * Absent (or a read that fails) means "use the boot default": a parameter
   * store that is briefly unavailable must not stop the sweep.
   *
   * Seconds, not minutes: an operator who wants 80s must be able to say 80.
   */
  readonly intervalSeconds?: () => Promise<number | null>;
  /** Most tickets to take from one search. A guard, not a page size. */
  readonly maxPerRound?: number;
  readonly log?: (message: string) => void;
}

/**
 * What the last discovery round did — the panel's answer to "is this working?".
 *
 * An operator whose tickets are not arriving has no way to tell the difference
 * between "the sweep is off", "the sweep runs and finds nothing", and "the
 * sweep is failing" — and those three need three different fixes. The loop
 * knows; this is where it says so.
 *
 * Process-local on purpose: it describes THIS process's loop, and a second
 * replica's rounds are not this one's to report.
 */
export interface DiscoveryStatus {
  /** Whether a sweep is configured at all. */
  readonly enabled: boolean;
  readonly intervalMs: number;
  /** ISO timestamp of the last completed round; null before the first. */
  readonly lastRunAt: string | null;
  /** Tickets taken in the last round. */
  readonly lastStarted: number;
  /** Rules the last round searched with — zero means nothing to look for. */
  readonly rulesSearched: number;
  /** The last round's failure, if it had one. */
  readonly lastError: string | null;
}

const status: { current: DiscoveryStatus } = {
  current: {
    enabled: false,
    intervalMs: 0,
    lastRunAt: null,
    lastStarted: 0,
    rulesSearched: 0,
    lastError: null,
  },
};

/** The last round's outcome, for the Studio screen. */
export function discoveryStatus(): DiscoveryStatus {
  return status.current;
}

/** How many tickets one round may start, unless the caller says otherwise. */
const DEFAULT_MAX_PER_ROUND = 20;

/**
 * The JQL a rule matches with.
 *
 * Every rule is anchored to its project AND to the bot's account, because that
 * pair is what "Maestro was given this ticket" means — the same pair the rule
 * itself is keyed on. Without the assignee clause a search would sweep up every
 * ticket in the project, including ones nobody meant to hand over.
 *
 * `assigned` is the wildcard rule: assignment alone is the trigger, so it adds
 * no third clause. The other two narrow it by status or issue type.
 */
export function jqlFor(rule: DiscoveryRule): string {
  const quoted = (value: string): string => `"${value.replace(/"/gu, '\\"')}"`;
  /**
   * The assignee is matched as an ACCOUNT ID, not as a quoted name.
   *
   * Measured against the live site: `assignee = "712020:b836…"` returns
   * nothing. Jira Cloud reads a quoted value as a display name or e-mail and
   * an account id is neither, so every sweep came back empty while the panel
   * reported six rules searched and zero tickets taken — the most misleading
   * shape a failure can have, because nothing errors.
   *
   * The documented form for an id is bare, and Jira's own docs recommend
   * `assignee in (id)` for account ids specifically.
   */
  const base = `project = ${quoted(rule.projectKey)} AND assignee in (${rule.assigneeAccountId.replace(/[^A-Za-z0-9:._-]/gu, "")})`;
  if (rule.matchKind === "status") return `${base} AND status = ${quoted(rule.matchValue)}`;
  if (rule.matchKind === "issuetype") return `${base} AND issuetype = ${quoted(rule.matchValue)}`;
  return base;
}

/**
 * One discovery round: ask Jira what it has, start what is new.
 *
 * Returns the keys it started, so a caller (and the tests) can see the round's
 * effect without reading the log.
 */
export async function discoverOnce(options: DiscoveryOptions): Promise<readonly TicketKey[]> {
  const log = options.log ?? ((message: string): void => console.log(message));
  const cap = options.maxPerRound ?? DEFAULT_MAX_PER_ROUND;

  let rules: readonly DiscoveryRule[];
  try {
    rules = (await options.rules()).filter((rule) => rule.enabled);
  } catch (error) {
    log(`[keşif] dinleme kuralları okunamadı: ${String(error)}`);
    record({ lastError: String(error), rulesSearched: 0, lastStarted: 0 });
    return [];
  }
  if (rules.length === 0) {
    // Zero rules is a real, reportable state — not a failure. The panel says
    // "nothing to look for" rather than leaving the operator to guess, and so
    // does the log: silence here would read as a sweep that is not running.
    log("[keşif] tur bitti: açık dinleme kuralı yok, aranacak bir şey yok");
    record({ lastError: null, rulesSearched: 0, lastStarted: 0 });
    return [];
  }

  const known = new Set<string>(await options.known().catch(() => []));
  const started: TicketKey[] = [];
  // Deduped across rules: several rules routinely match one ticket (an
  // `assigned` wildcard beside a per-issuetype rule), and starting it twice
  // would be two runs for one piece of work.
  const seenThisRound = new Set<string>();
  /** Keys Jira returned this round, before the already-known filter. */
  let scanned = 0;

  for (const rule of rules) {
    if (started.length >= cap) break;
    let keys: string[];
    try {
      const page = await options.search.searchIssues({
        jql: jqlFor(rule),
        maxResults: cap,
        // The key is all this needs; asking for fields would pull ticket text
        // through a path that has no business holding it.
        fields: ["key"],
      });
      keys = page.issues.map((issue) => issue.key).filter((key): key is string => key !== undefined);
      scanned += keys.length;
    } catch (error) {
      // One rule's failure must not stop the others: a project whose
      // permissions changed would otherwise freeze discovery for every project.
      log(`[keşif] ${rule.projectKey}/${rule.matchValue}: ${String(error)}`);
      continue;
    }

    for (const key of keys) {
      if (started.length >= cap) break;
      if (known.has(key) || seenThisRound.has(key)) continue;
      seenThisRound.add(key);

      /**
       * `explicit: true` — the rule IS the human decision.
       *
       * An operator wrote a listening rule saying "tickets assigned to the bot
       * in this project, of this type, are ours". Making the ticket ALSO carry
       * an opt-in label would be asking the same question twice, and the second
       * asking is the one nobody remembers to answer.
       */
      const outcome = await runIntake(options.deps, {
        ticket: key as TicketKey,
        actor: "maestro-worker",
        explicit: true,
      }).catch((error: unknown) => ({ accepted: false as const, reason: String(error) }));

      if (outcome.accepted) {
        started.push(key as TicketKey);
        log(`[keşif] ${key} alındı (${rule.projectKey}/${rule.matchKind}=${rule.matchValue})`);
      } else {
        // Not an error: a refusal is usually a kill switch or a project whose
        // binding was paused, and both are states an operator chose.
        log(`[keşif] ${key} alınmadı: ${outcome.reason}`);
      }
    }
  }
  /**
   * Every round says what it did, including the empty ones.
   *
   * Measured on the live install: a healthy sweep that found nothing printed
   * NOTHING, so "the sweep is running and there is no new ticket" and "the
   * sweep never ran" looked identical in the log — and the operator whose
   * tickets are not arriving cannot tell those two apart, which is the whole
   * question they are asking. The status endpoint knows, but it needs a
   * session; the log is what an operator reads first.
   */
  log(
    `[keşif] tur bitti: ${rules.length} kural arandı, ${started.length} ticket alındı` +
      `${scanned === 0 ? "" : `, ${scanned} eşleşme görüldü`}`,
  );
  record({ lastError: null, rulesSearched: rules.length, lastStarted: started.length });
  return started;
}

/** Stamp the round's outcome onto the status the panel reads. */
function record(round: Pick<DiscoveryStatus, "lastError" | "rulesSearched" | "lastStarted">): void {
  status.current = {
    ...status.current,
    ...round,
    lastRunAt: new Date().toISOString(),
  };
}

/**
 * Poll Jira for new tickets until stopped.
 *
 * Off unless the caller passes an interval, the same way the comment poller is:
 * an installation whose webhook works does not need this, and two paths
 * starting the same ticket is the one outcome worth avoiding. `runIntake`
 * itself is idempotent per ticket, so an overlap is safe — but paying for it
 * every round is not.
 */
export function startJiraDiscovery(options: DiscoveryOptions): { stop: () => void } {
  status.current = { ...status.current, enabled: true, intervalMs: options.intervalMs };
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    await discoverOnce(options).catch((error: unknown) => {
      (options.log ?? console.log)(`[keşif] tur başarısız: ${String(error)}`);
      return [];
    });
  };
  /**
   * Rescheduled after every round rather than a fixed `setInterval`, because
   * the operator can change the interval while it runs. A fixed timer would
   * keep the interval it was created with until the process restarted.
   */
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (ms: number): void => {
    timer = setTimeout(() => void loop(), ms);
    timer.unref?.();
  };
  const loop = async (): Promise<void> => {
    if (stopped) return;
    await tick();
    if (stopped) return;
    let ms = options.intervalMs;
    try {
      const seconds = await options.intervalSeconds?.();
      // 0 means "off": stop rescheduling rather than spinning on a zero delay.
      if (seconds !== null && seconds !== undefined) {
        if (seconds <= 0) {
          (options.log ?? console.log)("[keşif] tarama panelden kapatıldı");
          status.current = { ...status.current, enabled: false };
          return;
        }
        ms = seconds * 1_000;
        status.current = { ...status.current, enabled: true, intervalMs: ms };
      }
    } catch {
      // A parameter store that is briefly down must not stop the sweep.
    }
    schedule(ms);
  };
  void loop();
  return {
    stop: (): void => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
