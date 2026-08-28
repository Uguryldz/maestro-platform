import { describe, expect, it } from "vitest";
import {
  PrismaOnboardingReader,
  PrismaRepoPolicyReader,
  runSampleDelegate,
  type ApplicationListRow,
  type BindingListRow,
  type RunSampleRow,
} from "../src/stores/read-onboarding.js";

/**
 * The Postgres-backed onboarding and repo-policy readers.
 *
 * The fakes below stand in for Prisma delegates and record the arguments they
 * were called with, because half of what these stores get right is the QUERY:
 * a dry run that filtered by the wrong prefix would sample another project's
 * tickets, and a policy reader that read any run rather than the newest would
 * show a stale deny-list.
 */

function bindings(rows: readonly BindingListRow[]) {
  return {
    findMany: (_args: { orderBy: { projectKey: "asc" }; take: number }) =>
      Promise.resolve([...rows]),
    findUnique: (args: { where: { projectKey: string } }) =>
      Promise.resolve(rows.find((row) => row.projectKey === args.where.projectKey) ?? null),
  };
}

function applications(rows: readonly ApplicationListRow[]) {
  return {
    findMany: (_args: { orderBy: { appId: "asc" }; take: number }) => Promise.resolve([...rows]),
    findUnique: (args: { where: { appId: string } }) =>
      Promise.resolve(rows.find((row) => row.appId === args.where.appId) ?? null),
  };
}

/** A `workflowRun.findMany` that applies the filters it is handed, and records them. */
function runs(rows: readonly RunSampleRow[]) {
  const queries: unknown[] = [];
  return {
    queries,
    delegate: runSampleDelegate({
      findMany: (args: unknown) => {
        queries.push(args);
        const where = (args as { where: { ticketKey?: { startsWith: string }; appId?: string } })
          .where;
        const take = (args as { take: number }).take;
        const matched = rows.filter((row) => {
          if (where.ticketKey !== undefined && !row.ticketKey.startsWith(where.ticketKey.startsWith)) {
            return false;
          }
          return where.appId === undefined || row.appId === where.appId;
        });
        return Promise.resolve(matched.slice(0, take));
      },
    }),
  };
}

const APPS: ApplicationListRow[] = [
  {
    appId: "ugurpay",
    adoProject: "Odeme",
    adoRepo: "ugurpay",
    platform: "linux-node",
    maestroYamlPresent: true,
  },
  {
    appId: "cards",
    adoProject: "Kart",
    adoRepo: "cards",
    platform: "linux-java",
    maestroYamlPresent: false,
  },
];

