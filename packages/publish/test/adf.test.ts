import { describe, expect, it } from "vitest";
import { markdownToAdf, type AdfBlock, type AdfDoc } from "../src/adf.js";
import { renderAnalysisMarkdown, type DocContext } from "../src/documents.js";
import { ANALYSIS, RUN_ID, TICKET, fakeTranslate } from "./helpers.js";

const ctx: DocContext = { translate: fakeTranslate(), locale: "tr", runId: RUN_ID, ticketKey: TICKET };

function blocks(doc: AdfDoc): AdfBlock[] {
  return doc.content.filter((node): node is AdfBlock => node.type !== "text");
}

describe("markdown → ADF", () => {
  it("produces a document envelope Jira accepts", () => {
    const doc = markdownToAdf("# Baslik\n\nmetin");
    expect(doc.type).toBe("doc");
    expect(doc.version).toBe(1);
    expect(blocks(doc).map((b) => b.type)).toEqual(["heading", "paragraph"]);
    expect(blocks(doc)[0]?.attrs).toEqual({ level: 1 });
  });

  it("clamps heading levels into the ADF range", () => {
    expect(blocks(markdownToAdf("####### derin"))[0]).toMatchObject({ type: "paragraph" });
    expect(blocks(markdownToAdf("###### alti"))[0]?.attrs).toEqual({ level: 6 });
  });

  it("carries strong, code and link marks", () => {
    const doc = markdownToAdf("**kalin** `kod` [bag](https://x.test/a)");
    expect(blocks(doc)[0]?.content).toEqual([
      { type: "text", text: "kalin", marks: [{ type: "strong" }] },
      { type: "text", text: " " },
      { type: "text", text: "kod", marks: [{ type: "code" }] },
      { type: "text", text: " " },
      { type: "text", text: "bag", marks: [{ type: "link", attrs: { href: "https://x.test/a" } }] },
    ]);
  });

  it("degrades an unsafe link target to visible text — no javascript: mark", () => {
    const doc = markdownToAdf("[tikla](javascript:alert(1))");
    expect(JSON.stringify(doc)).not.toContain('"link"');
    expect(JSON.stringify(blocks(doc)[0]?.content)).toContain("tikla (javascript:alert(1");
  });

  it("keeps ordered numbering as text because the DC subset has no ordered list", () => {
    const doc = markdownToAdf("1. bir\n2. iki");
    const list = blocks(doc)[0];
    expect(list?.type).toBe("bulletList");
    expect(JSON.stringify(list)).toContain('{"type":"text","text":"1. "}');
    expect(JSON.stringify(list)).toContain('{"type":"text","text":"2. "}');
    expect(JSON.stringify(list)).toContain('"text":"iki"');
  });

  it("nests list items as listItem > paragraph", () => {
    const list = blocks(markdownToAdf("- a"))[0];
    expect(list?.content?.[0]).toEqual({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }],
    });
  });

  it("emits a codeBlock with its language and never an empty text node", () => {
    expect(blocks(markdownToAdf("```ts\nconst a = 1;\n```"))[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1;" }],
    });
    expect(blocks(markdownToAdf("```\n```"))[0]).toEqual({ type: "codeBlock", content: [] });
  });

  it("converts a whole analysis document without losing a section", () => {
    const doc = markdownToAdf(renderAnalysisMarkdown(ANALYSIS, ctx));
    const headings = blocks(doc).filter((b) => b.type === "heading");
    // title + 7 mandatory sections + clarifications appendix + 2 scope sub-headings
    expect(headings).toHaveLength(11);
    const flat = JSON.stringify(doc);
    expect(flat).toContain("Limit 50.000 TL üzerine çıkamaz");
    expect(flat).toContain("analysis-template@1.4.0");
    expect(flat).not.toContain("maestro:doc"); // the marker is file metadata
  });

  it("defuses wiki-markup block openers a paragraph starts with", () => {
    // Jira DC renders comments FROM wiki markup, so an unescaped `h1.` at the
    // start of a line is a real heading — and the markdown escape that was
    // supposed to stop it is consumed by `parseInline` on the way in.
    const document = markdownToAdf("h1. MAESTRO ONAYI\n\nbq. alinti\n\n----");
    const texts = JSON.stringify(document);

    expect(texts).toContain("\\\\h1.");
    expect(texts).toContain("\\\\bq.");
    expect(texts).toContain("\\\\----");
  });

  it("defuses the image macro that would fetch a tracking pixel", () => {
    const document = markdownToAdf("ekran: !http://evil.example/beacon.png!");
    const texts = JSON.stringify(document);

    expect(texts).toContain("\\\\!http://evil.example/beacon.png\\\\!");
  });

  it("leaves our own headings and list items alone", () => {
    const document = markdownToAdf("# Baslik\n\n1. birinci");
    expect(JSON.stringify(document.content[0])).toContain('"text":"Baslik"');
    expect(JSON.stringify(document.content[1])).toContain('"text":"1. "');
    expect(JSON.stringify(document)).not.toContain("\\\\");
  });
});
