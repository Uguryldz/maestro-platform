import type { ImpactCell } from "@maestro/contracts";
import type { AnalysisOutput, OpenItem, SourceEntry } from "./schema-builder.js";
import type { AnalysisTemplate, TemplateSection } from "./template.js";
import { DEFAULT_PROMPT_TEXTS, type PromptTexts, text } from "./texts.js";

/**
 * Markdown rendering of a templated analysis. It is the source the publisher
 * (M47) and the Word/PDF driver (M103r) consume, and it is also how a
 * table-shaped section becomes the plain text that `AnalysisDoc` expects.
 * Section order and headings come from the template, never from this file.
 */

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  return [head, rule, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

export function renderSectionValue(
  section: TemplateSection,
  value: unknown,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): string {
  if (value === undefined) return text(texts, "bolum.degisiklikYok");

  switch (section.format) {
    case "free_text":
      return String(value);
    case "bullet_list":
      return (value as string[]).map((v) => `- ${v}`).join("\n");
    case "field_group": {
      const obj = value as Record<string, string>;
      return (section.subFields ?? [])
        .map((f) => `**${f.label}:** ${obj[f.key] ?? ""}`)
        .join("\n\n");
    }
    case "list_group": {
      const obj = value as Record<string, string[]>;
      return (section.subLists ?? [])
        .map((l) => `**${l.label}**\n${(obj[l.key] ?? []).map((v) => `- ${v}`).join("\n")}`)
        .join("\n\n");
    }
    case "table": {
      const columns = section.columns ?? [];
      const rows = (value as Record<string, string>[]).map((r) => columns.map((c) => r[c] ?? ""));
      return table(columns, rows);
    }
    case "impact_matrix": {
      const headers = [
        text(texts, "tablo.uygulama"),
        text(texts, "tablo.etkileniyor"),
        text(texts, "tablo.ozet"),
        text(texts, "tablo.kaynak"),
      ];
      const rows = (value as ImpactCell[]).map((c) => [
        c.appId,
        text(texts, c.impacted ? "tablo.evet" : "tablo.hayir"),
        c.summary,
        c.source,
      ]);
      return table(headers, rows);
    }
    case "source_list": {
      const headers = [
        text(texts, "tablo.bolum"),
        text(texts, "tablo.iddia"),
        text(texts, "tablo.tur"),
        text(texts, "tablo.referans"),
      ];
      const rows = (value as SourceEntry[]).map((s) => [s.section, s.claim, s.kind, s.ref]);
      return table(headers, rows);
    }
    case "open_items": {
      const items = value as OpenItem[];
      if (items.length === 0) return text(texts, "tablo.bos");
      const headers = [
        text(texts, "tablo.madde"),
        text(texts, "tablo.nedenAcik"),
        text(texts, "tablo.sorumlu"),
      ];
      return table(
        headers,
        items.map((i) => [i.item, i.why, i.owner ?? "-"]),
      );
    }
  }
}

/** The whole document: numbered sections plus the run-level fields. */
export function renderAnalysisMarkdown(
  template: AnalysisTemplate,
  output: AnalysisOutput,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): string {
  const sections = template.sections.map((section, i) => {
    const body = renderSectionValue(section, output.sections[section.key], texts);
    return `## ${i + 1}. ${section.title}\n\n${body}`;
  });

  const footer = [
    `**${text(texts, "belge.risk")}:** ${output.riskTier}`,
    `**${text(texts, "belge.riskGerekce")}:** ${output.riskReason}`,
    `**${text(texts, "belge.netlestirmeler")}:** ${
      output.clarificationsUsed.join(", ") || text(texts, "tablo.bos")
    }`,
    `**${text(texts, "belge.sablonSurumu")}:** ${template.name} ${template.version}`,
  ].join("\n\n");

  return [...sections, footer].join("\n\n");
}
