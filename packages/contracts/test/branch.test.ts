import { describe, expect, it } from "vitest";
import { branchSlug, extractTicketKeyFromBranch, featureBranchName } from "../src/index.js";

describe("branch naming contract (M49)", () => {
  it("producer and consumer agree — round trip", () => {
    const name = featureBranchName("UGURPAY-123", "Limit artırma akışı");
    expect(name).toBe("feature/UGURPAY-123-limit-artirma-akisi");
    expect(extractTicketKeyFromBranch(name)).toBe("UGURPAY-123");
  });

  it("works without a description", () => {
    expect(featureBranchName("UGURWEB-88")).toBe("feature/UGURWEB-88");
    expect(extractTicketKeyFromBranch("feature/UGURWEB-88")).toBe("UGURWEB-88");
  });

  it("accepts a full ref as produced by ADO events", () => {
    expect(extractTicketKeyFromBranch("refs/heads/feature/UGURDESK-45-export")).toBe("UGURDESK-45");
  });

  it("rejects branches that are not ours — no silent ticket inference", () => {
    for (const b of [
      "main",
      "feature/ugurpay-123",
      "hotfix/UGURPAY-123",
      "feature/UGURPAY-123_underscore",
      "feature/NOTATICKET",
    ]) {
      expect(extractTicketKeyFromBranch(b), b).toBeNull();
    }
  });

  it("slug is ascii, lowercase and bounded", () => {
    const slug = branchSlug("ÇOK Uzun Bir Başlık — şğüıöç ve /özel\\ karakterler!!! ".repeat(3));
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});
