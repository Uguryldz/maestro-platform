import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, Card } from "../../ui/index.ts";
import { setWebhookAcked, type SetupState } from "../dash/setup-state.ts";
import "../shared/screens.css";

/**
 * The "where do I start" checklist — on the KURULUM SİHİRBAZI.
 *
 * It lived on the Panel, above the numbers, which was the wrong screen: the
 * Panel is a report, and an operator opening it to see what their platform did
 * overnight was met with a tutorial for work they may have finished weeks ago.
 * The five steps it lists are the five things the setup surfaces DO, so it now
 * sits at the top of the wizard, where somebody is already doing them. The
 * Panel keeps one line saying setup is open, with a link here.
 *
 * Only the LOCATION changed. It still appears whenever a step is open (see
 * `useSetupState`) and steps aside once everything is done; it still keeps its
 * two localStorage keys, so an operator who dismissed it from the old Panel
 * does not find it back. The class names stay `dash-start__*` because the
 * styles are the same styles — renaming them would be churn with no behaviour
 * behind it.
 *
 * Each step reports its OWN real state, so this is a live checklist rather than
 * a static tutorial: a checked step stays checked and the FIRST unfinished step
 * is highlighted as "do this next". The webhook step is the exception — nothing
 * reports whether Jira holds the registration, so the operator ticks it off
 * themselves and that acknowledgement is remembered locally.
 */

interface StepDef {
  readonly key: string;
  readonly done: boolean;
  readonly to: string;
}

export function StartGuide({
  setup,
  onDismiss,
  onWebhookAck,
}: {
  readonly setup: SetupState;
  readonly onDismiss: () => void;
  readonly onWebhookAck: (value: boolean) => void;
}): ReactNode {
  const t = useT();
  const navigate = useNavigate();

  /**
   * The order is the order the work has to happen in: wire the connections,
   * bind a project (the ready-made listening rules come with it), register the
   * webhook so Jira actually pushes the ticket, train the agents, then watch.
   * The webhook sits at 3 because without it nothing ever arrives — a trained
   * agent with no delivery path is a silent platform.
   */
  const steps: readonly StepDef[] = [
    { key: "step1", done: setup.hasConn, to: "/settings" },
    { key: "step2", done: setup.hasBinding, to: "/projects?tab=onboard" },
    /**
     * Ticket intake: EITHER path satisfies it.
     *
     * A Jira webhook is the better one when the operator can register it —
     * instant, no polling. A sweep is the answer when they cannot, which is
     * most banks. Marking this done only on the webhook told a perfectly
     * working polling install that it was missing a step it did not need.
     */
    { key: "webhook", done: setup.hasWebhook || setup.hasSweep, to: "/listening" },
    { key: "step3", done: setup.hasTrainedAgent, to: "/variants" },
    { key: "step4", done: false, to: "/dash" }, // "watch" — the goal, never auto-checked
  ];
  const nextIdx = steps.findIndex((s) => !s.done);

  return (
    <Card title={t("dash.start.title")} subtitle={t("dash.start.sub")}>
      <ol className="dash-start">
        {steps.map((step, i) => {
          const isNext = i === nextIdx;
          return (
            <li key={step.key} className="dash-start__item">
              <button
                type="button"
                className={
                  "dash-start__step" +
                  (step.done ? " dash-start__step--done" : "") +
                  (isNext ? " dash-start__step--next" : "")
                }
                onClick={() => void navigate(step.to)}
              >
                <span className="dash-start__mark" aria-hidden="true">
                  {step.done ? "✓" : i + 1}
                </span>
                <span className="dash-start__body">
                  <span className="dash-start__label">{t(`dash.start.${step.key}.title`)}</span>
                  <span className="dash-start__hint">{t(`dash.start.${step.key}.hint`)}</span>
                </span>
                {isNext && <span className="dash-start__cta">{t("dash.start.do_this")}</span>}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="dash-start__foot">
        {/* The webhook is the one step no endpoint can verify, so the operator
            confirms it. Kept a plain checkbox rather than a step button: it
            records a fact, it does not navigate. */}
        <label className="dash-start__ack">
          <input
            type="checkbox"
            checked={setup.hasWebhook}
            onChange={(e) => {
              setWebhookAcked(e.target.checked);
              onWebhookAck(e.target.checked);
            }}
          />
          <span>{t("dash.start.webhook.ack")}</span>
        </label>

        {/* "Hide" is a display preference, never a completion claim: the steps
            above still read false, and the Panel keeps saying setup is open. */}
        <Button variant="default" size="sm" onClick={onDismiss}>
          {t("dash.start.dismiss")}
        </Button>
      </div>
      {!setup.complete && <p className="screen-note">{t("dash.start.dismiss_note")}</p>}
    </Card>
  );
}
