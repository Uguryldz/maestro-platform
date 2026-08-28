import { describe, expect, it } from "vitest";
import { renderAnalysisMarkdown, type DocContext } from "../src/documents.js";
import { escapeXml, markdownToStorage } from "../src/storage-format.js";
import { ANALYSIS, RUN_ID, TICKET, fakeTranslate } from "./helpers.js";

const ctx: DocContext = { translate: fakeTranslate(), locale: "tr", runId: RUN_ID, ticketKey: TICKET };

describe("markdown → Confluence storage format", () => {
  it("maps blocks to the storage subset", () => {
    expect(markdownToStorage("## Baslik\n\nmetin\n\n- a\n- b")).toBe(
      "<h2>Baslik</h2>\n<p>metin</p>\n<ul><li>a</li><li>b</li></ul>",
    );
  });

  it("keeps ordered lists ordered", () => {
    expect(markdownToStorage("1. bir\n2. iki")).toBe("<ol><li>bir</li><li>iki</li></ol>");
  });

  it("renders code inside a code macro with a CDATA body", () => {
    expect(markdownToStorage("```ts\nconst a = 1 < 2;\n```")).toBe(
      '<ac:structured-macro ac:name="code" ac:schema-version="1">' +
        '<ac:parameter ac:name="language">ts</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[const a = 1 < 2;]]></ac:plain-text-body>" +
        "</ac:structured-macro>",
    );
  });

  it("drops a language that is not a plain identifier", () => {
    const html = markdownToStorage('```ts"><script>\ncode\n```');
    expect(html).not.toContain("script");
    expect(html).not.toContain("ac:parameter");
  });

  it("escapes markup that arrived inside the document", () => {
    const html = markdownToStorage('metin <script>alert("x")</script> & <ac:structured-macro/>');
    expect(html).toBe(
      "<p>metin &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;ac:structured-macro/&gt;</p>",
    );
  });

  it("does not let code content close the CDATA section", () => {
    const html = markdownToStorage("```\n]]></ac:plain-text-body><script>evil</script>\n```");
    expect(html).toContain("]]]]><![CDATA[>");
    expect(html.endsWith("]]></ac:plain-text-body></ac:structured-macro>")).toBe(true);
    // Exactly one macro: the injected closing tag did not open a second one.
    expect(html.match(/<ac:structured-macro/g)).toHaveLength(1);
  });

  it("renders safe links as anchors and unsafe ones as text", () => {
    expect(markdownToStorage("[bag](https://wiki.test/a)")).toBe('<p><a href="https://wiki.test/a">bag</a></p>');
    expect(markdownToStorage("[bag](javascript:alert(1))")).toBe("<p>bag (javascript:alert(1))</p>");
  });

  it("escapes the quote that would break out of an href attribute", () => {
    expect(escapeXml('https://x.test/a"onload="evil')).toBe("https://x.test/a&quot;onload=&quot;evil");
  });

  it("skips the M83 marker comment and empty blocks", () => {
    expect(markdownToStorage("<!-- maestro:doc kind=analysis -->\n\n<!-- x -->")).toBe("");
  });

  it("converts a whole analysis document into balanced storage markup", () => {
    const html = markdownToStorage(renderAnalysisMarkdown(ANALYSIS, ctx));
    expect(html).toContain("<h1>");
    expect(html.match(/<h2>/g)).toHaveLength(8); // 7 mandatory sections + clarifications
    expect(html).toContain("Limit 50.000 TL üzerine çıkamaz");
    expect(html.match(/<ul>/g)?.length).toBe(html.match(/<\/ul>/g)?.length);
    expect(html).not.toContain("maestro:doc");
  });
});
