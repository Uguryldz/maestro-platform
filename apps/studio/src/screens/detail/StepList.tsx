import type { ReactNode } from "react";
import { STEP_IDS, type WorkflowRunState } from "@maestro/contracts";
import { useT } from "../../i18n/I18nProvider.tsx";

/**
 * The nineteen delivery steps, with the run's position marked.
 *
 * The order and the ids come from `STEP_IDS` in packages/contracts — this list
 * is not allowed to keep its own copy, because a screen that drifts from the
 * workflow's step table shows a person the wrong stage of their own work.
 */
export function StepList({ run }: { readonly run: WorkflowRunState }): ReactNode {
  const t = useT();
  const currentIndex = STEP_IDS.indexOf(run.step);

  return (
    <div className="screen-steps">
      {STEP_IDS.map((step, index) => {
        const state = phaseOf(index, currentIndex);
        return (
          <div key={step} className={`screen-step screen-step--${state}`}>
            <span className="screen-step__num">{step}</span>
            <span className="screen-step__title">{t(`steps.${step}`)}</span>
            <span className="screen-step__state">
              {t(stateKey(state, run.status))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type Phase = "done" | "now" | "wait";

function phaseOf(index: number, currentIndex: number): Phase {
  if (currentIndex === -1) return "wait";
  if (index < currentIndex) return "done";
  return index === currentIndex ? "now" : "wait";
}

/**
 * What to say beside a step. Only the CURRENT step reflects run status; a
 * finished step is finished regardless of what happened later.
 */
function stateKey(phase: Phase, status: WorkflowRunState["status"]): string {
  if (phase === "done") return "step.state.done";
  if (phase === "wait") return "step.state.waiting";
  return `step.state.current.${status}`;
}
