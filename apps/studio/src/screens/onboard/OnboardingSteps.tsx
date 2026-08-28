import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Card, Select } from "../../ui/index.ts";
import type {
  JiraConnection,
  JiraProject,
  OnboardingOptions,
  ScmConnection,
  ScmRepo,
} from "../common/index.ts";

export interface OnboardingDraft {
  /** The chosen Jira connection (cloud/dc) the project is listed from. */
  readonly jiraConnectionId: string;
  readonly jiraProject: string;
  /** The chosen SCM connection (github/ado) the repo is listed from. */
  readonly connectionId: string;
  /** "owner/repo" (GitHub) or "project/repo" (ADO) — the picked repository. */
  readonly repoFullName: string;
  readonly adoRepo: string;
  readonly platform: string;
  readonly triggerMode: "opt_in" | "automatic";
  readonly gateSet: "risk_tiered" | "always_six";
  readonly mergeMode: "human" | "auto";
}

/** The live SCM state step 1 renders: the connections, and the repos of the chosen one. */
export interface ScmPickerState {
  readonly connections: readonly ScmConnection[];
  readonly repos: readonly ScmRepo[];
  readonly reposLoading: boolean;
  /** A localized failure line for the repo listing, or null. */
  readonly reposError: string | null;
}

/** The live Jira state step 1 renders: the connections, and the projects of the chosen one. */
export interface JiraPickerState {
  readonly connections: readonly JiraConnection[];
  readonly projects: readonly JiraProject[];
  readonly projectsLoading: boolean;
  /** A localized failure line for the project listing, or null. */
  readonly projectsError: string | null;
}

export interface OnboardingStepsProps {
  readonly draft: OnboardingDraft;
  readonly options: OnboardingOptions;
  readonly scm: ScmPickerState;
  readonly jira: JiraPickerState;
  readonly onChange: (patch: Partial<OnboardingDraft>) => void;
}

/**
 * The onboarding form — ONE page, not a stepper. It used to be four wizard panes
 * (one of them, `.maestro.yaml`, had no field at all; another had a single
 * select), which put two nested progress bars on the screen and made an
 * operator ask "which step am I on". Now all the choices live on one scrollable
 * form under three headings, and `.maestro.yaml` is a one-line note rather than
 * a whole step.
 *
 * Every choice is still a Select over a server-supplied or closed list — never a
 * free-text field. A mistyped repository name would fail late or match the wrong
 * repository, and a project's ticket routing is not something to spell by hand.
 * The defaults are the safe ones: opt-in triggering, risk-tiered gates, human
 * merge.
 */
