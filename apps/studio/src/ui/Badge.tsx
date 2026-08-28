import type { ReactNode } from "react";
import "./Badge.css";

export type BadgeTone = "blue" | "green" | "amber" | "red" | "purple" | "teal" | "orange" | "gray";

export interface BadgeProps {
  readonly tone?: BadgeTone;
  /** Small leading glyph or dot. */
  readonly icon?: ReactNode;
  /** Already-translated label. */
  readonly children: ReactNode;
}

/**
 * Mirrors `.tag` + `.t-*` from the mock. Used for run status, risk tier and
 * work mode. Pick the tone from the domain helpers below so the same concept
 * gets the same colour on every screen.
 */
export function Badge({ tone = "gray", icon, children }: BadgeProps) {
  return (
    <span className={`ui-badge ui-badge--${tone}`}>
      {icon !== undefined && <span aria-hidden="true">{icon}</span>}
      {children}
    </span>
  );
}

/**
 * Canonical tone per run status. Two different status vocabularies exist in the
 * BFF: RunSummary.status (Temporal-level) and WorkflowRunState.status
 * (domain-level). Both are covered here so screens never invent their own map.
 */
export function runStatusTone(status: string): BadgeTone {
  switch (status) {
    case "running":
      return "blue";
    case "gate":
      return "amber";
    case "fail":
    case "failed":
    case "terminated":
    case "timed_out":
      return "red";
    case "done":
    case "completed":
      return "green";
    case "handover":
      return "orange";
    case "queued":
    case "cancelled":
    case "continued_as_new":
      return "gray";
    default:
      return "gray";
  }
}

/** Risk tiers use Turkish domain literals on the wire: dusuk / orta / kritik. */
export function riskTone(risk: string): BadgeTone {
  switch (risk) {
    case "dusuk":
      return "green";
    case "orta":
      return "amber";
    case "kritik":
      return "red";
    default:
      return "gray";
  }
}

export function workModeTone(mode: string): BadgeTone {
  switch (mode) {
    case "full_auto":
      return "purple";
    case "ai_assist":
      return "teal";
    case "human_lead":
      return "orange";
    case "human_only":
      return "gray";
    default:
      return "gray";
  }
}
