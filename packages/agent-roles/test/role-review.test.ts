import { describe, expect, it } from "vitest";
import { RoleOutputError } from "../src/errors.js";
import {
  type DevReviewContext,
  buildDevReviewPrompt,
  diffFiles,
  runDevReviewer,
  toReviewResult,
  validateDevReview,
} from "../src/role-dev-reviewer.js";
import { DevReviewOutput } from "../src/schemas.js";
import { scriptedLlm, ticket } from "./fixtures.js";

const DIFF = `diff --git a/src/credit/limit-policy.ts b/src/credit/limit-policy.ts
--- a/src/credit/limit-policy.ts
+++ b/src/credit/limit-policy.ts
@@ -10,3 +10,5 @@
-const MAX = 50000;
+const MAX = readConfig("credit.limit.max");
diff --git a/src/credit/limit-controller.ts b/src/credit/limit-controller.ts
--- /dev/null
+++ b/src/credit/limit-controller.ts
@@ -0,0 +1,4 @@
+export async function raiseLimit() {}
`;

const context: DevReviewContext = {
  ticket: ticket(),
  diff: DIFF,
  acceptanceCriteria: ["Limit üst sınırı konfigürasyondan okunur."],
  codingStandards: [{ name: "kodlama-standardi.md", text: "Konfig sabit kodlanmaz." }],
};

const clean = { approved: true, summary: "Değişiklik kabul kriterini karşılıyor.", findings: [] };

const withFinding = {
  approved: false,
  summary: "Bir eksik var.",
  findings: [
    {
      file: "src/credit/limit-controller.ts",
      locator: "@@ -0,0 +1,4 @@",
      severity: "major" as const,
      problem: "Uç yetkilendirme kontrolü yapmıyor.",
      suggestion: "Yetki kontrolünü ekle.",
    },
  ],
};

describe("diffFiles", () => {
  it("reads the touched paths out of a unified diff and skips /dev/null", () => {
    expect(diffFiles(DIFF)).toEqual([
      "src/credit/limit-policy.ts",
      "src/credit/limit-controller.ts",
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(diffFiles("")).toEqual([]);
  });
});

describe("dev review prompt", () => {
  it("hands over the real diff, the criteria and the coding standards", () => {
    const prompt = buildDevReviewPrompt(context);
    expect(prompt).toContain("src/credit/limit-policy.ts");
    expect(prompt).toContain("1. Limit üst sınırı konfigürasyondan okunur.");
    expect(prompt).toContain("Konfig sabit kodlanmaz.");
    expect(prompt).toContain("İNCELENECEK DIFF");
  });
});

describe("validateDevReview", () => {
  it("accepts findings that point at files the diff really touches", () => {
    expect(validateDevReview(withFinding, context).ok).toBe(true);
  });

  it("refuses a finding about a file outside the diff", () => {
    const result = validateDevReview(
      { ...withFinding, findings: [{ ...withFinding.findings[0]!, file: "src/service.ts" }] },
      context,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deficiencies[0]?.code).toBe("finding_off_diff");
    expect(result.deficiencies[0]?.message).toContain("src/service.ts");
  });

  it("refuses an approval that coexists with a blocking finding", () => {
    const result = validateDevReview({ ...withFinding, approved: true }, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.deficiencies.map((d) => d.code)).toContain("approval_contradiction");
  });

  it("lets a nit-only review be approved", () => {
    const nit = {
      ...withFinding,
      approved: true,
      findings: [{ ...withFinding.findings[0]!, severity: "nit" as const }],
    };
    expect(validateDevReview(nit, context).ok).toBe(true);
  });
});

describe("runDevReviewer", () => {
  const args = { context, variantId: "backend", dataClass: "dahili" as const };

  it("repairs an off-diff finding and fails closed when every attempt hallucinates", async () => {
    const hallucinated = {
      ...withFinding,
      findings: [{ ...withFinding.findings[0]!, file: "src/hayali.ts" }],
    };
    const { llm, prompts } = scriptedLlm([hallucinated, withFinding]);
    const result = await runDevReviewer({ llm, ...args });
    expect(result.status).toBe("ok");
    expect(prompts[1]).toContain("src/hayali.ts");

    const stubborn = scriptedLlm([hallucinated, hallucinated, hallucinated]);
    await expect(runDevReviewer({ llm: stubborn.llm, ...args })).rejects.toBeInstanceOf(
      RoleOutputError,
    );
  });

  it("returns a clean review unchanged", async () => {
    const { llm } = scriptedLlm([clean]);
    const result = await runDevReviewer({ llm, ...args });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.approved).toBe(true);
  });
});

describe("toReviewResult", () => {
  it("flattens findings into the workflow activity shape", () => {
    expect(toReviewResult(DevReviewOutput.parse(withFinding))).toEqual({
      approved: false,
      findings: [
        "[major] src/credit/limit-controller.ts:@@ -0,0 +1,4 @@ — Uç yetkilendirme kontrolü yapmıyor. → Yetki kontrolünü ekle.",
      ],
    });
  });
});
