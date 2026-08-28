import { describe, expect, it } from "vitest";
import {
  JiraArgumentError,
  JiraCloudConfig,
  JiraCloudWorkPort,
  JiraResponseError,
  mergeTransitionGraph,
  normalizeIssueTransitions,
  normalizeProjectStatuses,
  type JiraWorkflowTransition,
} from "../../src/index.js";
import { fixture, stubFetch, type FetchStub } from "../helpers.js";

const config = JiraCloudConfig.parse({
  baseUrl: "https://uyildiz.atlassian.net",
  email: "pilot@bank.example",
  apiTokenRef: "kv/jira-cloud/token",
});

function port(stub: FetchStub): JiraCloudWorkPort {
  return new JiraCloudWorkPort({ config, token: () => "api-token-123", fetchImpl: stub.fetchImpl });
}

describe("normalizeProjectStatuses", () => {
  it("flattens issue-type groups into one de-duplicated status list with categories", () => {
    const statuses = normalizeProjectStatuses(fixture("cloud/project-statuses"));

    // OPS has four distinct statuses even though two issue types repeat them.
    expect(statuses.map((s) => s.name).sort()).toEqual(
      ["Devam Ediyor", "Tamam", "Yapılacaklar", "İNCELEMEDE"].sort(),
    );
    // The status-category NAME is carried through — the useful import label.
    const byName = new Map(statuses.map((s) => [s.name, s]));
    expect(byName.get("Yapılacaklar")?.category).toBe("Yapılacaklar");
    expect(byName.get("Devam Ediyor")?.category).toBe("Devam Ediyor");
    expect(byName.get("Tamam")?.category).toBe("Tamam");
  });

  it("de-duplicates a status shared across issue types to a single node", () => {
    const statuses = normalizeProjectStatuses(fixture("cloud/project-statuses"));
    // "Yapılacaklar" (id 10004) appears under both Görev and Hata → one node.
    expect(statuses.filter((s) => s.id === "10004")).toHaveLength(1);
  });

  it("returns an empty list when a project truly has no statuses (never invents one)", () => {
    expect(normalizeProjectStatuses([])).toEqual([]);
  });

  it("skips a status missing an id or a name rather than emitting a nameless node", () => {
    const statuses = normalizeProjectStatuses([
      { statuses: [{ id: "1", name: "Ok" }, { id: "2" }, { name: "Nameless" }] },
    ]);
    expect(statuses.map((s) => s.id)).toEqual(["1"]);
  });

  it("throws when the payload is not the expected array of issue-type groups", () => {
    expect(() => normalizeProjectStatuses({ statuses: [] })).toThrow(JiraResponseError);
  });

  it("tolerates an issue-type entry with no statuses array", () => {
    expect(normalizeProjectStatuses([{ id: "10008", name: "Görev" }])).toEqual([]);
  });
});

describe("normalizeIssueTransitions", () => {
  it("maps a per-status transition to a from→to edge rooted at the issue's status", () => {
    const edges = normalizeIssueTransitions(fixture("cloud/issue-transitions-todo"), "10004");
    const perStatus = edges.find((e) => e.name === "Devam Ediyor");
    expect(perStatus).toEqual({
      id: "11",
      name: "Devam Ediyor",
      fromStatusId: "10004",
      toStatusId: "10005",
    });
  });

  it("records an isGlobal transition as a null-rooted edge, not attributed to one status", () => {
    const edges = normalizeIssueTransitions(fixture("cloud/issue-transitions-todo"), "10004");
    const global = edges.find((e) => e.name === "Tamam");
    expect(global?.fromStatusId).toBeNull();
    expect(global?.toStatusId).toBe("10006");
  });

  it("carries a null fromStatusId through when the current status was unreadable", () => {
    const edges = normalizeIssueTransitions(fixture("cloud/issue-transitions-inprogress"), null);
    expect(edges.every((e) => e.fromStatusId === null)).toBe(true);
  });

  it("skips a transition with no target status id", () => {
    const edges = normalizeIssueTransitions(
      { transitions: [{ id: "9", name: "Broken", to: {} }, { id: "10", name: "Ok", to: { id: "10006" } }] },
      "10004",
    );
    expect(edges.map((e) => e.id)).toEqual(["10"]);
  });

  it("throws when the payload carries no transitions array", () => {
    expect(() => normalizeIssueTransitions({}, "10004")).toThrow(JiraResponseError);
  });
});

