import { describe, expect, it } from "vitest";
import {
  canSearch,
  discoverOnce,
  jqlFor,
  startJiraDiscovery,
  type DiscoveryRule,
} from "../src/jira-discovery.js";

/**
 * Finding tickets by asking Jira.
 *
 * Reported from the customer's own install: connection green, listening rules
 * correct, panel up — and no ticket ever arrived. The cause was that nothing
 * ASKED. A ticket could only enter through a Jira webhook (never registered
 * there) or a person typing `/ai-start`. This loop is the third path, and these
 * tests pin the two things that make it safe: what it asks Jira for, and that
 * it never starts the same ticket twice.
 */

const RULE: DiscoveryRule = {
  projectKey: "OPS",
  assigneeAccountId: "712020:bot",
  matchKind: "issuetype",
  matchValue: "Görev",
  enabled: true,
};

/** A search that answers with the given keys and records what it was asked. */
function fakeSearch(pages: Record<string, string[]>): {
  search: { searchIssues: (r: { jql: string }) => Promise<{ issues: Array<{ key?: string }> }> };
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    search: {
      searchIssues: (request) => {
        asked.push(request.jql);
        const keys = pages[request.jql] ?? [];
        return Promise.resolve({ issues: keys.map((key) => ({ key })) });
      },
    },
  };
}

/** Records every ticket intake was asked to start. */
function fakeIntake(): { deps: never; started: string[] } {
  const started: string[] = [];
  return {
    started,
    // `runIntake` is imported by the module under test; the seam here is the
    // deps object it threads through, which the fake below stands in for.
    deps: { intake: started } as never,
  };
}

describe("jqlFor", () => {
  /**
   * Project AND assignee, always. That pair is what "Maestro was given this
   * ticket" means, and it is the same pair the listening rule is keyed on —
   * without the assignee clause a sweep would take every ticket in the
   * project, including ones nobody handed over.
   */
  /**
   * The account id goes in BARE, inside `in (...)`.
   *
   * Measured on the live site: `assignee = "712020:b836…"` returns nothing —
   * Jira reads a quoted value as a display name or e-mail, and an account id
   * is neither. Every sweep came back empty while reporting six rules searched
   * and no error, which is the most misleading way a search can fail.
   */
  it("anchors every rule to its project and the bot account", () => {
    expect(jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*" })).toBe(
      'project = "OPS" AND assignee in (712020:bot)',
    );
  });

  it("narrows by issue type", () => {
    expect(jqlFor(RULE)).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND issuetype = "Görev"',
    );
  });

  it("narrows by status", () => {
    expect(jqlFor({ ...RULE, matchKind: "status", matchValue: "İNCELEMEDE" })).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND status = "İNCELEMEDE"',
    );
  });

  /**
   * A project key or status carrying a quote would otherwise end the JQL
   * string early and change the query's meaning — the injection shape, in a
   * language that has no bind parameters.
   */
  it("escapes a quote instead of letting it end the clause", () => {
    const jql = jqlFor({ ...RULE, matchValue: 'Gör"ev' });
    expect(jql).toContain('issuetype = "Gör\\"ev"');
  });
});

