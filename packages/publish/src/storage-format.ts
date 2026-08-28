import { parseMarkdown, safeHref, type Block, type Inline } from "./parse.js";

/**
 * Confluence storage format: an XHTML subset plus `ac:` macros. Written by
 * hand (no new dependency) and deliberately narrow — every value that came
 * from a ticket, a model or a user is escaped, so no published document can
 * inject markup, a macro or a script into a corporate wiki page.
 */
export function markdownToStorage(source: string): string {
  return parseMarkdown(source)
    .map(renderBlock)
    .filter((html) => html.length > 0)
    .join("\n");
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      return `<h${String(level)}>${renderInline(block.inline)}</h${String(level)}>`;
    }
    case "paragraph": {
      const inner = renderInline(block.inline);
      return inner.length > 0 ? `<p>${inner}</p>` : "";
    }
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items.map((item) => `<li>${renderInline(item)}</li>`).join("");
      return items.length > 0 ? `<${tag}>${items}</${tag}>` : "";
    }
    case "code":
      return renderCodeMacro(block.language, block.text);
  }
}

const LANGUAGE = /^[a-z0-9#+-]{1,20}$/i;

function renderCodeMacro(language: string | null, text: string): string {
  const parameter =
    language && LANGUAGE.test(language)
      ? `<ac:parameter ac:name="language">${escapeXml(language)}</ac:parameter>`
      : "";
  return (
    `<ac:structured-macro ac:name="code" ac:schema-version="1">${parameter}` +
    `<ac:plain-text-body><![CDATA[${escapeCdata(text)}]]></ac:plain-text-body>` +
    `</ac:structured-macro>`
  );
}

function renderInline(inline: Inline[]): string {
  return inline
    .map((node) => {
      switch (node.kind) {
        case "text":
          return escapeXml(node.text);
        case "strong":
          return `<strong>${escapeXml(node.text)}</strong>`;
        case "code":
          return `<code>${escapeXml(node.text)}</code>`;
        case "link": {
          const href = safeHref(node.href);
          return href
            ? `<a href="${escapeXml(href)}">${escapeXml(node.text)}</a>`
            : escapeXml(`${node.text} (${node.href})`);
        }
      }
    })
    .join("");
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * `]]>` inside code would close the CDATA section and hand the rest of the
 * document to the parser as markup. Splitting the sequence across two sections
 * keeps the bytes intact and the section closed where we closed it.
 */
function escapeCdata(value: string): string {
  return value.replace(/]]>/g, "]]]]><![CDATA[>");
}