describe("mergeTransitionGraph", () => {
  it("de-duplicates identical edges observed from more than one sampled issue", () => {
    const edge: JiraWorkflowTransition = { id: "31", name: "Tamam", fromStatusId: null, toStatusId: "10006" };
    const merged = mergeTransitionGraph([[edge], [{ ...edge }]]);
    expect(merged).toHaveLength(1);
  });

  it("keeps the same transition id as distinct edges when rooted at different statuses", () => {
    const a: JiraWorkflowTransition = { id: "5", name: "Reddet", fromStatusId: "10005", toStatusId: "10004" };
    const b: JiraWorkflowTransition = { id: "5", name: "Reddet", fromStatusId: "10007", toStatusId: "10004" };
    expect(mergeTransitionGraph([[a], [b]])).toHaveLength(2);
  });
});

describe("JiraCloudWorkPort.readProjectWorkflow", () => {
  it("reads statuses, samples issue transitions, and returns the merged graph", async () => {
    const stub = stubFetch([
      { body: fixture("cloud/project-statuses") },
      { body: fixture("cloud/workflow-sample-search") },
      { body: fixture("cloud/issue-transitions-todo") },
      { body: fixture("cloud/issue-transitions-inprogress") },
    ]);

    const graph = await port(stub).readProjectWorkflow("OPS");

    expect(graph.projectKey).toBe("OPS");
    expect(graph.statuses.map((s) => s.id).sort()).toEqual(["10004", "10005", "10006", "10007"]);
    expect(graph.sampledFrom).toEqual(["OPS-6", "OPS-7"]);
    // Never claims completeness the issue-transitions API cannot give.
    expect(graph.edgesComplete).toBe(false);

    // OPS-6 sits in "Yapılacaklar" (10004): its per-status edge is rooted there.
    const started = graph.transitions.find((e) => e.id === "11");
    expect(started).toEqual({ id: "11", name: "Devam Ediyor", fromStatusId: "10004", toStatusId: "10005" });
    // The global "Tamam" transition appears once, null-rooted, despite both
    // sampled issues offering it.
    const done = graph.transitions.filter((e) => e.id === "31");
    expect(done).toHaveLength(1);
    expect(done[0]!.fromStatusId).toBeNull();
  });

  it("calls the right endpoints and never sends unbounded JQL", async () => {
    const stub = stubFetch([
      { body: fixture("cloud/project-statuses") },
      { body: fixture("cloud/workflow-sample-search") },
      { body: fixture("cloud/issue-transitions-todo") },
      { body: fixture("cloud/issue-transitions-inprogress") },
    ]);

    await port(stub).readProjectWorkflow("OPS", { sampleSize: 2 });

    expect(stub.calls[0]!.url).toContain("/rest/api/3/project/OPS/statuses");
    const searchUrl = new URL(stub.calls[1]!.url);
    expect(searchUrl.pathname).toBe("/rest/api/3/search/jql");
    expect(searchUrl.searchParams.get("jql")).toContain("project =");
    expect(searchUrl.searchParams.get("maxResults")).toBe("2");
    expect(stub.calls[2]!.url).toContain("/rest/api/3/issue/OPS-6/transitions");
    expect(stub.calls[3]!.url).toContain("/rest/api/3/issue/OPS-7/transitions");
  });

  it("rejects an empty project key before touching the network", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).readProjectWorkflow("   ")).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0);
  });

  it("returns the status nodes with no edges when the project has no sampleable issues", async () => {
    const stub = stubFetch([
      { body: fixture("cloud/project-statuses") },
      { body: { isLast: true, issues: [] } },
    ]);

    const graph = await port(stub).readProjectWorkflow("OPS");

    expect(graph.statuses).toHaveLength(4);
    expect(graph.transitions).toEqual([]);
    expect(graph.sampledFrom).toEqual([]);
  });

  it("drops an edge rooted at a status the project does not declare (no phantom node)", async () => {
    const stub = stubFetch([
      { body: fixture("cloud/project-statuses") },
      {
        body: {
          isLast: true,
          issues: [{ key: "OPS-9", fields: { status: { id: "99999", name: "Ghost" } } }],
        },
      },
      { body: fixture("cloud/issue-transitions-todo") },
    ]);

    const graph = await port(stub).readProjectWorkflow("OPS");
    // The issue's current status (99999) is unknown, so its per-status edge is
    // re-rooted to null rather than inventing a node no column maps to.
    const perStatus = graph.transitions.find((e) => e.id === "11");
    expect(perStatus?.fromStatusId).toBeNull();
  });
});
