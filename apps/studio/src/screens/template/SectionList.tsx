import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button } from "../../ui/index.ts";
import type { DraftSection } from "./model.ts";
import "./template.css";

export interface SectionListProps {
  readonly sections: readonly DraftSection[];
  readonly selectedId: string | null;
  readonly canRemove: boolean;
  readonly onSelect: (id: string) => void;
  readonly onMove: (id: string, delta: number) => void;
  readonly onRemove: (id: string) => void;
}

/**
 * Ordered list of sections. The order IS the document order, so the up/down
 * controls are the primary interaction and are real buttons (keyboard first)
 * rather than drag-only affordances.
 */
export function SectionList({
  sections,
  selectedId,
  canRemove,
  onSelect,
  onMove,
  onRemove,
}: SectionListProps): ReactNode {
  const t = useT();

  return (
    <ol className="tpl-list">
      {sections.map((section, index) => (
        <li key={section.id}>
          <div className={`tpl-row${section.id === selectedId ? " tpl-row--sel" : ""}`}>
            <button
              type="button"
              className="tpl-row__pick"
              aria-current={section.id === selectedId}
              onClick={() => onSelect(section.id)}
            >
              <span className="tpl-row__num">{index + 1}</span>
              <span className="tpl-row__body">
                <span className="tpl-row__title">{section.title}</span>
                <span className="tpl-row__meta">
                  <Badge tone={section.required ? "red" : "amber"}>
                    {section.required ? t("template.required") : t("template.optional")}
                  </Badge>
                  <Badge tone="gray">{t(`template.format.${section.format}`)}</Badge>
                  <code className="tpl-row__key">{section.key}</code>
                </span>
              </span>
            </button>
            <span className="tpl-row__tools">
              <Button
                size="sm"
                aria-label={t("template.move_up_of", { title: section.title })}
                disabled={index === 0}
                onClick={() => onMove(section.id, -1)}
              >
                ↑
              </Button>
              <Button
                size="sm"
                aria-label={t("template.move_down_of", { title: section.title })}
                disabled={index === sections.length - 1}
                onClick={() => onMove(section.id, 1)}
              >
                ↓
              </Button>
              <Button
                size="sm"
                variant="danger"
                aria-label={t("template.remove_of", { title: section.title })}
                disabled={!canRemove}
                onClick={() => onRemove(section.id)}
              >
                ✕
              </Button>
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
