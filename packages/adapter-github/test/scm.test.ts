import { describe, expect, it } from "vitest";
import { GithubNotFoundError, GithubResponseError } from "../src/index.js";
import {
  APP,
  fixture,
  isGraphql,
  pathOf,
  REPO,
  scmDriver as driver,
} from "./helpers.js";

describe("GithubScmDriver.resolveRepo", () => {
  it("resolves an ApplicationRecord to the canonical owner/repo names", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("repo-get") }));
    await expect(scm.resolveRepo(APP)).resolves.toEqual({ project: "ugurbank", repo: "ugurpay" });
    expect(pathOf(calls[0]!)).toBe("https://api.github.com/repos/ugurbank/ugurpay");
  });

  it("fails loudly when the registry points at a missing repository", async () => {
    const { scm } = driver(() => ({ status: 404, text: "Not Found" }));
    await expect(scm.resolveRepo(APP)).rejects.toBeInstanceOf(GithubNotFoundError);
  });

  it("rejects an Application Registry record that fails its own schema", async () => {
    const { scm } = driver(() => ({ json: fixture("repo-get") }));
    await expect(scm.resolveRepo({ ...APP, adoRepo: "" })).rejects.toThrow();
  });
});

describe("GithubScmDriver.createBranch", () => {
  it("posts a new ref directly from a full commit id (single call)", async () => {
    const base = "9c1e5a3b7d2f4068a1b3c5d7e9f0a2b4c6d8e0f1";
    const { scm, calls } = driver(() => ({ json: fixture("ref-create-success") }));
    await scm.createBranch(REPO, "feature/UGURPAY-4312-iban-validation", base);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(pathOf(call)).toBe("https://api.github.com/repos/ugurbank/ugurpay/git/refs");
    expect(call.body).toEqual({
      ref: "refs/heads/feature/UGURPAY-4312-iban-validation",
      sha: base,
    });
  });

  it("resolves a base branch name to its tip sha first (two-step)", async () => {
    const { scm, calls } = driver((call) =>
      call.method === "GET"
        ? { json: fixture("ref-get-main") }
        : { json: fixture("ref-create-success") },
    );
    await scm.createBranch(REPO, "feature/UGURPAY-4312-iban-validation", "main");

    expect(calls).toHaveLength(2);
    expect(pathOf(calls[0]!)).toBe(
      "https://api.github.com/repos/ugurbank/ugurpay/git/ref/heads/main",
    );
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.body).toEqual({
      ref: "refs/heads/feature/UGURPAY-4312-iban-validation",
      sha: "9c1e5a3b7d2f4068a1b3c5d7e9f0a2b4c6d8e0f1",
    });
  });

  it("propagates a 404 when the base branch does not exist", async () => {
    const { scm } = driver(() => ({ status: 404, text: "Not Found" }));
    await expect(
      scm.createBranch(REPO, "feature/UGURPAY-1-x", "develop"),
    ).rejects.toBeInstanceOf(GithubNotFoundError);
  });

  it("rejects a created ref that does not match what was requested", async () => {
    const { scm } = driver(() => ({
      json: {
        ref: "refs/heads/some-other-branch",
        object: { sha: "9c1e5a3b7d2f4068a1b3c5d7e9f0a2b4c6d8e0f1" },
      },
    }));
    await expect(
      scm.createBranch(REPO, "feature/UGURPAY-4312-iban-validation", "a".repeat(40)),
    ).rejects.toBeInstanceOf(GithubResponseError);
  });
});

