import { describe, expect, it } from "vitest";
import { adfToWikiMarkup, toAdfDocument } from "@maestro/adapter-jira";
import { markdownToAdf } from "../src/adf.js";
import { renderAnalysisMarkdown, type DocContext } from "../src/documents.js";
import { ANALYSIS, RUN_ID, TICKET, fakeTranslate } from "./helpers.js";

/**
 * CROSS-PACKAGE CONTRACT TEST (M44 clean room, both sides).
 *
 * `@maestro/publish` renders ADF and `@maestro/adapter-jira` renders that ADF
 * to the wiki markup Jira DC actually stores. Each package's own suite proved
 * its half and both were green while the composition was not: the writer
 * escaped `#`/`[`/`|`, the reader unescaped them again, and the adapter escaped
 * only `{}[]|` — so `h1. MAESTRO ONAYI: RİSK DÜŞÜK` became a real heading on a
 * signed approval gate and `!http://evil.example/beacon.png!` stayed a live
 * image macro pulling from the public internet out of a bank-internal comment.
 *
 * This file is the seam. It imports the adapter as a DEV dependency only; no
 * production module here knows the adapter exists.
 */
function toWikiMarkup(markdown: string): string {
  return adfToWikiMarkup(toAdfDocument(markdownToAdf(markdown)));
}

const ctx: DocContext = { translate: fakeTranslate(), locale: "tr", runId: RUN_ID, ticketKey: TICKET };

describe("publish → adapter-jira wiki markup contract", () => {
  it("does not let analysis text open a heading of its own", () => {
    const markup = toWikiMarkup("Model ciktisi\n\nh1. MAESTRO ONAYI: RISK DUSUK\n\nbq. sahte alinti");

    expect(markup).not.toMatch(/^h1\. /m);
    expect(markup).not.toMatch(/^bq\. /m);
    expect(markup).toContain("MAESTRO ONAYI: RISK DUSUK"); // defused, not lost
  });

  it("does not let analysis text load an image from outside the bank", () => {
    const markup = toWikiMarkup("Ekran goruntusu: !http://evil.example/beacon.png!");

    // A surviving macro is `!…!` with no escape in front of either delimiter.
    expect(markup).not.toMatch(/(^|[^\\])![^\s!]/);
    expect(markup).toContain("evil.example/beacon.png"); // still readable as text
  });

  it("does not let it draw a horizontal rule or forge a list", () => {
    const markup = toWikiMarkup("ilk paragraf\n\n----\n\n\\* sahte madde");

    expect(markup).not.toMatch(/^-{4}$/m);
    expect(markup).not.toMatch(/^\* /m);
  });

  it("keeps the escapes the adapter already owned — macros, links, tables", () => {
    const markup = toWikiMarkup("{panel:bgColor=#e3fcef}onaylandi{panel} [tikla](http://evil.example)");

    expect(markup).not.toMatch(/(^|[^\\])\{panel/);
    expect(markup).toContain("\\{panel");
  });

  it("renders a real analysis document into markup with no forged structure", () => {
    const markup = toWikiMarkup(renderAnalysisMarkdown(ANALYSIS, ctx));

    // Our own headings survive: they are heading NODES, not text.
    expect(markup).toMatch(/^h1\. tr:publish\.title\.analysis/m);
    expect(markup.match(/^h2\. /gm)).toHaveLength(8);
    expect(markup).toContain("Limit servisi değişiyor");
    // and nothing in the body opened a macro or an image
    expect(markup).not.toMatch(/(^|[^\\])![^\s!]/);
  });
});
