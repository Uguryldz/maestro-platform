import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Modal } from "../../ui/index.ts";
import type { DraftSection } from "./model.ts";
import "./template.css";

export interface TemplatePreviewProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly name: string;
  readonly version: number;
  readonly sections: readonly DraftSection[];
}

/**
 * Structural preview of the template: this is the SHAPE the analyst output is
 * validated against, rendered from the section definitions and their few-shot
 * examples. It deliberately shows the author's own example text — never an
 * invented analysis — so the preview cannot be mistaken for real output.
 */
export function TemplatePreview({
  open,
  onClose,
  name,
  version,
  sections,
}: TemplatePreviewProps): ReactNode {
  const t = useT();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("template.preview_title", { name, version: String(version) })}
      closeLabel={t("action.close")}
      footer={<Button onClick={onClose}>{t("action.close")}</Button>}
    >
      <p className="tpl-preview__desc">{t("template.preview_hint")}</p>
      <div className="tpl-preview">
        {sections.map((section, index) => (
          <div className="tpl-preview__sec" key={section.id}>
            <div className="tpl-preview__hd">
              <b>
                {index + 1}. {section.title}
              </b>
              <Badge tone={section.required ? "red" : "amber"}>
                {section.required ? t("template.required") : t("template.optional")}
              </Badge>
              <Badge tone="gray">{t(`template.format.${section.format}`)}</Badge>
            </div>
            {section.description !== "" && (
              <p className="tpl-preview__desc">{section.description}</p>
            )}
            <p className="tpl-preview__ex">
              {section.example === "" ? t("template.no_example") : section.example}
            </p>
          </div>
        ))}
      </div>
    </Modal>
  );
}