export function OnboardingSteps({
  draft,
  options,
  scm,
  jira,
  onChange,
}: OnboardingStepsProps): ReactNode {
  const t = useT();

  // Both the project and the repo Selects are fed LIVE from a chosen connection
  // — never a hard-coded list. Each has three faces the operator must tell
  // apart: no connection picked yet, loading, and a provider error.
  const projectLabel =
    draft.jiraConnectionId === ""
      ? t("onboard.jira.pick_connection_first")
      : jira.projectsLoading
        ? t("onboard.jira.loading")
        : jira.projectsError !== null
          ? jira.projectsError
          : jira.projects.length === 0
            ? t("onboard.jira.no_projects")
            : t("onboard.jira.choose");

  const repoLabel =
    draft.connectionId === ""
      ? t("onboard.scm.pick_connection_first")
      : scm.reposLoading
        ? t("onboard.scm.loading")
        : scm.reposError !== null
          ? scm.reposError
          : scm.repos.length === 0
            ? t("onboard.scm.no_repos")
            : t("onboard.field.choose");

  return (
    <Card title={t("onboard.card.jira")} subtitle={t("onboard.card.jira_sub")}>
      {/* 1 — Jira project + target repo */}
      <div className="scr-grid scr-grid--2">
        <Select
          label={t("onboard.field.jira_connection")}
          value={draft.jiraConnectionId}
          onChange={(event) => onChange({ jiraConnectionId: event.target.value, jiraProject: "" })}
          options={[
            { value: "", label: t("onboard.field.choose") },
            ...jira.connections.map((c) => ({ value: c.id, label: jiraConnLabel(c, t) })),
          ]}
          hint={t("onboard.field.jira_connection_hint")}
        />
        <Select
          label={t("onboard.field.jira_project")}
          value={draft.jiraProject}
          onChange={(event) => onChange({ jiraProject: event.target.value })}
          disabled={
            draft.jiraConnectionId === "" || jira.projectsLoading || jira.projects.length === 0
          }
          options={[
            { value: "", label: projectLabel },
            ...jira.projects.map((p: JiraProject) => ({
              value: p.key,
              label: `${p.key} · ${p.name}`,
            })),
          ]}
        />
      </div>
      <div className="scr-grid scr-grid--2" style={{ marginTop: 12 }}>
        <Select
          label={t("onboard.field.scm_connection")}
          value={draft.connectionId}
          onChange={(event) => onChange({ connectionId: event.target.value, repoFullName: "" })}
          options={[
            { value: "", label: t("onboard.field.choose") },
            ...scm.connections.map((c) => ({ value: c.id, label: connLabel(c, t) })),
          ]}
          hint={t("onboard.field.scm_connection_hint")}
        />
        <Select
          label={t("onboard.field.scm_repo")}
          value={draft.repoFullName}
          onChange={(event) => onChange({ repoFullName: event.target.value })}
          disabled={draft.connectionId === "" || scm.reposLoading || scm.repos.length === 0}
          options={[
            { value: "", label: repoLabel },
            ...scm.repos.map((r: ScmRepo) => ({ value: r.fullName, label: r.fullName })),
          ]}
        />
      </div>
      <div className="scr-note" style={{ marginTop: 12 }}>
        {t("onboard.note.no_silent_routing")}
      </div>

      {/* 2 — build environment (one select, no longer its own step) */}
      <h4 className="onb-group">{t("onboard.card.repo")}</h4>
      <Select
        label={t("onboard.field.platform")}
        value={draft.platform}
        onChange={(event) => onChange({ platform: event.target.value })}
        // A readable name per profile ("Node.js / web"), not the raw slug.
        options={withPlaceholder(options.platforms, t("onboard.field.choose"), (value) =>
          t(`platform.${value}`),
        )}
        hint={t("onboard.field.platform_hint")}
      />

      {/* 3 — gates + trigger */}
      <h4 className="onb-group">{t("onboard.card.gates")}</h4>
      <div className="scr-grid scr-grid--2">
        <Select
          label={t("onboard.field.trigger_mode")}
          value={draft.triggerMode}
          onChange={(event) =>
            onChange({ triggerMode: event.target.value as OnboardingDraft["triggerMode"] })
          }
          options={[
            { value: "opt_in", label: t("onboard.trigger.opt_in") },
            { value: "automatic", label: t("onboard.trigger.automatic") },
          ]}
          hint={t("onboard.field.trigger_hint")}
        />
        <Select
          label={t("onboard.field.gate_set")}
          value={draft.gateSet}
          onChange={(event) =>
            onChange({ gateSet: event.target.value as OnboardingDraft["gateSet"] })
          }
          options={[
            { value: "risk_tiered", label: t("onboard.gate_set.risk_tiered") },
            { value: "always_six", label: t("onboard.gate_set.always_six") },
          ]}
        />
        <Select
          label={t("onboard.field.merge_mode")}
          value={draft.mergeMode}
          onChange={(event) =>
            onChange({ mergeMode: event.target.value as OnboardingDraft["mergeMode"] })
          }
          options={[
            { value: "human", label: t("onboard.merge.human") },
            { value: "auto", label: t("onboard.merge.auto") },
          ]}
          hint={t("onboard.field.merge_hint")}
        />
      </div>

      {/* `.maestro.yaml` was a whole empty step; now it is the one-line fact it
          always was — the file is proposed as a PR after approval. */}
      <div className="scr-note" style={{ marginTop: 12 }}>
        {t("onboard.yaml.oneliner")}
      </div>
    </Card>
  );
}

/**
 * An unselected Select must not silently mean "the first option". The empty
 * placeholder makes "nothing chosen" a state the submit guard can see, rather
 * than a project binding nobody picked.
 */
function withPlaceholder(
  values: readonly string[],
  placeholder: string,
  labelOf: (value: string) => string = (value) => value,
): readonly { value: string; label: string }[] {
  return [
    { value: "", label: placeholder },
    ...values.map((value) => ({ value, label: labelOf(value) })),
  ];
}

/** A connection's label: its display name plus the provider it is. */
function connLabel(c: ScmConnection, t: (key: string) => string): string {
  return `${c.displayName} · ${t(`onboard.scm.kind.${c.kind}`)}`;
}

/** A Jira connection's label: its display name plus the Jira flavour it is. */
function jiraConnLabel(c: JiraConnection, t: (key: string) => string): string {
  return `${c.displayName} · ${t(`onboard.jira.kind.${c.kind}`)}`;
}
