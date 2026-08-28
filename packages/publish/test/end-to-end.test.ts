import { describe, expect, it } from "vitest";
import { renderAnalysisMarkdown, type DocContext } from "../src/documents.js";
import { createPublishPort } from "../src/register.js";
import { InMemoryPublishState, type PublishDeps } from "../src/types.js";
import {
  ANALYSIS,
  APP,
  FakeScmPort,
  FakeWorkPort,
  FakeWorkspace,
  RUN_ID,
  TICKET,
  fakeFetch,
  fakeSecrets,
  fakeTranslate,
  piiDeps,
  request,
  runContext,
  type RecordedRequest,
} from "./helpers.js";

/**
 * The whole path a run walks: analysis document → markdown → three targets.
 * It exists because the failure that killed v1 was not a broken unit, it was
 * units that never met.
 */
function wire() {
  const work = new FakeWorkPort();
  const scm = new FakeScmPort();
  const workspace = new FakeWorkspace();
  const pages = new Map<string, { id: string; version: number; value: string }>();

  const handler = (req: RecordedRequest): { status: number; body?: unknown } => {
    const url = new URL(req.url);
    const id = /\/content\/(\d+)$/.exec(url.pathname)?.[1];
    const serialize = (page: { id: string; version: number; value: string }) => ({
      id: page.id,
      version: { number: page.version },
      body: { storage: { value: page.value } },
    });
    if (req.method === "GET" && id) {
      const page = pages.get(id);
      return page ? { status: 200, body: serialize(page) } : { status: 404 };
    }
    if (req.method === "GET") return { status: 200, body: { results: [...pages.values()].map(serialize) } };
    if (req.method === "POST") {
      const body = req.body as { body: { storage: { value: string } } };
      const page = { id: "777", version: 1, value: body.body.storage.value };
      pages.set(page.id, page);
      return { status: 200, body: serialize(page) };
    }
    const body = req.body as { version: { number: number }; body: { storage: { value: string } } };
    const page = pages.get(id ?? "");
    if (!page) return { status: 404 };
    page.version = body.version.number;
    page.value = body.body.storage.value;
    return { status: 200, body: serialize(page) };
  };

  const { fetchImpl, calls } = fakeFetch(handler);
  const deps: PublishDeps = {
    translate: fakeTranslate(),
    runContext: runContext({ app: APP }),
    state: new InMemoryPublishState(),
    pii: piiDeps(),
    work: work.asPort(),
    scm: scm.asPort(),
    workspace,
    secrets: fakeSecrets(),
    fetchImpl,
    sleep: () => Promise.resolve(),
  };
  const port = createPublishPort(
    ["jira", "confluence", "repo-docs"],
    {
      confluence: { baseUrl: "https://confluence.test", spaceKey: "MAESTRO", tokenRef: "secret/pat", retryDelayMs: 0 },
    },
    deps,
  );
  return { port, work, scm, workspace, pages, calls };
}

const ctx: DocContext = { translate: fakeTranslate(), locale: "tr", runId: RUN_ID, ticketKey: TICKET };
const TARGETS = { targets: ["jira", "confluence", "repo-docs"] as const };

describe("analysis document across all three targets (M47)", () => {
  it("delivers the same document to Jira, Confluence and the repo", async () => {
    const { port, work, workspace, pages } = wire();
    const markdown = renderAnalysisMarkdown(ANALYSIS, ctx);

    const receipts = await port.publish(request({ ...TARGETS, targets: [...TARGETS.targets] }), markdown);

    expect(receipts).toEqual([
      { target: "jira", ref: "comment-1" },
      { target: "confluence", ref: "777" },
      { target: "repo-docs", ref: expect.stringMatching(/^\d{2}(c0ffee)+$/) as unknown as string },
    ]);

    const jiraBody = JSON.stringify(work.calls[0]?.args[1]);
    expect(jiraBody).toContain("tr:publish.section.purpose");
    expect(jiraBody).toContain("Limit servisi değişiyor");
    expect(pages.get("777")?.value).toContain("<h2>tr:publish.section.purpose</h2>");
    expect(workspace.files.get("docs/maestro/UGURPAY-123-analysis:docs/maestro/UGURPAY-123/analysis.md")).toBe(
      markdown,
    );
  });

  it("republishing the same analysis creates nothing new anywhere (idempotency)", async () => {
    const { port, work, scm, workspace, pages } = wire();
    const markdown = renderAnalysisMarkdown(ANALYSIS, ctx);
    const targets = [...TARGETS.targets];

    const first = await port.publish(request({ targets }), markdown);
    const second = await port.publish(request({ targets }), markdown);

    expect(second).toEqual(first);
    expect(work.calls).toHaveLength(1); // no second comment, no needless edit
    expect(pages.get("777")?.version).toBe(1); // no version burned
    expect(workspace.commits).toHaveLength(1); // no empty commit
    expect(scm.calls.filter((call) => call.method === "openPr")).toHaveLength(1);
  });

  it("a revised analysis updates in place: same comment, next page version, one more commit", async () => {
    const { port, work, scm, workspace, pages } = wire();
    const targets = [...TARGETS.targets];
    await port.publish(request({ targets }), renderAnalysisMarkdown(ANALYSIS, ctx));

    const revised = renderAnalysisMarkdown(
      { ...ANALYSIS, riskTier: "kritik", riskReason: "Limit üst sınırı yükseldi" },
      ctx,
    );
    const receipts = await port.publish(request({ targets }), revised);

    expect(receipts.map((r) => r.target)).toEqual(targets);
    expect(work.calls.map((call) => call.method)).toEqual(["addComment", "updateComment"]);
    expect(pages.get("777")?.version).toBe(2);
    // The markdown escape is consumed on the way in; the wiki page shows the label itself.
    expect(pages.get("777")?.value).toContain("tr:publish.risk_tier.kritik");
    expect(workspace.commits).toHaveLength(2);
    expect(scm.calls.filter((call) => call.method === "openPr")).toHaveLength(1);
  });
});