describe("GithubScmDriver.openPr", () => {
  it("opens a draft PR with bare branch names and returns the number as prId", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("pr-create-draft") }));
    const result = await scm.openPr(REPO, {
      sourceBranch: "feature/UGURPAY-4312-iban-validation",
      targetBranch: "main",
      title: "[AI] UGURPAY-4312 IBAN validation",
      description: "Analysis summary and evidence link.",
      draft: true,
    });

    expect(result).toEqual({ prId: 128 });
    expect(pathOf(calls[0]!)).toBe("https://api.github.com/repos/ugurbank/ugurpay/pulls");
    expect(calls[0]!.body).toEqual({
      title: "[AI] UGURPAY-4312 IBAN validation",
      head: "feature/UGURPAY-4312-iban-validation",
      base: "main",
      body: "Analysis summary and evidence link.",
      draft: true,
    });
  });

  it("strips a refs/heads/ prefix from head and base", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("pr-get-active") }));
    await scm.openPr(REPO, {
      sourceBranch: "refs/heads/feature/UGURPAY-4312-iban-validation",
      targetBranch: "refs/heads/main",
      title: "t",
      description: "d",
      draft: false,
    });
    expect(calls[0]!.body).toMatchObject({
      head: "feature/UGURPAY-4312-iban-validation",
      base: "main",
      draft: false,
    });
  });
});

describe("GithubScmDriver.activatePr", () => {
  it("fetches the node id then runs the ready-for-review GraphQL mutation", async () => {
    const { scm, calls } = driver((call) =>
      isGraphql(call)
        ? { json: fixture("graphql-mark-ready") }
        : { json: fixture("pr-create-draft") },
    );
    await scm.activatePr(REPO, 128);

    expect(calls).toHaveLength(2);
    expect(pathOf(calls[0]!)).toBe("https://api.github.com/repos/ugurbank/ugurpay/pulls/128");
    expect(isGraphql(calls[1]!)).toBe(true);
    const gql = calls[1]!.body as { variables: { id: string } };
    expect(gql.variables.id).toBe("PR_kwDOAABCDE5abcdef");
  });

  it("throws when GitHub reports the PR as still a draft after the mutation", async () => {
    const { scm } = driver((call) =>
      isGraphql(call)
        ? {
            json: {
              data: {
                markPullRequestReadyForReview: { pullRequest: { number: 128, isDraft: true } },
              },
            },
          }
        : { json: fixture("pr-create-draft") },
    );
    await expect(scm.activatePr(REPO, 128)).rejects.toBeInstanceOf(GithubResponseError);
  });

  it("surfaces a GraphQL errors array as a GithubResponseError", async () => {
    const { scm } = driver((call) =>
      isGraphql(call)
        ? { json: { data: null, errors: [{ message: "Could not resolve to a node." }] } }
        : { json: fixture("pr-create-draft") },
    );
    await expect(scm.activatePr(REPO, 128)).rejects.toThrow(/Could not resolve/);
  });
});

describe("GithubScmDriver.getPrStatus (four state mappings)", () => {
  it("maps open + draft → draft with no merge sha", async () => {
    const { scm } = driver(() => ({ json: fixture("pr-create-draft") }));
    await expect(scm.getPrStatus(REPO, 128)).resolves.toEqual({
      prId: 128,
      state: "draft",
      mergeSha: null,
    });
  });

  it("maps open (not draft) → active, ignoring the preview merge_commit_sha", async () => {
    // The fixture carries a merge_commit_sha on purpose: GitHub populates the
    // test-merge preview commit on an open PR. Reporting it would tell the
    // gate a PR merged while review is still open.
    const { scm } = driver(() => ({ json: fixture("pr-get-active") }));
    await expect(scm.getPrStatus(REPO, 128)).resolves.toEqual({
      prId: 128,
      state: "active",
      mergeSha: null,
    });
    expect((fixture("pr-get-active") as { merge_commit_sha?: unknown }).merge_commit_sha).toBeTruthy();
  });

  it("maps closed + merged → completed with the merge sha", async () => {
    const { scm } = driver(() => ({ json: fixture("pr-get-completed") }));
    await expect(scm.getPrStatus(REPO, 128)).resolves.toEqual({
      prId: 128,
      state: "completed",
      mergeSha: "d3f9a172c48b5e60a7d1c2b3e4f5061728394a5b",
    });
  });

  it("maps closed + not merged → abandoned, ignoring the last-attempt merge sha", async () => {
    const { scm } = driver(() => ({ json: fixture("pr-get-abandoned") }));
    await expect(scm.getPrStatus(REPO, 129)).resolves.toEqual({
      prId: 129,
      state: "abandoned",
      mergeSha: null,
    });
  });

  it("refuses a malformed merge_commit_sha on a merged PR instead of 'not merged'", async () => {
    const { scm } = driver(() => ({
      json: { ...(fixture("pr-get-completed") as object), merge_commit_sha: "zzz" },
    }));
    await expect(scm.getPrStatus(REPO, 128)).rejects.toThrow(/merge_commit_sha/);
  });

  it("refuses a merged PR that carries no merge_commit_sha", async () => {
    const { scm } = driver(() => ({
      json: { ...(fixture("pr-get-completed") as object), merge_commit_sha: null },
    }));
    await expect(scm.getPrStatus(REPO, 128)).rejects.toThrow(/no merge_commit_sha/);
  });
});

