import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Card } from "../../ui/index.ts";
import type { DryRunResult } from "../common/index.ts";

export interface DryRunPanelProps {
  readonly result: DryRunResult | null;
  readonly busy: boolean;
  /** False until the draft names both a project and a repository. */
  readonly ready: boolean;
  readonly onRun: () => void;
}

/**
 * The mandatory dry run (M102): where would the last N tickets have landed
 * under these rules?
 *
 * The three buckets are shown separately and the unresolved one is named
 * outright, because "2 tickets match no rule" is the finding — a routing table
 * that silently drops them, or worse guesses, is the failure M14/M99 exists to
 * prevent. An empty result renders as "not run yet", never as "all clear": the
 * absence of a preview is not evidence that the rules are right.
 */
export function DryRunPanel({ result, busy, ready, onRun }: DryRunPanelProps): ReactNode {
  const t = useT();

  return (
    <Card
      title={t("onboard.card.dry_run")}
      subtitle={t("onboard.card.dry_run_sub")}
      actions={
        <Button size="sm" variant="primary" busy={busy} disabled={!ready} onClick={onRun}>
          {t("onboard.action.dry_run")}
        </Button>
      }
    >
      {result === null ? (
        <p className="scr-mini">{ready ? t("onboard.dry_run.not_run") : t("onboard.dry_run.pick_first")}</p>
      ) : (
        <>
          <div className="scr-row">
            <Badge tone="green">
              {t("onboard.dry_run.by_rule", { count: String(result.byRule.length) })}
            </Badge>
            <Badge tone="amber">
              {t("onboard.dry_run.by_suggestion", { count: String(result.bySuggestion.length) })}
            </Badge>
            <Badge tone="red">
              {t("onboard.dry_run.unresolved", { count: String(result.unresolved.length) })}
            </Badge>
          </div>

          {result.unresolved.length > 0 && (
            <div className="scr-note scr-note--warn" style={{ marginTop: 11 }}>
              {t("onboard.dry_run.unresolved_detail", { tickets: result.unresolved.join(", ") })}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
