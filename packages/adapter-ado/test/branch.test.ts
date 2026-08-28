import { describe, expect, it } from "vitest";
import {
  extractPullRequestId,
  extractTicketKey,
  isFullSha,
  toBranchName,
  toGitSha,
  toRefName,
  ZERO_OBJECT_ID,
} from "../src/index.js";

describe("branch naming (M49 trunk-based)", () => {
  it("extracts the ticket key from a feature branch and its ref form", () => {
    expect(extractTicketKey("feature/UGURPAY-4312-iban-validation")).toBe("UGURPAY-4312");
    expect(extractTicketKey("refs/heads/feature/UGURPAY-4312-iban-validation")).toBe("UGURPAY-4312");
  });

  it("accepts a feature branch with no descriptive suffix", () => {
    expect(extractTicketKey("feature/UGURWEB-902")).toBe("UGURWEB-902");
  });

  it("returns null for branches outside the convention", () => {
    expect(extractTicketKey("main")).toBeNull();
    expect(extractTicketKey("refs/heads/release/2.4")).toBeNull();
    expect(extractTicketKey("refs/heads/hotfix/tls-cipher-order")).toBeNull();
    expect(extractTicketKey("feature/no-ticket-here")).toBeNull();
    expect(extractTicketKey("feature/ugurpay-4312-lowercase")).toBeNull();
    expect(extractTicketKey("")).toBeNull();
  });

  it("does not accept a key in the middle of the branch name", () => {
    // Only the leading segment is the key; anything else is a guess.
    expect(extractTicketKey("feature/team/UGURPAY-4312-x")).toBeNull();
  });

  it("reads the pull request id from a merge ref", () => {
    expect(extractPullRequestId("refs/pull/128/merge")).toBe(128);
    expect(extractPullRequestId("refs/pull/77/head")).toBe(77);
    expect(extractPullRequestId("refs/heads/main")).toBeNull();
    expect(extractPullRequestId("refs/pull/0/merge")).toBeNull();
  });

  it("normalises branch and ref names in both directions", () => {
    expect(toRefName("feature/UGURPAY-1-x")).toBe("refs/heads/feature/UGURPAY-1-x");
    expect(toRefName("refs/heads/main")).toBe("refs/heads/main");
    expect(toBranchName("refs/heads/main")).toBe("main");
    expect(toBranchName("main")).toBe("main");
  });

  it("recognises full commit ids only", () => {
    expect(isFullSha("9c1e5a3b7d2f4068a1b3c5d7e9f0a2b4c6d8e0f1")).toBe(true);
    expect(isFullSha("9c1e5a3")).toBe(false);
    expect(isFullSha("main")).toBe(false);
    expect(ZERO_OBJECT_ID).toHaveLength(40);
  });

  it("validates commit ids through the GitSha contract", () => {
    expect(toGitSha("9c1e5a3b7d2f4068a1b3c5d7e9f0a2b4c6d8e0f1")).toBe(
      "9c1e5a3b7d2f4068a1b3c5d7e9f0a2b4c6d8e0f1",
    );
    expect(toGitSha("not-a-sha")).toBeNull();
    expect(toGitSha(undefined)).toBeNull();
  });
});
