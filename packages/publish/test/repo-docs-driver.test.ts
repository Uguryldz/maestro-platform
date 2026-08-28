import { describe, expect, it } from "vitest";
import { RepoDocsPublisher, RepoDocsPublishConfig } from "../src/drivers/repo-docs.js";
import { PublishConfigError } from "../src/errors.js";
import { InMemoryPublishState, type PublishStateStore, type RepoWorkspace } from "../src/types.js";
import { APP, FakeScmPort, FakeWorkspace, request, runContext } from "./helpers.js";

const CONFIG = RepoDocsPublishConfig.parse({});
const DOC = "# Analiz\n\nmetin";
const PATH = "docs/maestro/UGURPAY-123/analysis.md";
const BRANCH = "docs/maestro/UGURPAY-123-analysis";

function build<W extends RepoWorkspace = FakeWorkspace>(
  state: PublishStateStore = new InMemoryPublishState(),
  workspace: W = new FakeWorkspace() as unknown as W,
) {
  const scm = new FakeScmPort();
  const driver = new RepoDocsPublisher(CONFIG, {
    scm: scm.asPort(),
    workspace,
    state,
    runContext: runContext({ app: APP }),
  });
  return { driver, scm, workspace, state };
}

describe("repo-docs publish driver (M47)", () => {
  it("branches, commits the document and opens a PR through ScmPort", async () => {
    const { driver, scm, workspace } = build();

    const receipt = await driver.publish(request({ targets: ["repo-docs"] }), DOC);

    expect(scm.calls.map((call) => call.method)).toEqual(["resolveRepo", "createBranch", "openPr"]);
    expect(scm.calls[1]?.args.slice(1)).toEqual([BRANCH, "main"]);
    expect(workspace.files.get(`${BRANCH}:${PATH}`)).toBe(DOC);
    expect(receipt.target).toBe("repo-docs");
    expect(receipt.ref).toMatch(/^\d{2}(c0ffee)+$/); // the commit sha, not the path
  });

  it("writes English commit and PR titles even for a Turkish document (M59)", async () => {
    const { driver, scm, workspace } = build();
    await driver.publish(request({ targets: ["repo-docs"] }), DOC);

    expect(workspace.commits[0]?.message).toBe("docs(maestro): analysis for UGURPAY-123");
    const pr = scm.calls[2]?.args[1] as { title: string; draft: boolean; targetBranch: string };
    expect(pr.title).toBe("docs(maestro): analysis for UGURPAY-123");
    expect(pr.targetBranch).toBe("main");
    expect(pr.draft).toBe(false);
  });

  it("commits nothing on an unchanged republish — no empty commit, no second PR", async () => {
    const { driver, scm, workspace } = build();
    const first = await driver.publish(request({ targets: ["repo-docs"] }), DOC);
    const second = await driver.publish(request({ targets: ["repo-docs"] }), DOC);

    expect(second).toEqual(first);
    expect(workspace.commits).toHaveLength(1);
    expect(scm.calls.filter((call) => call.method === "openPr")).toHaveLength(1);
    expect(scm.calls.filter((call) => call.method === "createBranch")).toHaveLength(1);
  });

  it("commits the new revision on the SAME branch and PR when the document changed", async () => {
    const { driver, scm, workspace } = build();
    await driver.publish(request({ targets: ["repo-docs"] }), DOC);
    const second = await driver.publish(request({ targets: ["repo-docs"] }), `${DOC}\n\nek`);

    expect(workspace.commits).toHaveLength(2);
    expect(workspace.commits[1]?.branch).toBe(BRANCH);
    expect(scm.calls.filter((call) => call.method === "openPr")).toHaveLength(1);
    expect(scm.calls.filter((call) => call.method === "createBranch")).toHaveLength(1);
    expect(second.ref).not.toBe(workspace.commits[0]);
  });

  it("opens a NEW branch and PR once the previous one was merged (M54 rejection loop)", async () => {
    // Routine sequence: analysis published → PR merged → branch deleted →
    // analysis rejected at the gate → revised analysis published. The driver
    // used to commit the revision to the deleted branch and report success,
    // so the revised document never reached main.
    const { driver, scm, workspace } = build();
    await driver.publish(request({ targets: ["repo-docs"] }), DOC);
    const [prId] = [...scm.prStates.keys()];
    scm.merge(prId ?? 0, BRANCH);

    const receipt = await driver.publish(request({ targets: ["repo-docs"] }), `${DOC}\n\nrevizyon`);

    const revised = "docs/maestro/UGURPAY-123-analysis-r1";
    expect(scm.branches.has(revised)).toBe(true);
    expect(workspace.commits[1]?.branch).toBe(revised);
    expect(workspace.files.get(`${revised}:${PATH}`)).toBe(`${DOC}\n\nrevizyon`);
    expect(scm.calls.filter((call) => call.method === "openPr")).toHaveLength(2);
    expect(receipt.ref).toBe(workspace.shas.get(`${revised}:${PATH}`));
  });

  it("stays on the branch while its PR is still open", async () => {
    const { driver, scm, workspace } = build();
    await driver.publish(request({ targets: ["repo-docs"] }), DOC);
    await driver.publish(request({ targets: ["repo-docs"] }), `${DOC}\n\nek`);

    expect(scm.calls.filter((call) => call.method === "createBranch")).toHaveLength(1);
    expect(scm.calls.filter((call) => call.method === "openPr")).toHaveLength(1);
    expect(workspace.commits.every((commit) => commit.branch === BRANCH)).toBe(true);
  });

  it("does not open a second PR when the first publish died between commit and PR", async () => {
    // The state write used to happen once, at the very end: a failure after
    // the commit erased every trace of it, and the retry opened a duplicate PR
    // for the same document.
    const state = new InMemoryPublishState();
    const workspace = new FakeWorkspace();
    const { driver, scm } = build(state, workspace);
    scm.openPr = () => Promise.reject(new Error("ADO unavailable"));

    await expect(driver.publish(request({ targets: ["repo-docs"] }), DOC)).rejects.toThrow("ADO unavailable");

    const retry = build(state, workspace);
    retry.scm.branches.add(BRANCH); // the branch the first attempt created
    const receipt = await retry.driver.publish(request({ targets: ["repo-docs"] }), DOC);

    expect(workspace.commits).toHaveLength(1); // the commit was remembered
    expect(retry.scm.calls.filter((call) => call.method === "openPr")).toHaveLength(1);
    expect(retry.scm.calls.filter((call) => call.method === "createBranch")).toHaveLength(0);
    expect(receipt.ref).toBe(workspace.shas.get(`${BRANCH}:${PATH}`));
  });

  it("keeps one file per document kind", async () => {
    const { driver, workspace } = build();
    await driver.publish(request({ targets: ["repo-docs"] }), DOC);
    await driver.publish(request({ targets: ["repo-docs"], doc: "evidence_summary" }), DOC);

    expect([...workspace.files.keys()].sort()).toEqual([
      "docs/maestro/UGURPAY-123-analysis:docs/maestro/UGURPAY-123/analysis.md",
      "docs/maestro/UGURPAY-123-evidence_summary:docs/maestro/UGURPAY-123/evidence_summary.md",
    ]);
  });

  it("does not re-commit identical bytes even when the bookkeeping was lost", async () => {
    const workspace = new FakeWorkspace();
    const first = await build(new InMemoryPublishState(), workspace).driver.publish(
      request({ targets: ["repo-docs"] }),
      DOC,
    );

    // Fresh state store: the run's memory is gone, the repository is not.
    const recovered = build(new InMemoryPublishState(), workspace);
    const receipt = await recovered.driver.publish(request({ targets: ["repo-docs"] }), DOC);

    expect(workspace.commits).toHaveLength(1);
    // The receipt is the COMMIT, recovered from the workspace — a file path in
    // a `ref` field reads as a commit in an evidence package and is not one.
    expect(receipt.ref).toBe(first.ref);
    expect(recovered.scm.calls.map((call) => call.method)).toEqual(["resolveRepo", "openPr"]);
  });

  it("refuses to receipt a file path when the workspace cannot name the commit", async () => {
    const workspace = new FakeWorkspace();
    await build(new InMemoryPublishState(), workspace).driver.publish(request({ targets: ["repo-docs"] }), DOC);

    // A workspace implementation that cannot answer "which commit is this".
    const blind: RepoWorkspace = {
      readFile: (branch, path) => workspace.readFile(branch, path),
      commitFile: (args) => workspace.commitFile(args),
    };
    const recovered = build(new InMemoryPublishState(), blind);

    await expect(recovered.driver.publish(request({ targets: ["repo-docs"] }), DOC)).rejects.toThrow(
      PublishConfigError,
    );
    expect(workspace.commits).toHaveLength(1);
  });

  it("refuses to publish when the run has no application to write to", async () => {
    const scm = new FakeScmPort();
    const driver = new RepoDocsPublisher(CONFIG, {
      scm: scm.asPort(),
      workspace: new FakeWorkspace(),
      state: new InMemoryPublishState(),
      runContext: runContext(),
    });

    await expect(driver.publish(request({ targets: ["repo-docs"] }), DOC)).rejects.toThrow(PublishConfigError);
    expect(scm.calls).toHaveLength(0);
  });

  it("refuses an empty commit sha instead of receipting a commit that may not exist", async () => {
    const workspace = new FakeWorkspace();
    workspace.commitFile = () => Promise.resolve({ sha: "" });
    const { driver } = build(new InMemoryPublishState(), workspace);

    await expect(driver.publish(request({ targets: ["repo-docs"] }), DOC)).rejects.toThrow(PublishConfigError);
  });

  it("can be configured to commit without opening a PR", async () => {
    const scm = new FakeScmPort();
    const driver = new RepoDocsPublisher(RepoDocsPublishConfig.parse({ openPullRequest: false, baseBranch: "develop" }), {
      scm: scm.asPort(),
      workspace: new FakeWorkspace(),
      state: new InMemoryPublishState(),
      runContext: runContext({ app: APP }),
    });

    await driver.publish(request({ targets: ["repo-docs"] }), DOC);
    expect(scm.calls.map((call) => call.method)).toEqual(["resolveRepo", "createBranch"]);
    expect(scm.calls[1]?.args[2]).toBe("develop");
  });

  it("refuses a path-traversing docs directory", () => {
    expect(() => RepoDocsPublishConfig.parse({ docsDir: "../../etc" })).toThrow();
    expect(() => RepoDocsPublishConfig.parse({ docsDir: "docs/../../etc" })).toThrow();
    expect(() => RepoDocsPublishConfig.parse({ branchPrefix: "docs maestro" })).toThrow();
    expect(() => RepoDocsPublishConfig.parse({ unknownKey: true })).toThrow();
  });

  it("refuses to be constructed without the workspace it writes through", () => {
    expect(
      () =>
        new RepoDocsPublisher(CONFIG, {
          scm: new FakeScmPort().asPort(),
          workspace: undefined as never,
          state: new InMemoryPublishState(),
          runContext: runContext({ app: APP }),
        }),
    ).toThrow(PublishConfigError);
  });
});
