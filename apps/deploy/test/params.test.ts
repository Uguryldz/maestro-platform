import { DEFAULT_PARAM_DEFINITIONS } from "@maestro/db";
import { describe, expect, it } from "vitest";
import {
  InvalidParamError,
  MissingParamError,
  PrismaParamReader,
  projectOfTicket,
  type ParamScopeRefs,
  type ParamVersionDelegate,
  type ParamVersionRow,
  type RoutingRuleDelegate,
  type RoutingRuleRow,
} from "../src/stores/params.js";

/**
 * The parameter reader.
 *
 * The values under test are the SHIPPED defaults from
 * `DEFAULT_PARAM_DEFINITIONS` rather than fixtures invented here: M71 makes the
 * database the single source of truth, and a test that made up its own ladder
 * would pass while the real seeded value failed to parse.
 */
function definitionValue(key: string): unknown {
  const definition = DEFAULT_PARAM_DEFINITIONS.find((entry) => entry.key === key);
  if (definition === undefined) throw new Error(`no default parameter named ${key}`);
  return definition.defaultValue;
}

function fakeVersions(rows: ParamVersionRow[]): {
  delegate: ParamVersionDelegate;
  queries: unknown[];
} {
  const queries: unknown[] = [];
  return {
    queries,
    delegate: {
      findMany: (args) => {
        queries.push(args);
        // The database's job only: filter and order. Scope precedence is the
        // reader's, and is asserted separately.
        //
        // This sorts descending unconditionally, and that is safe for a
        // narrower reason than it looks: `ParamVersionDelegate` types
        // `orderBy.version` as the LITERAL `"desc"`, so a reader that asked
        // for `asc` — "the oldest parameter version wins", a silent downgrade
        // of every tuned limit to its first draft — does not compile. The
        // direction is pinned by the type, not by this sort, which is why the
        // sort does not need to branch on an argument that has one value.
        // Asserting the argument anyway keeps that reasoning checked here.
        expect(args.orderBy).toEqual({ version: "desc" });
        const candidates = rows
          .filter((row) => row.key === args.where.key)
          .filter((row) => args.where.scopeRef.in.includes(row.scopeRef));
        return Promise.resolve([...candidates].sort((a, b) => b.version - a.version));
      },
    },
  };
}

const noRules: RoutingRuleDelegate = { findMany: () => Promise.resolve([]) };
const scope = (over: Partial<ParamScopeRefs> = {}): (() => Promise<ParamScopeRefs>) => {
  const refs: ParamScopeRefs = { projectKey: "PAY", appId: "core-api", ...over };
  return () => Promise.resolve(refs);
};

describe("PrismaParamReader", () => {
  it("parses the shipped escalation ladder with the notify package's own schema", async () => {
    const versions = fakeVersions([
      { key: "escalation.ladder", scopeRef: "", version: 1, valueJson: definitionValue("escalation.ladder") },
    ]);
    const reader = new PrismaParamReader(versions.delegate, noRules, scope());

    const ladder = await reader.escalationLadder("run-1");
    expect(ladder.steps.map((step) => step.id)).toEqual([
      "reminder-24h",
      "escalation-72h",
      "delegate-7d",
    ]);
  });

  it("parses the shipped notify routing", async () => {
    const versions = fakeVersions([
      { key: "notify.routing", scopeRef: "", version: 1, valueJson: definitionValue("notify.routing") },
    ]);
    const reader = new PrismaParamReader(versions.delegate, noRules, scope());
    const routing = await reader.notifyRouting("run-1");
    expect(routing.default).toEqual(["teams"]);
    expect(routing.byEvent.gate_open).toEqual(["jira"]);
  });

  it("returns the publish targets for each document kind", async () => {
    const versions = fakeVersions([
      { key: "publish.targets", scopeRef: "", version: 1, valueJson: definitionValue("publish.targets") },
    ]);
    const reader = new PrismaParamReader(versions.delegate, noRules, scope());
    expect(await reader.publishTargets("run-1", "analysis")).toEqual(["jira"]);
    expect(await reader.publishTargets("run-1", "evidence_summary")).toEqual(["jira"]);
  });

  /**
   * M71: settings live in the database and this package holds no second copy.
   * A missing row is therefore a refusal, not a fallback — a compiled-in
   * default would win exactly when an operator most needs to be told.
   */
  it("refuses rather than falling back to a compiled-in default", async () => {
    const versions = fakeVersions([]);
    const reader = new PrismaParamReader(versions.delegate, noRules, scope());
    await expect(reader.escalationLadder("run-1")).rejects.toBeInstanceOf(MissingParamError);
  });

  it("refuses a stored value that does not parse, naming the problem", async () => {
    const versions = fakeVersions([
      { key: "escalation.ladder", scopeRef: "", version: 1, valueJson: { steps: [] } },
    ]);
    const reader = new PrismaParamReader(versions.delegate, noRules, scope());
    await expect(reader.escalationLadder("run-1")).rejects.toBeInstanceOf(InvalidParamError);
  });

  it("prefers an application override over the project and global rows", async () => {
    const global = definitionValue("publish.targets") as Record<string, string[]>;
    const versions = fakeVersions([
      { key: "publish.targets", scopeRef: "", version: 1, valueJson: global },
      {
        key: "publish.targets",
        scopeRef: "PAY",
        version: 1,
        valueJson: { ...global, analysis: ["confluence"] },
      },
      {
        key: "publish.targets",
        scopeRef: "core-api",
        version: 1,
        valueJson: { ...global, analysis: ["repo_docs"] },
      },
    ]);
    const reader = new PrismaParamReader(versions.delegate, noRules, scope());
    expect(await reader.publishTargets("run-1", "analysis")).toEqual(["repo_docs"]);
  });

  /**
   * The scope precedence must not be alphabetical. `"PAY"` sorts ABOVE
   * `"core-api"` (uppercase precedes lowercase), so a `scopeRef DESC` in the
   * query would hand the project row the win over the application override
   * that was meant to have it — and only for the app/project name pairs that
   * happen to sort that way, which is what makes it hard to notice.
   */
  it("prefers the application scope even when the project key sorts above it", async () => {
    const global = definitionValue("publish.targets") as Record<string, string[]>;
    const versions = fakeVersions([
      { key: "publish.targets", scopeRef: "", version: 1, valueJson: global },
      {
        key: "publish.targets",
        scopeRef: "PAY",
        version: 9,
        valueJson: { ...global, analysis: ["project-row"] },
      },
      {
        key: "publish.targets",
        scopeRef: "core-api",
        version: 1,
        valueJson: { ...global, analysis: ["application-row"] },
      },
    ]);
    const reader = new PrismaParamReader(versions.delegate, noRules, scope());
    expect(await reader.publishTargets("run-1", "analysis")).toEqual(["application-row"]);
  });

  it("falls back to the project row when the application has no override", async () => {
    const global = definitionValue("publish.targets") as Record<string, string[]>;
    const versions = fakeVersions([
      { key: "publish.targets", scopeRef: "", version: 1, valueJson: global },
      {
        key: "publish.targets",
        scopeRef: "PAY",
        version: 1,
        valueJson: { ...global, analysis: ["project-row"] },
      },
    ]);
    const reader = new PrismaParamReader(versions.delegate, noRules, scope());
    expect(await reader.publishTargets("run-1", "analysis")).toEqual(["project-row"]);
  });

  it("takes the newest version within the winning scope", async () => {
    const global = definitionValue("publish.targets") as Record<string, string[]>;
    const versions = fakeVersions([
      { key: "publish.targets", scopeRef: "", version: 1, valueJson: global },
      { key: "publish.targets", scopeRef: "", version: 2, valueJson: { ...global, analysis: ["v2"] } },
    ]);
    const reader = new PrismaParamReader(versions.delegate, noRules, scope({ appId: null }));
    expect(await reader.publishTargets("run-1", "analysis")).toEqual(["v2"]);
  });

  it("does not ask for an application scope when the run has no application", async () => {
    const versions = fakeVersions([
      { key: "notify.routing", scopeRef: "", version: 1, valueJson: definitionValue("notify.routing") },
    ]);
    const reader = new PrismaParamReader(versions.delegate, noRules, scope({ appId: null }));
    await reader.notifyRouting("run-1");
    expect(versions.queries[0]).toMatchObject({ where: { scopeRef: { in: ["", "PAY"] } } });
  });
});