const SHA = "a".repeat(40);

describe("GithubScmDriver.getCommitChecks (B14 real CI verdict)", () => {
  it("reads commits/{sha}/check-runs and maps all-passing → success", async () => {
    const { scm, calls } = driver(() => ({
      json: {
        total_count: 2,
        check_runs: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "lint", status: "completed", conclusion: "neutral" },
        ],
      },
    }));
    const checks = await scm.getCommitChecks!(REPO, SHA as never);
    expect(checks.state).toBe("success");
    expect(pathOf(calls[0]!)).toBe(
      `https://api.github.com/repos/ugurbank/ugurpay/commits/${SHA}/check-runs`,
    );
  });

  it("maps any incomplete check → pending (never green while running)", async () => {
    const { scm } = driver(() => ({
      json: {
        total_count: 2,
        check_runs: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "e2e", status: "in_progress", conclusion: null },
        ],
      },
    }));
    expect((await scm.getCommitChecks!(REPO, SHA as never)).state).toBe("pending");
  });

  it("maps any failed check → failure even if another is still pending", async () => {
    const { scm } = driver(() => ({
      json: {
        total_count: 2,
        check_runs: [
          { name: "build", status: "completed", conclusion: "failure" },
          { name: "e2e", status: "queued", conclusion: null },
        ],
      },
    }));
    expect((await scm.getCommitChecks!(REPO, SHA as never)).state).toBe("failure");
  });

  it("maps no checks at all → none (repo with no CI configured)", async () => {
    const { scm } = driver(() => ({ json: { total_count: 0, check_runs: [] } }));
    expect((await scm.getCommitChecks!(REPO, SHA as never)).state).toBe("none");
  });
});

describe("GithubScmDriver.mergePr (B14 real merge)", () => {
  it("PUTs pulls/{n}/merge and returns the merge sha", async () => {
    const { scm, calls } = driver(() => ({ json: { merged: true, sha: "c".repeat(40) } }));
    const result = await scm.mergePr!(REPO, 77);
    expect(result.mergeSha).toBe("c".repeat(40));
    expect(calls[0]!.method).toBe("PUT");
    expect(pathOf(calls[0]!)).toBe("https://api.github.com/repos/ugurbank/ugurpay/pulls/77/merge");
  });

  it("throws when GitHub answers 200 but did not actually merge", async () => {
    const { scm } = driver(() => ({ json: { merged: false, message: "not mergeable" } }));
    await expect(scm.mergePr!(REPO, 77)).rejects.toThrow(/did not merge/);
  });

  it("throws on a malformed merge sha rather than reporting success", async () => {
    const { scm } = driver(() => ({ json: { merged: true, sha: "zzz" } }));
    await expect(scm.mergePr!(REPO, 77)).rejects.toThrow(/invalid merge sha/);
  });
});
