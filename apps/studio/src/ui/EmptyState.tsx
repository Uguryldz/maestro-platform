import type { ReactNode } from "react";
import "./EmptyState.css";

export interface EmptyStateProps {
  /** Already-translated headline, e.g. t("empty.no_runs"). */
  readonly title: string;
  /** Already-translated explanation of what to do next. */
  readonly description?: string;
  /** A call to action, usually a <Button>. */
  readonly action?: ReactNode;
  readonly icon?: ReactNode;
}

/** Mirrors the mock's `.note` dashed panel; the standard "nothing here" block. */
export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="ui-empty">
      {icon !== undefined && (
        <div className="ui-empty__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="ui-empty__title">{title}</p>
      {description !== undefined && <p className="ui-empty__desc">{description}</p>}
      {action !== undefined && <div className="ui-empty__action">{action}</div>}
    </div>
  );
}
