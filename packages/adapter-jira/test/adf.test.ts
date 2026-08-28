import { describe, expect, it } from "vitest";
import {
  adfToWikiMarkup,
  bulletList,
  codeBlock,
  doc,
  heading,
  inlineCode,
  isAdfDoc,
  JiraResponseError,
  link,
  panel,
  paragraph,
  strong,
  toAdfDocument,
} from "../src/index.js";

describe("ADF builders", () => {
  it("builds a document the way analysis comments need it", () => {
    const document = doc(
      heading(2, "Analiz hazır"),
      paragraph([strong("Amaç:"), { type: "text", text: " e-posta doğrulama" }]),
      bulletList(["kod 10 dk geçerli", "3 yanlış denemede kilit"]),
      codeBlock("const x = 1;", "javascript"),
      panel("warning", [paragraph("Risk: orta")]),
    );

    expect(isAdfDoc(document)).toBe(true);
    expect(document.version).toBe(1);
    expect(document.content).toHaveLength(5);
    expect(document.content[2]).toMatchObject({ type: "bulletList" });
  });

  it("wraps plain strings into paragraphs, splitting on blank lines", () => {
    const document = toAdfDocument("ilk paragraf\n\nikinci paragraf");
    expect(document.content).toHaveLength(2);
    expect(document.content[0]).toMatchObject({ type: "paragraph", content: [{ text: "ilk paragraf" }] });
  });

  it("passes an existing ADF document through", () => {
    const source = doc(paragraph("x"));
    expect(toAdfDocument(source)).toEqual(source);
  });

  it("rejects anything that is neither ADF nor a string", () => {
    expect(() => toAdfDocument(42)).toThrow(JiraResponseError);
    expect(() => toAdfDocument(null)).toThrow(JiraResponseError);
  });

  it("keeps empty strings as an empty paragraph rather than an empty doc", () => {
    expect(toAdfDocument("   ").content).toEqual([paragraph("")]);
  });
});

describe("wiki markup rendering (DC REST v2 speaks wiki markup)", () => {
  it("renders headings, marks, lists, code and panels", () => {
    const markup = adfToWikiMarkup(
      doc(
        heading(2, "Analiz"),
        paragraph([strong("Amaç:"), { type: "text", text: " limit kontrolü " }, inlineCode("maxLimit")]),
        bulletList(["ilk madde", "ikinci madde"]),
        codeBlock("SELECT 1;", "sql"),
        panel("info", [paragraph("Bilgi")]),
        paragraph([link("PR #902", "https://ado.internal.bank/pr/902")]),
      ),
    );

    expect(markup).toBe(
      [
        "h2. Analiz",
        "",
        "*Amaç:* limit kontrolü {{maxLimit}}",
        "",
        "* ilk madde\n* ikinci madde",
        "",
        "{code:sql}\nSELECT 1;\n{code}",
        "",
        "{panel:bgColor=#deebff}\nBilgi\n{panel}",
        "",
        "[PR #902|https://ado.internal.bank/pr/902]",
      ].join("\n"),
    );
  });

  it("renders a code block without a language", () => {
    expect(adfToWikiMarkup(doc(codeBlock("x")))).toBe("{code}\nx\n{code}");
  });

  // Ticket text and model output are untrusted: raw wiki markup inside them
  // would let a reporter forge Maestro's own gate comments.
  it("escapes macro and link openers in text it did not build", () => {
    const markup = adfToWikiMarkup(
      doc(paragraph("{panel:bgColor=#ffebe6}onaylandı{panel} [tıkla|http://evil.example]")),
    );

    expect(markup).toBe(
      "\\{panel:bgColor=#ffebe6\\}onaylandı\\{panel\\} \\[tıkla\\|http://evil.example\\]",
    );
  });

  it("keeps an injected fence from closing a code block early", () => {
    const markup = adfToWikiMarkup(doc(codeBlock("SELECT 1;\n{code}\n{panel}sahte{panel}")));

    expect(markup).toBe("{code}\nSELECT 1;\n{ code}\n{ panel}sahte{ panel}\n{code}");
    expect(markup.match(/^\{code\}$/gm)).toHaveLength(2);
  });

  it("does not let a crafted link href break out of the link", () => {
    const markup = adfToWikiMarkup(doc(paragraph([link("PR", "https://ado.internal.bank/pr/9]{panel}")])));
    expect(markup).toBe("[PR|https://ado.internal.bank/pr/9panel]");
  });
});
