import { parseMarkdown, safeHref, type Block, type Inline } from "./parse.js";

/**
 * Atlassian Document Format subset — the node set `WorkPort.addComment`
 * accepts ("ADF document or plain text"). Structural types only: this package
 * must not import the Jira adapter (M44 clean room), the two meet at the port.
 */
export type AdfMark = { type: "strong" } | { type: "code" } | { type: "link"; attrs: { href: string } };

export interface AdfText {
  type: "text";
  text: string;
  marks?: AdfMark[];
}

export interface AdfBlock {
  type: "paragraph" | "heading" | "codeBlock" | "bulletList" | "listItem";
  attrs?: Record<string, string | number>;
  content?: AdfNode[];
}

export type AdfNode = AdfText | AdfBlock;

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

/** Markdown source → ADF document, ready for `WorkPort.addComment`. */
export function markdownToAdf(source: string): AdfDoc {
  return { type: "doc", version: 1, content: parseMarkdown(source).map(toNode) };
}

function toNode(block: Block): AdfNode {
  switch (block.kind) {
    case "heading":
      return {
        type: "heading",
        attrs: { level: Math.min(Math.max(block.level, 1), 6) },
        content: toInline(block.inline, false),
      };
    case "code": {
      const attrs = block.language ? { language: block.language } : undefined;
      const content = block.text.length > 0 ? [{ type: "text" as const, text: block.text }] : [];
      return { type: "codeBlock", ...(attrs ? { attrs } : {}), content };
    }
    case "list":
      // Rendered as a bullet list even when the source was numbered: the DC
      // wiki renderer has no ordered-list node in this subset, and an unknown
      // node type would flatten the items into one unreadable line. The number
      // is kept as text so nothing is lost.
      return {
        type: "bulletList",
        content: block.items.map((item, index) => ({
          type: "listItem" as const,
          content: [
            {
              type: "paragraph" as const,
              content: toInline(block.ordered ? prefixNumber(item, index + 1) : item, false),
            },
          ],
        })),
      };
    case "paragraph":
      return { type: "paragraph", content: toInline(block.inline, true) };
  }
}

function prefixNumber(inline: Inline[], number: number): Inline[] {
  return [{ kind: "text", text: `${String(number)}. ` }, ...inline];
}

function toInline(inline: Inline[], blockStartsALine: boolean): AdfNode[] {
  const out: AdfNode[] = [];
  let atLineStart = blockStartsALine;
  for (const node of inline) {
    if (node.text.length === 0) continue; // ADF forbids empty text nodes.
    const text = defuseWikiMarkup(node.text, atLineStart && node.kind === "text");
    atLineStart = false;
    switch (node.kind) {
      case "text":
        out.push({ type: "text", text });
        break;
      case "strong":
        out.push({ type: "text", text, marks: [{ type: "strong" }] });
        break;
      case "code":
        out.push({ type: "text", text, marks: [{ type: "code" }] });
        break;
      case "link": {
        const href = safeHref(node.href);
        out.push(
          href
            ? { type: "text", text, marks: [{ type: "link", attrs: { href } }] }
            : { type: "text", text: defuseWikiMarkup(`${node.text} (${node.href})`, false) },
        );
        break;
      }
    }
  }
  return out;
}

/**
 * Jira DC renders a comment from WIKI MARKUP, so an ADF text node is not the
 * literal it looks like: `h1.` at the start of a line is a real heading and
 * `!http://…/x.png!` is a real image macro. Neither is escaped downstream —
 * the adapter defuses `{}[]|` only — and the markdown writer's own escapes are
 * consumed on the way in (`parseInline` unescapes `\x`), so the text arrives
 * raw. Left alone, an analysis paragraph could forge Maestro's own approval
 * heading on a signed gate and load a tracking pixel from a bank-internal
 * comment (M105's class of defect).
 *
 * A backslash is the escape wiki markup itself defines, and it is what the
 * adapter already emits for braces and brackets, so the two agree.
 */
const LEADING_MARKER = /^(\s*)(h[1-6]\.|bq\.|-{4,}|[*#+-]|\d+\.)(?=\s|$)/i;
const IMAGE_MACRO = /!([^\s!][^!\n]{0,300})!/g;

export function defuseWikiMarkup(text: string, atLineStart: boolean): string {
  return text
    .split("\n")
    .map((line, index) => {
      const defused = line.replace(IMAGE_MACRO, (_m, inner: string) => `\\!${inner}\\!`);
      return index === 0 && !atLineStart
        ? defused
        : defused.replace(LEADING_MARKER, (_m, indent: string, marker: string) => `${indent}\\${marker}`);
    })
    .join("\n");
}
