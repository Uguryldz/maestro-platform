import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Card, EmptyState, Input, Select } from "../../ui/index.ts";
import { TextArea } from "../shared/TextArea.tsx";
import { SECTION_FORMATS, type DraftSection, type SectionFormat, type TemplateSection } from "./model.ts";
import "./template.css";

export interface SectionEditorProps {
  readonly section: DraftSection | undefined;
  readonly index: number;
  readonly onChange: <K extends keyof TemplateSection>(
    id: string,
    field: K,
    value: TemplateSection[K],
  ) => void;
}

/**
 * Editor for one section. Every field here is part of the contract the server
 * turns into a Zod schema: title (display), key (schema identity, derived),
 * format (shape), required (fail-closed), aiInstruction and example (prompt).
 */
export function SectionEditor({ section, index, onChange }: SectionEditorProps): ReactNode {
  const t = useT();

  if (section === undefined) {
    return (
      <Card title={t("template.editor_title_empty")}>
        <EmptyState icon="👈" title={t("template.pick_section")} />
      </Card>
    );
  }

  return (
    <Card
      title={t("template.editor_title", { n: String(index + 1), title: section.title })}
      subtitle={t("template.editor_subtitle")}
    >
      <div className="tpl-editor">
        <Input
          label={t("template.field.title")}
          value={section.title}
          onChange={(event) => onChange(section.id, "title", event.target.value)}
        />

        <Select
          label={t("template.field.format")}
          value={section.format}
          onChange={(event) =>
            onChange(section.id, "format", event.target.value as SectionFormat)
          }
          options={SECTION_FORMATS.map((format) => ({
            value: format,
            label: t(`template.format.${format}`),
          }))}
          hint={t(`template.format_hint.${section.format}`)}
        />

        <Input
          label={t("template.field.description")}
          value={section.description}
          onChange={(event) => onChange(section.id, "description", event.target.value)}
          hint={t("template.field.description_hint")}
        />

        <TextArea
          label={t("template.field.ai_instruction")}
          rows={5}
          value={section.aiInstruction}
          onChange={(event) => onChange(section.id, "aiInstruction", event.target.value)}
          hint={t("template.field.ai_instruction_hint")}
        />

        <label className="tpl-check">
          <input
            type="checkbox"
            checked={section.required}
            onChange={(event) => onChange(section.id, "required", event.target.checked)}
          />
          <span>
            <b>{t("template.field.required")}</b>
            <span className="tpl-check__note">
              {section.required
                ? t("template.field.required_on_hint")
                : t("template.field.required_off_hint")}
            </span>
          </span>
        </label>

        <TextArea
          label={t("template.field.example")}
          rows={4}
          value={section.example}
          onChange={(event) => onChange(section.id, "example", event.target.value)}
          hint={t("template.field.example_hint")}
        />

        <p className="tpl-keyline">
          {t("template.key_is")} <code>{section.key}</code> ·{" "}
          {t("template.placeholder_is")} <code>{`{{bolum:${index + 1}}}`}</code>
        </p>
      </div>
    </Card>
  );
}