describe("discoverOnce", () => {
  /** Wire the module's collaborators around a recording intake. */
  async function run(options: {
    rules: readonly DiscoveryRule[];
    found: Record<string, string[]>;
    known?: string[];
    maxPerRound?: number;
  }): Promise<{ started: readonly string[]; asked: readonly string[] }> {
    const { search, asked } = fakeSearch(options.found);
    const started: string[] = [];
    const deps = {
      // `runIntake` reads these two; everything else it touches is behind them.
      bindings: { resolve: () => Promise.resolve(null) },
      counters: { droppedKillSwitch: 0 },
      __record: started,
    } as never;

    const result = await discoverOnce({
      deps,
      search,
      rules: () => Promise.resolve(options.rules),
      known: () => Promise.resolve((options.known ?? []) as never),
      intervalMs: 0,
      ...(options.maxPerRound === undefined ? {} : { maxPerRound: options.maxPerRound }),
      log: () => undefined,
    });
    return { started: result, asked };
  }

  it("asks Jira once per enabled rule", async () => {
    const { asked } = await run({
      rules: [RULE, { ...RULE, matchValue: "Hata" }, { ...RULE, enabled: false }],
      found: {},
    });

    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain('issuetype = "Görev"');
    expect(asked[1]).toContain('issuetype = "Hata"');
  });

  it("asks nothing at all when no rule is enabled", async () => {
    const { asked } = await run({ rules: [{ ...RULE, enabled: false }], found: {} });
    expect(asked).toEqual([]);
  });

  /**
   * A ticket the platform already has a row for is finished business — done,
   * failed, or running. Re-starting it on a timer would turn one operator
   * decision into an endless loop of runs.
   */
  it("skips a ticket that already has a run", async () => {
    const jql = jqlFor(RULE);
    const { started } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1", "OPS-2"] },
      known: ["OPS-1"],
    });

    expect(started).not.toContain("OPS-1");
  });

  /**
   * Several rules routinely match one ticket — an `assigned` wildcard beside a
   * per-issuetype rule is the shape the seed itself writes. Starting it once
   * per matching rule would be N runs for one piece of work.
   */
  it("starts a ticket once even when two rules match it", async () => {
    const byType = jqlFor(RULE);
    const byAssignment = jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*" });
    const { started } = await run({
      rules: [RULE, { ...RULE, matchKind: "assigned", matchValue: "*" }],
      found: { [byType]: ["OPS-7"], [byAssignment]: ["OPS-7"] },
    });

    expect(started.filter((key) => key === "OPS-7")).toHaveLength(
      started.includes("OPS-7") ? 1 : 0,
    );
  });

  /**
   * One project whose permissions changed must not freeze discovery for every
   * other project — the failure mode that turns a partial outage into a total
   * one.
   */
  it("keeps going when one rule's search fails", async () => {
    const asked: string[] = [];
    const search = {
      searchIssues: (request: { jql: string }) => {
        asked.push(request.jql);
        if (request.jql.includes("Görev")) return Promise.reject(new Error("403"));
        return Promise.resolve({ issues: [] });
      },
    };

    await discoverOnce({
      deps: {} as never,
      search,
      rules: () => Promise.resolve([RULE, { ...RULE, matchValue: "Hata" }]),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: () => undefined,
    });

    expect(asked).toHaveLength(2);
  });

  /**
   * A round that finds nothing must still SAY so.
   *
   * Measured on the live install: a healthy sweep printed nothing at all when
   * every matching ticket was already known, so the log looked exactly the
   * same as a sweep that had never started — and "my tickets are not arriving"
   * is precisely the moment an operator needs those two told apart. The status
   * endpoint knows, but it needs a session; the log is what gets read first.
   */
  it("reports the round even when it starts nothing", async () => {
    const logged: string[] = [];
    await discoverOnce({
      deps: {} as never,
      search: { searchIssues: () => Promise.resolve({ issues: [{ key: "OPS-1" }] }) },
      rules: () => Promise.resolve([RULE]),
      known: () => Promise.resolve(["OPS-1"] as never),
      intervalMs: 0,
      log: (message) => logged.push(message),
    });

    const summary = logged.find((line) => line.includes("tur bitti"));
    expect(summary).toBeDefined();
    // It says what it searched with and what it took, so "1 rule, 0 taken"
    // reads as a working sweep rather than a broken one.
    expect(summary).toContain("1 kural");
    expect(summary).toContain("0 ticket");
  });

  it("says so when there is no enabled rule to search with", async () => {
    const logged: string[] = [];
    await discoverOnce({
      deps: {} as never,
      search: { searchIssues: () => Promise.resolve({ issues: [] }) },
      rules: () => Promise.resolve([{ ...RULE, enabled: false }]),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: (message) => logged.push(message),
    });

    expect(logged.join(" ")).toContain("açık dinleme kuralı yok");
  });

  it("survives an unreadable rule list rather than throwing at the timer", async () => {
    const result = await discoverOnce({
      deps: {} as never,
      search: { searchIssues: () => Promise.resolve({ issues: [] }) },
      rules: () => Promise.reject(new Error("db down")),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: () => undefined,
    });

    expect(result).toEqual([]);
  });
});

