import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHref } from "../src/parse.js";

describe("markdown blocks", () => {
  it("reads headings with their level", () => {
    const blocks = parseMarkdown("# Bir\n\n### Uc");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, inline: [{ kind: "text", text: "Bir" }] },
      { kind: "heading", level: 3, inline: [{ kind: "text", text: "Uc" }] },
    ]);
  });

  it("joins wrapped paragraph lines and splits on a blank line", () => {
    const blocks = parseMarkdown("bir satir\ndevami\n\nikinci paragraf");
    expect(blocks).toEqual([
      { kind: "paragraph", inline: [{ kind: "text", text: "bir satir devami" }] },
      { kind: "paragraph", inline: [{ kind: "text", text: "ikinci paragraf" }] },
    ]);
  });

  it("reads bullet and ordered lists as separate blocks", () => {
    const blocks = parseMarkdown("- a\n- b\n\n1. bir\n2) iki");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: false });
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[1]).toMatchObject({ items: [[{ kind: "text", text: "bir" }], [{ kind: "text", text: "iki" }]] });
  });

  it("does not merge a bullet list into the ordered list that follows it", () => {
    const blocks = parseMarkdown("- a\n1. bir");
    expect(blocks.map((b) => (b.kind === "list" ? b.ordered : b.kind))).toEqual([false, true]);
  });

  it("folds an indented continuation line into the current list item", () => {
    const blocks = parseMarkdown("- ilk madde\n  devami");
    expect(blocks).toEqual([
      { kind: "list", ordered: false, items: [[{ kind: "text", text: "ilk madde devami" }]] },
    ]);
  });

  it("keeps fenced code verbatim, including its language and markdown inside", () => {
    const blocks = parseMarkdown("```ts\nconst a = 1; // **not bold**\n```");
    expect(blocks).toEqual([{ kind: "code", language: "ts", text: "const a = 1; // **not bold**" }]);
  });

  it("closes an unterminated fence at the end of the document instead of losing it", () => {
    expect(parseMarkdown("```\nyarim")).toEqual([{ kind: "code", language: null, text: "yarim" }]);
  });

  it("drops HTML comments — the M83 marker is file metadata, not page content", () => {
    const blocks = parseMarkdown("<!-- maestro:doc kind=analysis -->\n\n# Baslik");
    expect(blocks).toEqual([{ kind: "heading", level: 1, inline: [{ kind: "text", text: "Baslik" }] }]);
  });

  it("drops a multi-line comment without eating the content after it", () => {
    const blocks = parseMarkdown("<!-- bir\niki -->\nmetin");
    expect(blocks).toEqual([{ kind: "paragraph", inline: [{ kind: "text", text: "metin" }] }]);
  });

  it("ends an UNTERMINATED comment at its own line instead of swallowing the document", () => {
    // The whole document used to disappear behind one stray `<!--`, and the
    // drivers then published an empty ADF / an empty page under a receipt.
    const blocks = parseMarkdown("<!-- kapanmamis\n\n# Baslik\n\nmetin");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, inline: [{ kind: "text", text: "Baslik" }] },
      { kind: "paragraph", inline: [{ kind: "text", text: "metin" }] },
    ]);
  });

  it("drops characters XML cannot carry and controls that reverse what a reader sees", () => {
    // Model output quotes logs and terminal captures as a matter of routine:
    // a NUL and an ANSI colour code are permanent Confluence 400s, and U+202E
    // reverses the DISPLAY order of a risk verdict on a signed gate.
    const raw = "risk \u0000 d\u001b[31musuk\u202e ters\u200b";
    const blocks = parseMarkdown(raw);
    const text = blocks[0]?.kind === "paragraph" ? blocks[0].inline.map((n) => n.text).join("") : "";

    expect(text).toBe("risk  d[31musuk ters");
    for (const forbidden of ["\u0000", "\u001b", "\u202e", "\u200b"]) expect(text).not.toContain(forbidden);
  });

  it("degrades syntax it does not model to plain text instead of dropping it", () => {
    const blocks = parseMarkdown("> alinti\n\n| a | b |");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "paragraph"]);
    const first = blocks[0];
    expect(first?.kind === "paragraph" ? first.inline.map((n) => n.text).join("") : "").toBe("> alinti");
  });
});

describe("inline runs", () => {
  it("reads bold, code and links", () => {
    expect(parseInline("**kalin** ve `kod` ve [bag](https://x.test/a)")).toEqual([
      { kind: "strong", text: "kalin" },
      { kind: "text", text: " ve " },
      { kind: "code", text: "kod" },
      { kind: "text", text: " ve " },
      { kind: "link", text: "bag", href: "https://x.test/a" },
    ]);
  });

  it("unescapes backslash escapes so an escaped marker stays literal text", () => {
    expect(parseInline("\\# baslik degil \\*yildiz\\*")).toEqual([
      { kind: "text", text: "# baslik degil *yildiz*" },
    ]);
  });

  it("leaves an unterminated marker as text", () => {
    expect(parseInline("**yarim kalin")).toEqual([{ kind: "text", text: "**yarim kalin" }]);
  });
});

describe("link safety", () => {
  it("accepts http, https and mailto", () => {
    expect(safeHref("https://wiki.test/x")).toBe("https://wiki.test/x");
    expect(safeHref(" http://wiki.test/x ")).toBe("http://wiki.test/x");
    expect(safeHref("mailto:po@ugurbank.corp")).toBe("mailto:po@ugurbank.corp");
  });

  it("refuses script, data and relative targets", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,x", "/wiki/x", "JavaScript:alert(1)"]) {
      expect(safeHref(href)).toBeNull();
    }
  });
});
