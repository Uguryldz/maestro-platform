import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Card } from "../../ui/index.ts";
import { matchValueLabel } from "../common/jira-english.ts";
import { STATUS_POINTS, buildStatusMap } from "../common/status-map.ts";
import { bindsNoRepository, flowDefaults, type SetupDraft } from "./model.ts";

/**
 * Step 5 — "Özet & kaydet".
 *
 * Written as SENTENCES, not a key/value dump of the draft. The operator is
 * about to authorise two writes against a bank's Jira and a bank's repository;
 * "gateSet: always_six" tells them nothing about that, whereas "Her PR için altı
 * kontrol de çalışır" does. Every line here is derived from the draft rather
 * than typed by the panes, so a summary that says something the wizard will not
 * actually do is a bug in one place instead of five.
 */

export interface ReviewPaneProps {
  readonly draft: SetupDraft;
  /**
   * Whether the project is ALREADY bound. A second rule on a bound project
   * skips the four-eyes proposal entirely, and the summary must say which of
   * the two things is about to happen — "onay bekleyecek" on a binding that is
   * already live reads as a failure to the operator who then goes looking for
   * an approval queue that has nothing in it.
   */
  readonly alreadyBound: boolean;
}

export function ReviewPane({ draft, alreadyBound }: ReviewPaneProps): ReactNode {
  const t = useT();
  const defaults = flowDefaults(draft.flowType);
  // Flow-aware: `buildStatusMap` writes only the points `firesFor` says this
  // flow can reach, so a düzeltme draft holding a value at an analysis-approval
  // moment (typed before the flow was switched) never appears here. This
  // summary is what the operator SIGNS OFF ON — a line promising "Analiz onaya
  // çıktığında → İNCELEMEDE" on a rule whose flow has no analysis approval is
  // a promise the engine will never keep.
  const statusMap = buildStatusMap(
    draft.statusOn,
    draft.statusDraft,
    draft.reassignOnNeedInfo,
    draft.flowType,
  );

  // The statuses the ticket will walk, in flow order, as "adım: durum" lines.
  // Built from STATUS_POINTS so a point added on the server cannot go missing
  // from the confirmation an operator signs off on.
  const mappedPoints = STATUS_POINTS.filter(
    (point) => typeof statusMap?.[point] === "string" && statusMap[point] !== "",
  );

  return (
    <Card title={t("setup.review.title")} subtitle={t("setup.review.sub")}>
      <p className="scr-prose">{t("setup.review.intro")}</p>

      {/* 1 — the listening rule, in one sentence an operator can check. The
          catch-all gets its OWN sentence rather than the conditioned one with an
          empty value spliced in: `değeri "" olan ticket'lar` is a sentence that
          describes nothing and would read as a bug in the summary. */}
      <h4 className="setup-review__h">{t("setup.review.rule_heading")}</h4>
      <p className="scr-prose">
        {draft.matchKind === "assigned"
          ? t("setup.review.rule_sentence_assigned", {
              project: draft.jiraProject,
              flow: t(`setup.flow.name.${draft.flowType}`),
            })
          : t("setup.review.rule_sentence", {
              project: draft.jiraProject,
              kind: t(`setup.tickets.kind.${draft.matchKind}`),
              // The stored value, with the English name in the same aside the
              // rest of the platform uses — so what the operator signs off on
              // reads the same as what the listening table will show.
              value: matchValueLabel(draft.matchValue.trim()),
              flow: t(`setup.flow.name.${draft.flowType}`),
            })}
      </p>
      <p className="scr-note">{t(`setup.flow.desc.${draft.flowType}`)}</p>

      {/* 2 — what the ticket does on the board. Two mutually exclusive answers,
          and the comment-only one is stated outright rather than left as the
          absence of a section. */}
      <h4 className="setup-review__h">{t("setup.review.status_heading")}</h4>
      {statusMap === null ? (
        <p className="scr-prose">{t("setup.review.status_comment_only")}</p>
      ) : (
        <>
          <ul className="setup-review__list">
            {mappedPoints.map((point) => (
              <li key={point}>
                {t(`setup.status.point.${point}`)}: <b>{statusMap[point]}</b>
              </li>
            ))}
            {statusMap.reassignOnNeedInfo === true && <li>{t("setup.status.reassign")}</li>}
          </ul>
          <p className="scr-note">{t("setup.review.status_note")}</p>
        </>
      )}

      {/* 3 — the binding: repo, build profile, and the three derived answers the
          operator never had to give. */}
      <h4 className="setup-review__h">{t("setup.review.binding_heading")}</h4>
      {alreadyBound ? (
        <p className="scr-prose">
          {t("setup.review.binding_exists", { project: draft.jiraProject })}
        </p>
      ) : (
        <>
          {/* Which MODE the binding is in, stated honestly: the ticket-text
              sentence and the repo sentence are different promises, and the
              operator is signing off on one of them. A summary that showed the
              repo line with an empty {repo} — or said nothing at all — would
              hide the single most consequential fact of an analysis-only
              setup: Maestro will never look at any code. */}
          <p className="scr-prose">
            {bindsNoRepository(draft)
              ? t("setup.review.binding_sentence_norepo", { project: draft.jiraProject })
              : t("setup.review.binding_sentence", {
                  project: draft.jiraProject,
                  repo: draft.repoFullName,
                  platform: t(`platform.${draft.platform}`),
                })}
          </p>
          <ul className="setup-review__list">
            <li>{t(`setup.review.trigger.${defaults.triggerMode}`)}</li>
            <li>{t(`setup.review.gates.${defaults.gateSet}`)}</li>
            <li>{t(`setup.review.merge.${defaults.mergeMode}`)}</li>
            {/* The data class, in the same list as the other three derived
                facts — but this one the operator ANSWERED, and it is the only
                item here that can stop analysis from running at all, so the
                summary states its consequence rather than its name. */}
            <li>{t(`setup.review.dataclass.${draft.dataClass}`)}</li>
          </ul>
          {/* The four-eyes fact, stated BEFORE the button rather than as a toast
              afterwards. An operator who submits and sees nothing appear on the
              projects list concludes the wizard failed; the point of saying it
              here is that they expect the wait. */}
          <div className="scr-note scr-note--warn" style={{ marginTop: 10 }}>
            {t("setup.review.four_eyes")}
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * What to do once the writes have gone through — rendered in place of the form
 * after a successful save.
 *
 * A wizard that ends with a green toast leaves its user on a page they have no
 * more use for, wondering whether anything happened. This ends with the two
 * concrete next actions instead: open a ticket that matches the rule, and
 * assign it to the bot.
 */
export interface DonePaneProps {
  readonly draft: SetupDraft;
  /** True when a binding proposal was filed and is waiting for a second admin. */
  readonly awaitingApproval: boolean;
}

export function DonePane({ draft, awaitingApproval }: DonePaneProps): ReactNode {
  const t = useT();
  return (
    <Card title={t("setup.done.title")} subtitle={t("setup.done.sub")}>
      <p className="scr-prose">{t("setup.done.rule_created")}</p>
      {awaitingApproval && (
        <div className="scr-note scr-note--warn" style={{ marginTop: 10 }}>
          {t("setup.done.awaiting_approval")}
        </div>
      )}
      <h4 className="setup-review__h">{t("setup.done.next_heading")}</h4>
      <ol className="setup-review__list">
        <li>
          {draft.matchKind === "assigned"
            ? t("setup.done.next_open_ticket_assigned", { project: draft.jiraProject })
            : t("setup.done.next_open_ticket", {
                project: draft.jiraProject,
                kind: t(`setup.tickets.kind.${draft.matchKind}`),
                value: matchValueLabel(draft.matchValue.trim()),
              })}
        </li>
        <li>{t("setup.done.next_assign")}</li>
        <li>{t("setup.done.next_watch")}</li>
      </ol>
    </Card>
  );
}