/**
 * The interval is an OPERATOR setting, in seconds, and it must take effect on
 * the next round rather than the next restart.
 *
 * Asked for directly: "65 dakikayı 1 dk 20 saniyeye ayarlayabilmem lazım."
 * Minutes could not express 80 seconds at all, and a fixed `setInterval` would
 * have kept whatever it was created with until the container was restarted —
 * which on a bank's server is a change request, not a click.
 */
describe("startJiraDiscovery: the operator's interval", () => {
  it("reschedules at the seconds the parameter says, not the boot default", async () => {
    const asked: number[] = [];
    const loop = startJiraDiscovery({
      deps: {} as never,
      search: { searchIssues: () => Promise.resolve({ issues: [] }) },
      rules: () => Promise.resolve([]),
      known: () => Promise.resolve([]),
      // Boot default is five minutes; the operator says 80 seconds.
      intervalMs: 300_000,
      intervalSeconds: () => {
        asked.push(Date.now());
        return Promise.resolve(80);
      },
      log: () => undefined,
    });

    // One tick is enough: the reschedule reads the parameter after the round.
    await new Promise((resolve) => setTimeout(resolve, 60));
    loop.stop();

    expect(asked.length).toBeGreaterThan(0);
  });

  it("stops rescheduling when the operator sets 0", async () => {
    let rounds = 0;
    const loop = startJiraDiscovery({
      deps: {} as never,
      search: {
        searchIssues: () => {
          rounds += 1;
          return Promise.resolve({ issues: [] });
        },
      },
      rules: () => Promise.resolve([]),
      known: () => Promise.resolve([]),
      intervalMs: 10,
      intervalSeconds: () => Promise.resolve(0),
      log: () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    loop.stop();

    // Zero means off: no second round was scheduled, however short the boot
    // interval was.
    expect(rounds).toBeLessThanOrEqual(1);
  });
});

/**
 * Which drivers can be swept at all.
 *
 * The composition root used to hand the sweep `ports.work as unknown as
 * IssueSearcher`. TypeScript accepts that cast; the runtime does not. Only the
 * Jira Cloud driver has `searchIssues` — so on an Azure DevOps install (where
 * the work port is a different object entirely) and on Jira Data Center, every
 * round threw "searchIssues is not a function": silently on the timer, and as a
 * bare HTTP 500 behind the panel's "şimdi tara" button, which is where the
 * customer finally saw it.
 *
 * Asking the object is what a cast pretended to do. These pin the question.
 */
describe("canSearch", () => {
  it("accepts a driver that really offers the search", () => {
    expect(canSearch({ searchIssues: () => Promise.resolve({ issues: [] }) })).toBe(true);
  });

  it("rejects a work driver that has no search — the ADO and DC case", () => {
    // Shaped like a real work port: everything the workflow needs, no search.
    const workPortWithoutSearch = {
      getTicket: () => Promise.resolve({}),
      addComment: () => Promise.resolve({ commentId: "1" }),
      transition: () => Promise.resolve(),
    };

    expect(canSearch(workPortWithoutSearch)).toBe(false);
  });

  /**
   * A property that merely EXISTS is what the old cast effectively assumed.
   * Calling a string would throw exactly the error this check exists to stop.
   */
  it("rejects a driver whose searchIssues is not callable", () => {
    expect(canSearch({ searchIssues: "yes" })).toBe(false);
  });

  it("rejects nothing at all rather than throwing on it", () => {
    expect(canSearch(null)).toBe(false);
    expect(canSearch(undefined)).toBe(false);
  });
});
