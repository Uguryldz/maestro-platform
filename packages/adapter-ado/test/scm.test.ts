import { describe, expect, it } from "vitest";
import {
  AdoClient,
  AdoNotFoundError,
  AdoResponseError,
  AdoScmDriver,
  parseAdoConfig,
} from "../src/index.js";
import {
  APP,
  CI_CONFIG,
  createFakeHttp,
  fixture,
  issuer,
  pathOf,
  queryOf,
  REPO,
  scmDriver as driver,
} from "./helpers.js";

describe("AdoScmDriver.resolveRepo", () => {
  it("resolves an ApplicationRecord to the canonical project/repo names", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("repo-get") }));
    await expect(scm.resolveRepo(APP)).resolves.toEqual({ project: "UgurPay", repo: "ugurpay" });
    expect(pathOf(calls[0]!)).toBe(
      "https://dev.azure.com/ugurbank/UgurPay/_apis/git/repositories/ugurpay",
    );
  });

  it("fails loudly when the registry points at a missing repository", async () => {
    const { scm } = driver(() => ({ status: 404, text: "TF401019" }));
    await expect(scm.resolveRepo(APP)).rejects.toBeInstanceOf(AdoNotFoundError);
  });

  it("rejects an Application Registry record that fails its own schema", async () => {
    const { scm } = driver(() => ({ json: fixture("repo-get") }));
    await expect(scm.resolveRepo({ ...APP, adoRepo: "" })).rejects.toThrow();
  });
});

describe("AdoScmDriver.createBranch", () => {
  it("pushes a ref update from the zero object id when given a commit id", async () => {
    const base = "9c1e5a3b7d2f4068a1b3c5d7e9f0a2b4c6d8e0f1";
    const { scm, calls } = driver(() => ({ json: fixture("refs-update-success") }));
    await scm.createBranch(REPO, "feature/UGURPAY-4312-iban-validation", base);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(pathOf(call)).toBe(
      "https://dev.azure.com/ugurbank/UgurPay/_apis/git/repositories/ugurpay/refs",
    );
    expect(call.body).toEqual([
      {
        name: "refs/heads/feature/UGURPAY-4312-iban-validation",
        oldObjectId: "0".repeat(40),
        newObjectId: base,
      },
    ]);
  });

  it("resolves a base branch name to its tip commit first", async () => {
    const { scm, calls } = driver((call) =>
      call.method === "GET"
        ? { json: fixture("refs-list") }
        : { json: fixture("refs-update-success") },
    );
    await scm.createBranch(REPO, "feature/UGURPAY-4312-iban-validation", "main");

    expect(calls).toHaveLength(2);
    expect(queryOf(calls[0]!, "filter")).toBe("heads/main");
    expect(calls[1]!.body).toMatchObject([
      { newObjectId: "9c1e5a3b7d2f4068a1b3c5d7e9f0a2b4c6d8e0f1" },
    ]);
  });

  it("throws when the base ref does not exist", async () => {
    const { scm } = driver(() => ({ json: { value: [], count: 0 } }));
    await expect(scm.createBranch(REPO, "feature/UGURPAY-1-x", "develop")).rejects.toBeInstanceOf(
      AdoResponseError,
    );
  });

  it("does not treat a rejected ref update (HTTP 200, success:false) as created", async () => {
    const { scm } = driver(() => ({ json: fixture("refs-update-rejected") }));
    await expect(
      scm.createBranch(REPO, "feature/UGURPAY-4312-iban-validation", "9".repeat(40)),
    ).rejects.toThrow(/stale/);
  });
});

