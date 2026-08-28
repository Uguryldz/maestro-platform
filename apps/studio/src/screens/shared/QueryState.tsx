import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, EmptyState, Skeleton } from "../../ui/index.ts";

/**
 * Loading / error / empty in one place, because all three must be handled on
 * every screen and hand-rolling the triple is how one of them goes missing.
 *
 * The error branch renders `t(messageKeyOf(error))` and never the thrown value:
 * the BFF sends `{ error: "<code>" }` with no prose, and a raw string reaching
 * the DOM is the regression this wrapper exists to prevent.
 */
export interface QueryStateProps {
  readonly isPending: boolean;
  readonly error: unknown;
  /** True when the request succeeded but produced nothing to show. */
  readonly isEmpty?: boolean;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly emptyIcon?: string;
  readonly onRetry?: () => void;
  readonly skeletonRows?: number;
  readonly children: ReactNode;
}

export function QueryState({
  isPending,
  error,
  isEmpty = false,
  emptyTitle,
  emptyDescription,
  emptyIcon = "📭",
  onRetry,
  skeletonRows = 4,
  children,
}: QueryStateProps): ReactNode {
  const t = useT();

  if (isPending) return <Skeleton rows={skeletonRows} />;

  if (error !== null && error !== undefined) {
    return (
      <EmptyState
        icon="⚠"
        title={t("state.error.title")}
        description={t(messageKeyOf(error))}
        {...(onRetry === undefined
          ? {}
          : { action: <Button onClick={onRetry}>{t("action.retry")}</Button> })}
      />
    );
  }

  if (isEmpty) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle ?? t("empty.no_data")}
        {...(emptyDescription === undefined ? {} : { description: emptyDescription })}
      />
    );
  }

  return <>{children}</>;
}

/**
 * The state shown where the mock has a panel but the BFF has no endpoint yet.
 * It says "not available", not "nothing happened" — a screen that renders an
 * inviting empty list for data it never asked for is lying about the system.
 */
export function NotAvailable({ detailKey }: { readonly detailKey?: string }): ReactNode {
  const t = useT();
  return (
    <EmptyState
      icon="🚧"
      title={t("state.unavailable.title")}
      description={detailKey === undefined ? t("state.unavailable.hint") : t(detailKey)}
    />
  );
}
