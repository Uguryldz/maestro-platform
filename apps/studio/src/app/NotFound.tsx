import type { ReactNode } from "react";
import { Link } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";

export function NotFound(): ReactNode {
  const t = useT();
  return (
    <EmptyState
      icon="🧭"
      title={t("error.route_not_found")}
      description={t("error.route_not_found_hint")}
      action={
        <Link to="/dash">
          <Button variant="primary">{t("action.back_to_dash")}</Button>
        </Link>
      }
    />
  );
}
