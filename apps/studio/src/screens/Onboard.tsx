import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { issueDetailsOf, messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Button, Card, useToast } from "../ui/index.ts";
import {
  type DryRunResult,
  type JiraConnection,
  type JiraProjectsResult,
  type OnboardingOptions,
  type ScmConnection,
  type ScmReposResult,
} from "./common/index.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { DryRunPanel } from "./onboard/DryRunPanel.tsx";
import { type OnboardingDraft, OnboardingSteps } from "./onboard/OnboardingSteps.tsx";

const EMPTY_DRAFT: OnboardingDraft = {
  jiraConnectionId: "",
  jiraProject: "",
  connectionId: "",
  repoFullName: "",
  adoRepo: "",
  platform: "",
  triggerMode: "opt_in",
  gateSet: "risk_tiered",
  mergeMode: "human",
};

/**
 * Self-service onboarding (M93): connecting a new application to the platform.
 *
 * The wizard produces a PROPOSAL, not a live configuration. Its last step sends
 * a package — routing rule, a `.maestro.yaml` pull request, a draft pipeline —
 * for an admin to approve, because binding a Jira project to a repository
 * decides where an agent will be allowed to push code.
 *
 * The dry run (M102) is a precondition, not a preview. Until the operator has
 * seen where the last N tickets WOULD have landed under these rules, the submit
 * button stays disabled: a routing rule that silently sends the wrong project's
 * tickets into a payment repository is exactly the mistake this step exists to
 * catch (M14/M99).
 */
/**
 * Does this draft name a COMPLETE repository half?
 *
 * All three or none: `DraftBody` refuses `adoRepo` without `platform` (and the
 * reverse), so a draft that has picked a repo but left the platform select on
 * its placeholder must send neither — otherwise it posts `platform: ""` and
 * comes back 400 `invalid_onboarding_body`, which is a dead end an operator
 * cannot read. An analysis-only draft answers false and sends no repo at all.
 */
function repoComplete(draft: OnboardingDraft): boolean {
  return draft.repoFullName !== "" && draft.connectionId !== "" && draft.platform !== "";
}