describe("PrismaParamReader.routingRules", () => {
  const rules: RoutingRuleRow[] = [
    {
      ruleId: "org-guard",
      projectKey: null,
      conditionJson: { field: "labels", op: "contains", value: "maestro" },
      effectJson: { mode: "ai_assist" },
      priority: 10,
    },
    {
      ruleId: "pay-rule",
      projectKey: "PAY",
      conditionJson: { field: "component", op: "equals", value: "payments" },
      effectJson: { appId: "core-api" },
      priority: 5,
    },
  ];

  /**
   * The org-wide rules are stored as NULL, and `IN (NULL)` is never true in
   * SQL — so an `in` filter would have silently dropped every org-wide rule
   * from every routing decision. The predicate has to be an OR.
   */
  it("asks for the ticket's project AND the org-wide (NULL) rules", async () => {
    const seen: unknown[] = [];
    const delegate: RoutingRuleDelegate = {
      findMany: (args) => {
        seen.push(args);
        return Promise.resolve(rules);
      },
    };
    const reader = new PrismaParamReader(fakeVersions([]).delegate, delegate, scope());
    await reader.routingRules("PAY-101");
    expect(seen[0]).toMatchObject({
      where: { OR: [{ projectKey: "PAY" }, { projectKey: null }] },
    });
  });

  it("spells a stored NULL as the contract's org-wide marker", async () => {
    const delegate: RoutingRuleDelegate = { findMany: () => Promise.resolve(rules) };
    const reader = new PrismaParamReader(fakeVersions([]).delegate, delegate, scope());
    const result = await reader.routingRules("PAY-101");
    expect(result.find((rule) => rule.ruleId === "org-guard")?.projectKey).toBe("*");
    expect(result.find((rule) => rule.ruleId === "pay-rule")?.projectKey).toBe("PAY");
  });

  it("orders by priority and then by id, so the result is reproducible", async () => {
    const delegate: RoutingRuleDelegate = { findMany: () => Promise.resolve(rules) };
    const reader = new PrismaParamReader(fakeVersions([]).delegate, delegate, scope());
    const seen: unknown[] = [];
    const spy: RoutingRuleDelegate = {
      findMany: (args) => {
        seen.push(args.orderBy);
        return delegate.findMany(args);
      },
    };
    await new PrismaParamReader(fakeVersions([]).delegate, spy, scope()).routingRules("PAY-101");
    expect(seen[0]).toEqual([{ priority: "asc" }, { ruleId: "asc" }]);
    expect(await reader.routingRules("PAY-101")).toHaveLength(2);
  });
});

describe("projectOfTicket", () => {
  it("takes the project key from the ticket's own prefix", () => {
    expect(projectOfTicket("PAY-101")).toBe("PAY");
    expect(projectOfTicket("CORE-API-7")).toBe("CORE-API");
    expect(projectOfTicket("NODASH")).toBe("NODASH");
  });
});
