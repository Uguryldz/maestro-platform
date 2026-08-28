import { describe, expect, it } from "vitest";
import type { AnalysisDoc } from "@maestro/contracts";
import {
  renderAnalysisMarkdown,
  renderEvidenceSummaryMarkdown,
  renderReleaseNoteMarkdown,
  type DocContext,
} from "../src/documents.js";
import { PublishRenderError } from "../src/errors.js";
import { MSG, publishMessageKeys } from "../src/keys.js";
import { parseMarkdown } from "../src/parse.js";
import { ANALYSIS, EVIDENCE, RELEASE_NOTE, RUN_ID, TICKET, fakeTranslate } from "./helpers.js";

const ctx: DocContext = { translate: fakeTranslate(), locale: "tr", runId: RUN_ID, ticketKey: TICKET };

/**
 * The builder escapes markdown specials in EVERY string it places, catalog
 * text included — the stub's keys contain underscores, so the expected text
 * carries the same escapes a real catalog value would get.
 */
const esc = (text: string): string => text.replace(/_/g, "\\_");

describe("analysis document (M43)", () => {
  const markdown = renderAnalysisMarkdown(ANALYSIS, ctx);

  it("renders the seven mandatory sections in template order", () => {
    const order = [
      MSG.sectionPurpose,
      MSG.sectionScope,
      MSG.sectionImpact,
      MSG.sectionAcceptance,
      MSG.sectionUiApi,
      MSG.sectionTestApproach,
      MSG.sectionRisk,
    ].map((key) => markdown.indexOf(esc(`tr:${key}`)));

    expect(order.some((index) => index < 0)).toBe(false);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("pins the template version inside the document (M83)", () => {
    expect(markdown).toContain("analysis-template@1.4.0");
    expect(markdown.split("\n")[0]).toBe(
      "<!-- maestro:doc kind=analysis run=run-20260808-0001 template=analysis-template@1.4.0 -->",
    );
  });

  it("carries the impact matrix with its per-row source (M100)", () => {
    expect(markdown).toContain(esc("ugurpay — tr:publish.label.impacted (tr:publish.impact_source.primary_repo_discovery)"));
    expect(markdown).toContain(esc("ugurcrm — tr:publish.label.not_impacted (tr:publish.impact_source.repo_card)"));
  });

  it("labels the risk tier through the catalog, never as raw enum text", () => {
    expect(markdown).toContain(esc("tr:publish.risk_tier.orta"));
    expect(markdown).not.toMatch(/:\*\* orta$/m);
  });

  it("is a pure function of its input — the same analysis renders byte-identically", () => {
    expect(renderAnalysisMarkdown(ANALYSIS, ctx)).toBe(markdown);
    expect(markdown).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no generation timestamp
  });

  it("renders the requested language, not a hardcoded one (M59/M104)", () => {
    const english = renderAnalysisMarkdown(
      { ...ANALYSIS, language: "en" },
      { ...ctx, locale: "en" },
    );
    expect(english).toContain(esc("en:publish.section.purpose"));
    expect(english).not.toContain(esc("tr:publish.section.purpose"));
  });

  it("refuses a document whose language differs from the requested output language", () => {
    expect(() => renderAnalysisMarkdown({ ...ANALYSIS, language: "en" }, ctx)).toThrow(PublishRenderError);
  });

  it("refuses an analysis that is missing a mandatory section (fail-closed)", () => {
    const incomplete = { ...ANALYSIS } as Partial<AnalysisDoc>;
    delete incomplete.testApproach;
    expect(() => renderAnalysisMarkdown(incomplete as AnalysisDoc, ctx)).toThrow();
  });

  it("refuses an empty impact matrix", () => {
    expect(() => renderAnalysisMarkdown({ ...ANALYSIS, impactMatrix: [] }, ctx)).toThrow();
  });

  it("neutralises markdown injected through analysis text", () => {
    const hostile = renderAnalysisMarkdown(
      { ...ANALYSIS, purpose: "# Sahte başlık\n- sahte madde\n[a](javascript:alert(1))" },
      ctx,
    );
    const headings = parseMarkdown(hostile).filter((block) => block.kind === "heading");
    expect(headings.some((h) => h.inline.some((node) => node.text.includes("Sahte başlık")))).toBe(false);
    expect(parseMarkdown(hostile).some((b) => b.kind === "list" && b.items.some((i) => i[0]?.text.includes("sahte madde")))).toBe(
      false,
    );
    expect(hostile).toContain("\\# Sahte başlık");
  });

  it("marks an empty optional list instead of leaving a blank section", () => {
    const bare = renderAnalysisMarkdown({ ...ANALYSIS, clarificationsUsed: [], scope: { included: ["x"], excluded: [] } }, ctx);
    expect(bare).toContain(esc("tr:publish.label.none"));
  });
});

describe("evidence package summary", () => {
  const markdown = renderEvidenceSummaryMarkdown(EVIDENCE, ctx);

  it("lists every file with its digest, size and type", () => {
    expect(markdown).toContain(`analysis.md — 2048 B · text/markdown · sha256:${"a".repeat(64)}`);
    expect(markdown).toContain("diff.patch — 9012 B");
  });

  it("renders the approval chain with gate name, actor and signature sequence", () => {
    expect(markdown).toContain(esc("tr:steps.5 — tr:publish.decision.approve · tl.yilmaz@ugurbank.corp"));
    expect(markdown).toContain(esc("tr:publish.label.approval #7"));
  });

  it("states retention and object lock (M56/M57)", () => {
    expect(markdown).toContain(`${esc("tr:publish.label.retention_years")}:** 10`);
    expect(markdown).toContain(`${esc("tr:publish.label.object_lock")}:** ${esc("tr:publish.label.yes")}`);
  });

  it("refuses a package belonging to another run or ticket", () => {
    expect(() => renderEvidenceSummaryMarkdown({ ...EVIDENCE, runId: "run-other-00001" }, ctx)).toThrow(PublishRenderError);
    expect(() => renderEvidenceSummaryMarkdown({ ...EVIDENCE, ticketKey: "UGURPAY-999" }, ctx)).toThrow(
      PublishRenderError,
    );
  });

  it("renders deterministically", () => {
    expect(renderEvidenceSummaryMarkdown(EVIDENCE, ctx)).toBe(markdown);
  });
});

describe("release note draft (M91)", () => {
  const markdown = renderReleaseNoteMarkdown(RELEASE_NOTE, ctx);

  it("carries merge sha, PR, changes and doc update suggestions", () => {
    expect(markdown).toContain(RELEASE_NOTE.mergeSha);
    expect(markdown).toContain(`${esc("tr:publish.label.pull_request")}:** #42`);
    expect(markdown).toContain("Limit servisi eklendi");
    expect(markdown).toContain("Kullanım kılavuzu bölüm 4 güncellenmeli");
  });

  it("says publishing stays a human decision", () => {
    expect(markdown).toContain(esc("tr:publish.note.release_draft"));
  });

  it("refuses a draft for another ticket", () => {
    expect(() => renderReleaseNoteMarkdown({ ...RELEASE_NOTE, ticketKey: "UGURPAY-999" }, ctx)).toThrow(
      PublishRenderError,
    );
  });

  it("refuses a draft without a single change entry", () => {
    expect(() => renderReleaseNoteMarkdown({ ...RELEASE_NOTE, changes: [] }, ctx)).toThrow();
  });
});

describe("catalog discipline (M104)", () => {
  it("emits only keys the package declares — no hardcoded user-facing text", () => {
    const recorded: string[] = [];
    const recording: DocContext = { ...ctx, translate: fakeTranslate(recorded) };
    renderAnalysisMarkdown(ANALYSIS, recording);
    renderEvidenceSummaryMarkdown(EVIDENCE, recording);
    renderReleaseNoteMarkdown(RELEASE_NOTE, recording);

    const declared = new Set(publishMessageKeys());
    const undeclared = [...new Set(recorded)].filter((key) => !declared.has(key));

    expect(recorded.length).toBeGreaterThan(30);
    // Every emitted key is declared, so the composition root can verify catalog
    // completeness ahead of a run instead of failing at a human gate.
    expect(undeclared).toEqual([]);
  });

  it("declares every risk tier, impact source and decision it may need", () => {
    const declared = publishMessageKeys();
    for (const tier of ["dusuk", "orta", "kritik"]) expect(declared).toContain(`publish.risk_tier.${tier}`);
    for (const source of ["primary_repo_discovery", "repo_card"]) {
      expect(declared).toContain(`publish.impact_source.${source}`);
    }
    for (const decision of ["approve", "reject"]) expect(declared).toContain(`publish.decision.${decision}`);
    expect(new Set(declared).size).toBe(declared.length); // no duplicates
  });
});
