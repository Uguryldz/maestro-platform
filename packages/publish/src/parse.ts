/**
 * Markdown reader for the subset this package writes (headings, paragraphs,
 * bullet/ordered lists, fenced code, `**bold**`, `` `code` ``, links) plus
 * whatever a model may have added. Unknown syntax degrades to plain text
 * instead of throwing: a published document must never be lost to a
 * decoration we do not model.
 *
 * Written here rather than pulled in as a dependency because both renderers
 * (ADF for Jira, storage format for Confluence) must escape from the SAME
 * parse, and because the package takes no new runtime dependency.
 */

import { stripUnsafeChars } from "./md.js";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; language: string | null; text: string };

const FENCE = /^\s*```(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const COMMENT_OPEN = /^\s*<!--/;

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  // Both renderers read from this parse, so the character filter belongs here
  // as well: a `markdownSource` the port was handed by someone else never saw
  // the writer's escape chain (F3/F11).
  const lines = stripUnsafeChars(source).split(/\r\n?|\n/);
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) });
      paragraph = [];
    }
    if (list) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items.map(parseInline) });
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      const language = (fence[1] ?? "").trim();
      blocks.push({ kind: "code", language: language.length > 0 ? language : null, text: body.join("\n") });
      continue;
    }

    // HTML comments carry our own markers (M83 template pin); they are metadata
    // for the file, not content for a Jira comment or a Confluence page.
    //
    // An UNTERMINATED `<!--` ends at its own line. Scanning to the end of the
    // document instead swallowed everything below it, and the drivers then
    // published an empty ADF/an empty page while reporting success — a single
    // stray `<!--` in model output was enough (F5).
    if (COMMENT_OPEN.test(line)) {
      flush();
      if (line.includes("-->")) continue;
      let close = i + 1;
      while (close < lines.length && !(lines[close] ?? "").includes("-->")) close += 1;
      if (close < lines.length) i = close;
      continue;
    }

    if (line.trim().length === 0) {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        inline: parseInline(heading[2] ?? ""),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      if (paragraph.length > 0) flush();
      const isOrdered = ordered !== null;
      if (list && list.ordered !== isOrdered) flush();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push((bullet?.[1] ?? ordered?.[1] ?? "").trim());
      continue;
    }

    // Continuation of the current list item, otherwise paragraph text.
    if (list && /^\s+\S/.test(line)) {
      const last = list.items.length - 1;
      if (last >= 0) list.items[last] = `${list.items[last] ?? ""} ${line.trim()}`;
      continue;
    }
    if (list) flush();
    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

const INLINE_TOKEN = /\\(.)|\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (value: string): void => {
    if (value.length === 0) return;
    const previous = out[out.length - 1];
    if (previous?.kind === "text") previous.text += value;
    else out.push({ kind: "text", text: value });
  };

  for (const match of text.matchAll(INLINE_TOKEN)) {
    push(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[1] !== undefined) push(match[1]);
    else if (match[2] !== undefined) out.push({ kind: "strong", text: match[2] });
    else if (match[3] !== undefined) out.push({ kind: "code", text: match[3] });
    else if (match[4] !== undefined && match[5] !== undefined) {
      out.push({ kind: "link", text: match[4], href: match[5] });
    }
  }
  push(text.slice(last));
  return out;
}

const SAFE_SCHEME = /^(?:https?:\/\/|mailto:)/i;

/**
 * Link targets come from model output and ticket text. Only http(s)/mailto
 * survive as links; anything else (`javascript:`, `data:`, a rendered macro)
 * is returned as null so the caller degrades it to plain text.
 */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return SAFE_SCHEME.test(trimmed) && !/[\s<>"]/.test(trimmed) ? trimmed : null;
}
