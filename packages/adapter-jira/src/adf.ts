import { JiraResponseError } from "./errors.js";

/**
 * Minimal Atlassian Document Format model — just the node set analysis and
 * gate comments need (M75). ADF is our canonical in-core comment format; the
 * DC wire format is wiki markup, so `adfToWikiMarkup` renders on the way out
 * (M46: "wiki-markup/ADF differences follow DC"). A future Cloud driver posts
 * the same document verbatim to REST v3.
 */

export type AdfMark = { type: "strong" } | { type: "code" } | { type: "link"; attrs: { href: string } };

export interface AdfText {
  type: "text";
  text: string;
  marks?: AdfMark[];
}

export interface AdfBlock {
  type: "paragraph" | "heading" | "codeBlock" | "panel" | "bulletList" | "listItem";
  attrs?: Record<string, string | number>;
  content?: AdfNode[];
}

export type AdfNode = AdfText | AdfBlock;

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

export type PanelType = "info" | "note" | "warning" | "success" | "error";

export function text(value: string, marks?: AdfMark[]): AdfText {
  return marks && marks.length > 0 ? { type: "text", text: value, marks } : { type: "text", text: value };
}

export function strong(value: string): AdfText {
  return text(value, [{ type: "strong" }]);
}

export function inlineCode(value: string): AdfText {
  return text(value, [{ type: "code" }]);
}

export function link(label: string, href: string): AdfText {
  return text(label, [{ type: "link", attrs: { href } }]);
}

/** `paragraph("plain")` or `paragraph([strong("bold"), text(" rest")])`. */
export function paragraph(content: string | AdfNode[]): AdfBlock {
  return { type: "paragraph", content: typeof content === "string" ? [text(content)] : content };
}

export function heading(level: 1 | 2 | 3 | 4 | 5 | 6, value: string): AdfBlock {
  return { type: "heading", attrs: { level }, content: [text(value)] };
}

export function codeBlock(value: string, language?: string): AdfBlock {
  return {
    type: "codeBlock",
    ...(language ? { attrs: { language } } : {}),
    content: [text(value)],
  };
}

export function panel(panelType: PanelType, content: AdfNode[]): AdfBlock {
  return { type: "panel", attrs: { panelType }, content };
}

/** Acceptance criteria / impact lists in analysis comments. */
export function bulletList(items: (string | AdfNode[])[]): AdfBlock {
  return {
    type: "bulletList",
    content: items.map((item) => ({ type: "listItem", content: [paragraph(item)] }) satisfies AdfBlock),
  };
}

export function doc(...content: AdfNode[]): AdfDoc {
  return { type: "doc", version: 1, content };
}

/** True for `{ type: "doc", content: [...] }` — the shape callers may hand us. */
export function isAdfDoc(value: unknown): value is AdfDoc {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; content?: unknown };
  return candidate.type === "doc" && Array.isArray(candidate.content);
}

/**
 * Accept what WorkPort.addComment accepts: an ADF document, or a plain string
 * that gets wrapped into paragraphs (blank line = new paragraph).
 */
export function toAdfDocument(body: unknown): AdfDoc {
  if (isAdfDoc(body)) return { type: "doc", version: 1, content: body.content };
  if (typeof body === "string") {
    const blocks = body
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter((block) => block.length > 0)
      .map((block) => paragraph(block));
    return doc(...(blocks.length > 0 ? blocks : [paragraph("")]));
  }
  throw new JiraResponseError("comment body", ["expected an ADF document or a plain string"]);
}

/**
 * Flatten ADF to plain text. Cloud issue descriptions and polled comments
 * arrive as ADF, while TicketSnapshot.description and the command grammar
 * (commands.ts) speak plain text. Top-level blocks are joined with a blank
 * line, so the M105 "a bare command must be the whole comment" rule still
 * sees a second paragraph as trailing text.
 */
export function adfToPlainText(document: AdfDoc): string {
  return document.content
    .map((node) => flattenNode(node))
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
}

function flattenNode(node: AdfNode): string {
  if (node.type === "text") return node.text;
  // Widened on purpose (same as renderBlock): real documents carry node types
  // outside our model and they must degrade predictably, never disappear.
  const type = node.type as string;
  if (type === "hardBreak") return "\n";
  const children = (node.content ?? []).map((child) => flattenNode(child));
  switch (type) {
    case "paragraph":
    case "heading":
    case "codeBlock":
      return children.join("");
    default:
      // Unknown LEAF nodes (mention, emoji, media…) become a placeholder
      // instead of vanishing: invisible content must not let a comment like
      // "/approve @someone" flatten to a bare "/approve" (M105 fail-closed).
      if (children.length === 0) return "￼";
      // Container nodes (panel, lists, unknown blocks) stack their children.
      return children.filter((child) => child.length > 0).join("\n");
  }
}

/**
 * One visible line of an ADF document, tagged with whether its text may carry
 * a comment command (M105). Only the plain, unstyled text of a TOP-LEVEL
 * paragraph is command-capable: a blockquote reply, a code sample, a heading
 * or a code/link-styled "/approve" QUOTES a command instead of giving one.
 * The quoted text still comes back as a visible line, so the "bare command
 * must be the whole comment" check keeps seeing it as trailing content.
 */
export interface AdfLine {
  text: string;
  commandCapable: boolean;
}

