import type { ReactNode } from "react";
import { useT } from "../i18n/I18nProvider.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { screenById } from "./screens.ts";

/**
 * What an unbuilt screen renders. Every stub in src/screens/ returns this; a
 * screen agent deletes it as the first act of building the real thing.
 */
export function Placeholder({ id }: { readonly id: string }): ReactNode {
  const t = useT();
  const screen = screenById(id);
  const title = screen === undefined ? id : t(screen.titleKey);

  return (
    <EmptyState
      icon="🚧"
      title={title}
      description={t("screen.placeholder.description", { screen: id })}
    />
  );
}