describe("PrismaOnboardingReader", () => {
  it("renders the ADO repo path and offers every platform profile the contract defines", async () => {
    const reader = new PrismaOnboardingReader(
      bindings([{ projectKey: "UGURPAY", state: "active" }]),
      applications(APPS),
      runs([]).delegate,
    );

    const options = await reader.options({ limit: 50, cursor: null });
    expect(options.repos).toEqual([
      { appId: "ugurpay", repo: "Odeme/_git/ugurpay", platform: "linux-node" },
      { appId: "cards", repo: "Kart/_git/cards", platform: "linux-java" },
    ]);
    // The whole contract enum, NOT just the profiles already in the registry:
    // deriving from existing apps made the first onboarding impossible (empty
    // registry → no profile → no app could ever be created).
    expect(options.platforms).toEqual([
      "linux-node",
      "linux-android",
      "macos-xcode",
      "windows-dotnet",
    ]);
    expect(options.projects).toEqual([{ projectKey: "UGURPAY", state: "active" }]);
  });

  it("keeps bound projects in the list, carrying their state", async () => {
    const reader = new PrismaOnboardingReader(
      bindings([
        { projectKey: "UGURPAY", state: "active" },
        { projectKey: "OLD", state: "unbound" },
      ]),
      applications(APPS),
      runs([]).delegate,
    );

    const options = await reader.options({ limit: 50, cursor: null });
    // Hiding a bound project would make "why is my project missing" an
    // unanswerable question; the state is what the route refuses on.
    expect(options.projects.map((p) => p.state)).toEqual(["active", "unbound"]);
  });

  it("samples by ticket prefix so a sibling project cannot leak in", async () => {
    const rowsFor = [
      row("UGURPAY-1", "ugurpay"),
      row("UGURPAYX-9", "cards"),
      row("UGURPAY-2", "ugurpay"),
    ];
    const runFake = runs(rowsFor);
    const reader = new PrismaOnboardingReader(bindings([]), applications(APPS), runFake.delegate);

    const samples = await reader.recentTickets("UGURPAY", 20);
    // `UGURPAYX-9` is a different project. The separator in the prefix is what
    // keeps it out.
    expect(samples.map((s) => s.ticketKey)).toEqual(["UGURPAY-1", "UGURPAY-2"]);
    expect(runFake.queries[0]).toMatchObject({
      where: { ticketKey: { startsWith: "UGURPAY-" } },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
  });

  it("honours the limit it is given", async () => {
    const runFake = runs([row("A-1", "ugurpay"), row("A-2", "ugurpay"), row("A-3", "ugurpay")]);
    const reader = new PrismaOnboardingReader(bindings([]), applications(APPS), runFake.delegate);

    expect(await reader.recentTickets("A", 2)).toHaveLength(2);
  });

  it("returns null for a project with no binding row", async () => {
    const reader = new PrismaOnboardingReader(bindings([]), applications(APPS), runs([]).delegate);
    expect(await reader.binding("NOPE")).toBeNull();
  });
});

describe("PrismaRepoPolicyReader", () => {
  it("assembles the policy from the newest run of the application", async () => {
    const runFake = runs([
      {
        ticketKey: "UGURPAY-1",
        appId: "ugurpay",
        matchJson: null,
        protectedPathsJson: ["src/payment-core/**"],
        verificationJson: [{ name: "lint", command: ["pnpm", "lint"] }],
        updatedAt: new Date("2026-08-08T10:00:00.000Z"),
      },
    ]);
    const reader = new PrismaRepoPolicyReader(applications(APPS), runFake.delegate);

    const record = await reader.get("ugurpay");
    expect(record).toMatchObject({
      appId: "ugurpay",
      repo: "Odeme/_git/ugurpay",
      yamlPresent: true,
      repoAdditions: ["src/payment-core/**"],
      observedAt: "2026-08-08T10:00:00.000Z",
    });
    expect(record?.verification).toEqual([{ name: "lint", command: ["pnpm", "lint"] }]);
    // Newest first, one row: a stale run must not supply the deny-list.
    expect(runFake.queries[0]).toMatchObject({ orderBy: { startedAt: "desc" }, take: 1 });
  });

  it("reports never-observed rather than an empty policy", async () => {
    const reader = new PrismaRepoPolicyReader(applications(APPS), runs([]).delegate);

    const record = await reader.get("cards");
    // `observedAt: null` is the field that separates "we looked and it was
    // empty" from "we never looked". The screen renders them differently.
    expect(record).toMatchObject({ observedAt: null, repoAdditions: [], verification: [] });
  });

  it("returns null for an application that is not in the registry", async () => {
    const reader = new PrismaRepoPolicyReader(applications(APPS), runs([]).delegate);
    expect(await reader.get("nosuchapp")).toBeNull();
  });

  it("drops a malformed deny-list whole rather than half of it", async () => {
    const runFake = runs([
      {
        ticketKey: "UGURPAY-1",
        appId: "ugurpay",
        matchJson: null,
        // One entry is not a string. A partial list would show the operator
        // fewer protections than the runner enforces.
        protectedPathsJson: ["src/a/**", 42],
        verificationJson: [{ name: "lint", command: ["pnpm", 7] }],
        updatedAt: new Date("2026-08-08T10:00:00.000Z"),
      },
    ]);
    const reader = new PrismaRepoPolicyReader(applications(APPS), runFake.delegate);

    const record = await reader.get("ugurpay");
    expect(record?.repoAdditions).toEqual([]);
    expect(record?.verification).toEqual([]);
  });
});

function row(ticketKey: string, appId: string): RunSampleRow {
  return {
    ticketKey,
    appId,
    matchJson: { via: "rule", ruleId: "r-1", appId },
    protectedPathsJson: null,
    verificationJson: null,
    updatedAt: new Date("2026-08-08T10:00:00.000Z"),
  };
}
