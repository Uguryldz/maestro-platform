import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { auth, harness, TEST_WORKFLOW_GRAPH, type Harness } from "./helpers.js";
import type { JiraWorkflowGraphView } from "../src/jira-workflow-model.js";

/**
 * The workflow-import surface (M102): a Jira project's live statuses and the
 * transitions between them, read for Studio to map onto Maestro's steps.
 *
 * The behaviour under test: the graph is admin-only, it carries the honesty
 * flags (`edgesComplete: false`, `sampledFrom`) so the screen cannot imply a
 * completeness the issue-transitions API never gives, and an unwired reader
 * refuses BY NAME rather than answering an empty graph that would render as
 * "this project has no workflow".
 */

async function admin(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  return h.login("ayse.kaya");
}

async function techLead(h: Harness): Promise<string> {
  await h.addUser({ username: "mehmet.demir", roles: ["tech-lead"] });
  return h.login("mehmet.demir");
}

async function developer(h: Harness): Promise<string> {
  await h.addUser({ username: "can.yilmaz", roles: ["developer"] });
  return h.login("can.yilmaz");
}

function get(h: Harness, url: string, token: string): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "GET", url, headers: auth(token) });
}

describe("GET /studio/jira-workflow", () => {
  it("returns the project's status nodes and observed transition edges", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await get(h, "/studio/jira-workflow?project=OPS", token);

    expect(response.statusCode).toBe(200);
    const body = response.json() as JiraWorkflowGraphView;
    expect(body.projectKey).toBe("OPS");
    expect(body.statuses.map((s) => s.name)).toEqual([
      "Yapılacaklar",
      "Devam Ediyor",
      "İNCELEMEDE",
      "Tamam",
    ]);
    // The lifecycle category rides along — the useful label for an import screen.
    expect(body.statuses.find((s) => s.name === "Tamam")?.category).toBe("Tamam");
    expect(body.transitions.map((t) => t.id).sort()).toEqual(["11", "21", "31"]);
  });

  it("carries the honesty flags so the screen cannot imply a complete scheme", async () => {
    const h = await harness();
    const token = await admin(h);

    const body = (await get(h, "/studio/jira-workflow?project=OPS", token)).json() as JiraWorkflowGraphView;

    // The full workflow-scheme API is admin-only; the edge set is what the
    // sampled issues showed, and the body says so.
    expect(body.edgesComplete).toBe(false);
    expect(body.sampledFrom).toEqual(["OPS-6", "OPS-7"]);
    // A global transition is null-rooted, not mis-attributed to one status.
    expect(body.transitions.find((t) => t.id === "31")?.fromStatusId).toBeNull();
  });

  it("is readable by a tech-lead", async () => {
    const h = await harness();
    const token = await techLead(h);
    expect((await get(h, "/studio/jira-workflow?project=OPS", token)).statusCode).toBe(200);
  });

  it("refuses a developer — this is an admin surface (M86)", async () => {
    const h = await harness();
    const token = await developer(h);
    expect((await get(h, "/studio/jira-workflow?project=OPS", token)).statusCode).toBe(403);
  });

  it("refuses an anonymous caller", async () => {
    const h = await harness();
    const response = await h.app.inject({ method: "GET", url: "/studio/jira-workflow?project=OPS" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a missing project key", async () => {
    const h = await harness();
    const token = await admin(h);
    const response = await get(h, "/studio/jira-workflow", token);
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("invalid_project");
  });

  it("rejects a project value carrying a path or JQL fragment", async () => {
    const h = await harness();
    const token = await admin(h);
    for (const bad of ["OPS/../ADMIN", "OPS%20OR%201=1", "OPS OR ORDER BY"]) {
      const response = await get(h, `/studio/jira-workflow?project=${bad}`, token);
      expect(response.statusCode).toBe(400);
    }
  });

  it("refuses BY NAME (503) when no workflow reader is wired", async () => {
    const h = await harness({ deps: { jiraWorkflow: undefined } });
    const token = await admin(h);

    const response = await get(h, "/studio/jira-workflow?project=OPS", token);

    // 503, not an empty graph: an unwired import must not render as "this
    // project has no workflow".
    expect(response.statusCode).toBe(503);
    const body = response.json() as { error: string; details: { capability: string; missing: string } };
    expect(body.error).toBe("capability_not_wired");
    expect(body.details.capability).toBe("jira-workflow");
    expect(body.details.missing).toContain("JiraWorkflowReader");
  });

  it("does not fabricate a graph for a project the reader cannot read", async () => {
    // Reader seeded with OPS only; PAY is unknown, so the reader raises and the
    // route answers 500 rather than an empty graph. (A real deployment surfaces
    // the driver's typed Jira error the same way.)
    const h = await harness({ workflowGraphs: [TEST_WORKFLOW_GRAPH] });
    const token = await admin(h);

    const response = await get(h, "/studio/jira-workflow?project=PAY", token);
    expect(response.statusCode).toBe(500);
  });
});