export function OnboardScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();

  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  /**
   * The field-level violations of a refused submit (a validation 400's
   * `details.issues`). Kept beside the button rather than only in a toast: a
   * toast fades in four seconds, and "hangi alan?" is exactly the question the
   * bare `invalid_onboarding_body` used to leave unanswerable.
   */
  const [submitIssues, setSubmitIssues] = useState<readonly string[]>([]);

  const options = useQuery({
    queryKey: ["onboarding-options"],
    queryFn: ({ signal }) => api.get<OnboardingOptions>("/onboarding/options", { signal }),
  });

  // The Jira connections the project can be picked from (cloud/dc) — read off
  // the managed connector list, so the wizard offers exactly what is wired. The
  // binding table is empty until a first project is bound, so LIVE Jira is the
  // only place the first project can be picked from.
  const jiraConnections = useQuery({
    queryKey: ["onboarding-jira-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly JiraConnection[] }>("/onboarding/jira-connections", { signal }),
  });

  // The projects of the CHOSEN Jira connection, read LIVE. Enabled only once a
  // connection is picked.
  const jiraProjects = useQuery({
    queryKey: ["onboarding-jira-projects", draft.jiraConnectionId],
    enabled: draft.jiraConnectionId !== "",
    queryFn: ({ signal }) =>
      api.get<JiraProjectsResult>(
        `/onboarding/jira-projects?connectionId=${encodeURIComponent(draft.jiraConnectionId)}`,
        { signal },
      ),
  });

  // The SCM connections the repo can be picked from (github/ado) — read off the
  // managed connector list, so the wizard offers exactly what is wired.
  const scmConnections = useQuery({
    queryKey: ["onboarding-scm-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly ScmConnection[] }>("/onboarding/scm-connections", { signal }),
  });

  // The repos of the CHOSEN connection, read LIVE. Enabled only once a
  // connection is picked, so no call fires on an empty selection.
  const scmRepos = useQuery({
    queryKey: ["onboarding-scm-repos", draft.connectionId],
    enabled: draft.connectionId !== "",
    queryFn: ({ signal }) =>
      api.get<ScmReposResult>(
        `/onboarding/scm-repos?connectionId=${encodeURIComponent(draft.connectionId)}`,
        { signal },
      ),
  });

  const runDryRun = useMutation({
    mutationFn: (input: OnboardingDraft) =>
      api.post<DryRunResult>("/onboarding/dry-run", {
        jiraProject: input.jiraProject,
        // The picked repo travels in `adoRepo` (the wire field the BFF reads).
        // Omitted entirely when there is none: the rehearsal is about the
        // project, and an empty string is refused by the schema.
        ...(input.repoFullName === "" ? {} : { adoRepo: input.repoFullName }),
      }),
    onSuccess: (result) => setDryRun(result),
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const submit = useMutation({
    mutationFn: (input: OnboardingDraft) =>
      // Faz C: send the shape the BFF's strict DraftBody accepts today — the
      // picked repo in `adoRepo`. Faz D widens the endpoint to take the
      // connection + repo and register a real application.
      api.post<{ proposalId: string }>("/onboarding", {
        jiraProject: input.jiraProject,
        /**
         * Sent together or not at all — `DraftBody` refuses one without the
         * other, and an analysis-only draft sends neither.
         *
         * Keyed on the COMPLETE half rather than on the repo name alone: a
         * draft that names a repo but whose platform select was returned to
         * its placeholder would otherwise post `platform: ""` and come back
         * 400 `invalid_onboarding_body`, a dead end the operator cannot read.
         */
        ...(repoComplete(input) ? { adoRepo: input.repoFullName, platform: input.platform } : {}),
        triggerMode: input.triggerMode,
        gateSet: input.gateSet,
        mergeMode: input.mergeMode,
      }),
    onSuccess: () => {
      setDraft(EMPTY_DRAFT);
      setDryRun(null);
      setSubmitIssues([]);
      toast.show("success", t("onboard.toast.submitted"));
    },
    onError: (error) => {
      // The toast carries the sentence; the violated fields (when the 400
      // named them) stay on screen under the submit button.
      setSubmitIssues(issueDetailsOf(error));
      toast.show("error", t(messageKeyOf(error)));
    },
  });

  // A new draft invalidates the evidence: the dry run answered a question about
  // the OLD rules, and showing it beside changed ones would authorise a
  // configuration nobody actually previewed.
  const update = (patch: Partial<OnboardingDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    setDryRun(null);
    // A changed draft invalidates a complaint about the previous one too.
    setSubmitIssues([]);
  };

  // The live SCM state step 1 renders. A failure body (`ok:false`) becomes a
  // localized line; the loading flag drives the "yükleniyor" placeholder.
  const reposBody = scmRepos.data;
  const scm = {
    connections: scmConnections.data?.connections ?? [],
    repos: reposBody?.ok === true ? reposBody.repos : [],
    reposLoading: draft.connectionId !== "" && scmRepos.isFetching,
    reposError:
      reposBody !== undefined && reposBody.ok === false
        ? t(reposBody.messageKey, reposBody.messageParams ?? {})
        : null,
  };

  // The live Jira state, the same shape as `scm` for the project picker.
  const projectsBody = jiraProjects.data;
  const jira = {
    connections: jiraConnections.data?.connections ?? [],
    projects: projectsBody?.ok === true ? projectsBody.projects : [],
    projectsLoading: draft.jiraConnectionId !== "" && jiraProjects.isFetching,
    projectsError:
      projectsBody !== undefined && projectsBody.ok === false
        ? t(projectsBody.messageKey, projectsBody.messageParams ?? {})
        : null,
  };

  /**
   * A repository is an ENRICHMENT, not a gate.
   *
   * This screen used to require a repo and a platform, so an analysis-only
   * install — the whole point of which is that it owns no repository — could
   * never submit: the SCM select was empty, `connectionId` stayed `""`, and the
   * button was dead forever under a warning naming a repo that could not be
   * created. The BFF behind it already accepted a repo-less draft; only this
   * screen still demanded one.
   *
   * The pair is still all-or-nothing, because the wire contract is: a repo
   * without a platform (or the reverse) is refused by `DraftBody`.
   */
  const repoHalf = draft.repoFullName !== "" || draft.connectionId !== "" || draft.platform !== "";
  const repoHalfComplete = repoComplete(draft);
  const complete = draft.jiraProject !== "" && (!repoHalf || repoHalfComplete);
  const maySubmit = complete && dryRun !== null;

  return (
    <div className="scr-stack">
      {/* One short line of what this screen does — no four-step preamble. */}
      <Card title={t("onboard.intro.title")} subtitle={t("onboard.intro.sub")}>
        <p className="scr-prose">{t("onboard.intro.short")}</p>
      </Card>

      {/* One scrollable form (was a 4-pane stepper). `GET /onboarding/options`
          may be unbuilt — MaybeUnwired handles that. */}
      <MaybeUnwired
        isPending={options.isPending}
        error={options.error}
        onRetry={() => void options.refetch()}
      >
        {options.data !== undefined && (
          <OnboardingSteps
            draft={draft}
            options={options.data}
            scm={scm}
            jira={jira}
            onChange={update}
          />
        )}
      </MaybeUnwired>

      {/* Dry run + submit sit together at the bottom: run the mandatory check,
          then send. No back/next — every field is already on screen above. */}
      <DryRunPanel
        result={dryRun}
        busy={runDryRun.isPending}
        // The rehearsal replays a PROJECT's tickets against the routing rules;
        // it never touches a repository, and requiring one made the mandatory
        // check impossible for an analysis-only draft.
        ready={draft.jiraProject !== ""}
        onRun={() => runDryRun.mutate(draft)}
      />

      <Card title={t("onboard.card.actions")}>
        <Button
          variant="success"
          busy={submit.isPending}
          disabled={!maySubmit}
          onClick={() => submit.mutate(draft)}
        >
          {t("onboard.action.submit")}
        </Button>
        {submitIssues.length > 0 && (
          <div className="scr-note scr-note--danger" style={{ marginTop: 11 }}>
            {t("onboard.error.refused_fields")}
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {submitIssues.map((issue) => (
                <li key={issue} className="scr-mono">
                  {issue}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!maySubmit && (
          <div className="scr-note scr-note--warn" style={{ marginTop: 11 }}>
            {complete ? t("onboard.blocked.dry_run") : t("onboard.blocked.incomplete")}
          </div>
        )}
        <div className="scr-note" style={{ marginTop: 11 }}>
          {t("onboard.note.admin_approval")}
        </div>
      </Card>
    </div>
  );
}