export function adfToCommandLines(document: AdfDoc): AdfLine[] {
  const lines: AdfLine[] = [];
  for (const node of document.content) {
    if (node.type === "paragraph") {
      lines.push(...paragraphLines(node));
      continue;
    }
    // Any other block — heading, codeBlock, panel, blockquote, lists, unknown
    // containers — is context, never command text.
    for (const text of flattenNode(node).split("\n")) lines.push({ text, commandCapable: false });
  }
  return lines;
}

function paragraphLines(node: AdfBlock): AdfLine[] {
  const lines: AdfLine[] = [{ text: "", commandCapable: true }];
  for (const child of node.content ?? []) {
    if ((child.type as string) === "hardBreak") {
      lines.push({ text: "", commandCapable: true });
      continue;
    }
    const current = lines[lines.length - 1]!;
    if (child.type === "text") {
      current.text += child.text;
      // Styled text — code, link, strong, ANY mark — is never command text.
      if (child.marks && child.marks.length > 0) current.commandCapable = false;
      continue;
    }
    // Non-text inline content (mention, emoji, media…): visible placeholder,
    // and the line can no longer be a bare command.
    current.text += flattenNode(child);
    current.commandCapable = false;
  }
  return lines;
}

/**
 * Render ADF to Jira wiki markup, the only rich format REST v2 (DC) accepts.
 * Unknown node types degrade to their plain text rather than throwing — a
 * comment must never be lost because of a decoration we do not model.
 */
export function adfToWikiMarkup(document: AdfDoc): string {
  return document.content
    .map((node) => renderBlock(node, 0))
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function renderBlock(node: AdfNode, depth: number): string {
  if (node.type === "text") return renderInline([node]);

  // Widened on purpose: a document may carry node types we do not model, and
  // the default branch must stay reachable so they degrade to plain text.
  switch (node.type as string) {
    case "paragraph":
      return renderInline(node.content ?? []);
    case "heading": {
      const level = typeof node.attrs?.["level"] === "number" ? node.attrs["level"] : 2;
      return `h${level}. ${renderInline(node.content ?? [])}`;
    }
    case "codeBlock": {
      const language = node.attrs?.["language"];
      const open = typeof language === "string" && language.length > 0 ? `{code:${language}}` : "{code}";
      return `${open}\n${neutralizeFences(plainText(node.content ?? []))}\n{code}`;
    }
    case "panel": {
      const panelType = node.attrs?.["panelType"];
      const open = typeof panelType === "string" ? `{panel:bgColor=${PANEL_COLORS[panelType] ?? PANEL_COLORS["info"]}}` : "{panel}";
      const inner = (node.content ?? [])
        .map((child) => renderBlock(child, depth + 1))
        .filter((child) => child.length > 0)
        .join("\n");
      return `${open}\n${inner}\n{panel}`;
    }
    case "bulletList": {
      const bullet = "*".repeat(depth + 1);
      return (node.content ?? [])
        .map((item) => `${bullet} ${renderBlock(item, depth + 1)}`)
        .join("\n");
    }
    case "listItem":
      return (node.content ?? [])
        .map((child) => renderBlock(child, depth))
        .filter((child) => child.length > 0)
        .join(" ");
    default:
      return renderInline(node.content ?? []);
  }
}

const PANEL_COLORS: Record<string, string> = {
  info: "#deebff",
  note: "#eae6ff",
  warning: "#fffae6",
  success: "#e3fcef",
  error: "#ffebe6",
};

function renderInline(nodes: AdfNode[]): string {
  return nodes
    .map((node) => {
      if (node.type !== "text") return renderBlock(node, 0);
      let out = escapeWikiText(node.text);
      for (const mark of node.marks ?? []) {
        if (mark.type === "strong") out = `*${out}*`;
        else if (mark.type === "code") out = `{{${out}}}`;
        else if (mark.type === "link") out = `[${out}|${sanitizeHref(mark.attrs.href)}]`;
      }
      return out;
    })
    .join("");
}

/**
 * Comment text is not ours: it carries ticket descriptions and model output.
 * Left raw, a `{panel}` or `[label|http://…]` inside it would render as real
 * markup, so anyone able to file a ticket could forge Maestro's own gate
 * comments. Escaping the macro/link/table openers keeps the text as text.
 */
function escapeWikiText(value: string): string {
  return value.replace(/[{}[\]|]/g, (char) => `\\${char}`);
}

/**
 * A `]`, `|` or brace in the URL would close the link early and inject markup.
 * None of them is legal in a URL unencoded, so dropping them is lossless.
 */
function sanitizeHref(href: string): string {
  return href.replace(/[[\]{}|\s]/g, "");
}

/** Code block content is literal — marks and escapes do not apply inside it. */
function plainText(nodes: AdfNode[]): string {
  return nodes.map((node) => (node.type === "text" ? node.text : plainText(node.content ?? []))).join("");
}

/**
 * Backslash escapes are NOT interpreted inside `{code}`, so the only way to
 * stop content from closing the fence early is to break the opening brace.
 * A literal Jira macro inside a code sample gains one space; an injected
 * `{code}{panel}…` loses its teeth.
 */
function neutralizeFences(value: string): string {
  return value.replace(/\{(?=code|noformat|panel|quote|color)/gi, "{ ");
}