describe("AdoScmDriver pull requests", () => {
  it("opens a draft PR with fully-qualified refs (M13)", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("pr-create-draft") }));
    const result = await scm.openPr(REPO, {
      sourceBranch: "feature/UGURPAY-4312-iban-validation",
      targetBranch: "main",
      title: "[AI] UGURPAY-4312 IBAN validation",
      description: "Analysis summary and evidence link.",
      draft: true,
    });

    expect(result).toEqual({ prId: 128 });
    expect(calls[0]!.body).toEqual({
      sourceRefName: "refs/heads/feature/UGURPAY-4312-iban-validation",
      targetRefName: "refs/heads/main",
      title: "[AI] UGURPAY-4312 IBAN validation",
      description: "Analysis summary and evidence link.",
      isDraft: true,
    });
  });

  it("honours draft:false", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("pr-get-active") }));
    await scm.openPr(REPO, {
      sourceBranch: "feature/UGURPAY-4312-iban-validation",
      targetBranch: "main",
      title: "t",
      description: "d",
      draft: false,
    });
    expect(calls[0]!.body).toMatchObject({ isDraft: false });
  });

  it("activates a draft PR and verifies the result", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("pr-get-active") }));
    await scm.activatePr(REPO, 128);

    const call = calls[0]!;
    expect(call.method).toBe("PATCH");
    expect(pathOf(call)).toBe(
      "https://dev.azure.com/ugurbank/UgurPay/_apis/git/repositories/ugurpay/pullrequests/128",
    );
    expect(call.body).toEqual({ isDraft: false });
  });

  it("throws when ADO reports the PR as still a draft after activation", async () => {
    const { scm } = driver(() => ({ json: fixture("pr-create-draft") }));
    await expect(scm.activatePr(REPO, 128)).rejects.toBeInstanceOf(AdoResponseError);
  });

  it("refuses a malformed merge commit on a completed PR instead of 'not merged'", async () => {
    const { scm } = driver(() => ({
      json: { ...(fixture("pr-get-completed") as object), lastMergeCommit: { commitId: "zzz" } },
    }));
    await expect(scm.getPrStatus(REPO, 128)).rejects.toThrow(/lastMergeCommit/);
  });

  it("refuses an unsupported PR status", async () => {
    const { scm } = driver(() => ({
      json: { ...(fixture("pr-get-active") as object), status: "notSet" },
    }));
    await expect(scm.getPrStatus(REPO, 128)).rejects.toThrow(/unsupported PR status/);
  });
});

describe("AdoScmDriver.getPrStatus merge sha (K3)", () => {
  it("reports no merge sha for an ACTIVE PR, even though ADO sends one", async () => {
    // ADO refreshes `lastMergeCommit` on every source-branch update with the
    // commit of a *preview* merge — the fixture carries one on purpose. That
    // commit is on no target branch, so reporting it would tell the gate a
    // PR was merged while review is still open.
    const { scm } = driver(() => ({ json: fixture("pr-get-active") }));
    await expect(scm.getPrStatus(REPO, 128)).resolves.toEqual({
      prId: 128,
      state: "active",
      mergeSha: null,
    });
    expect((fixture("pr-get-active") as { lastMergeCommit?: unknown }).lastMergeCommit).toBeDefined();
  });

  it("reports no merge sha for a draft PR", async () => {
    const { scm } = driver(() => ({ json: fixture("pr-create-draft") }));
    const status = await scm.getPrStatus(REPO, 128);
    expect(status.state).toBe("draft");
    expect(status.mergeSha).toBeNull();
  });

  it("fills the merge sha only once the PR is completed", async () => {
    const { scm } = driver(() => ({ json: fixture("pr-get-completed") }));
    await expect(scm.getPrStatus(REPO, 128)).resolves.toEqual({
      prId: 128,
      state: "completed",
      mergeSha: "d3f9a172c48b5e60a7d1c2b3e4f5061728394a5b",
    });
  });

  it("reports no merge sha for an abandoned PR", async () => {
    const { scm } = driver(() => ({ json: fixture("pr-get-abandoned") }));
    await expect(scm.getPrStatus(REPO, 129)).resolves.toEqual({
      prId: 129,
      state: "abandoned",
      mergeSha: null,
    });
  });

  it("ignores a preview merge commit on an abandoned PR as well", async () => {
    const { scm } = driver(() => ({
      json: {
        ...(fixture("pr-get-abandoned") as object),
        lastMergeCommit: { commitId: "d3f9a172c48b5e60a7d1c2b3e4f5061728394a5b" },
      },
    }));
    await expect(scm.getPrStatus(REPO, 129)).resolves.toMatchObject({ mergeSha: null });
  });
});

describe("AdoScmDriver in server mode", () => {
  it("uses collection-scoped URLs for the same calls", async () => {
    const http = createFakeHttp(() => ({ json: fixture("pr-create-draft") }));
    const client = new AdoClient({
      config: parseAdoConfig({
        mode: "server",
        baseUrl: "https://tfs.ugurbank.local/tfs",
        collection: "DefaultCollection",
        tokenRef: "ado/server/pat",
        ci: CI_CONFIG,
      }),
      token: () => "pat",
      fetch: http.fetch,
    });
    const scm = new AdoScmDriver({ client, issueSecret: issuer });
    await scm.openPr(REPO, {
      sourceBranch: "feature/UGURPAY-4312-iban-validation",
      targetBranch: "main",
      title: "t",
      description: "d",
      draft: true,
    });

    expect(pathOf(http.calls[0]!)).toBe(
      "https://tfs.ugurbank.local/tfs/DefaultCollection/UgurPay/_apis" +
        "/git/repositories/ugurpay/pullrequests",
    );
    expect(queryOf(http.calls[0]!, "api-version")).toBe("6.0");
  });
});
