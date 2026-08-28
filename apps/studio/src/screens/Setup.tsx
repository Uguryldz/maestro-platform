import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, issueDetailsOf, messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Button, Card, useToast } from "../ui/index.ts";
import type {
  JiraConnection,
  JiraProjectsResult,
  OnboardingOptions,
  RoutingView,
  ScmConnection,
  ScmReposResult,
} from "./common/index.ts";
import { buildStatusMap } from "./common/status-map.ts";
import { StartGuide } from "./setup/StartGuide.tsx";
import {
  GUIDE_DISMISSED_KEY,
  readFlag,
  useSetupState,
  webhookAcked,
  writeFlag,
} from "./dash/setup-state.ts";
import { FlowPane, ProjectPane, StatusPane, TicketsPane } from "./setup/SetupPanes.tsx";
import type { PaneData } from "./setup/SetupPanes.tsx";
import { DonePane, ReviewPane } from "./setup/ReviewPane.tsx";
import {
  ASSIGNED_MATCH_VALUE,
  EMPTY_SETUP_DRAFT,
  SETUP_STEPS,
  bindsNoRepository,
  flowDefaults,
  flowNeedsRepository,
  stepBlockedReason,
  type SetupDraft,
  type SetupStep,
} from "./setup/model.ts";
import "./common/screens.css";
import "./shared/screens.css";

/**
 * Screen: setup — the guided "Kurulum sihirbazı".
 *
 * `/projects` already holds every control this wizard drives, and it stays
 * exactly as it is: it is the EXPERT path, three tabs of the platform's own
 * vocabulary for someone who knows which of them they need. This screen is for
 * the other person — a bank operator whose job is approving Jira tickets, who
 * has been handed Maestro and cannot be expected to know that "dinleme kuralı"
 * is the thing standing between them and a working setup, that the Jira status
 * map is buried inside that form, or that binding a project needs a colleague
 * to approve it before anything runs.
 *
 * So the wizard asks the five questions in the order the ANSWERS depend on each
 * other, in outcome language:
 *
 *   1 ne yapmak istiyorsun   → the flow type, which decides the defaults below
 *   2 hangi proje & uygulama → the Jira project and the repo (four-eyes)
 *   3 hangi ticket'lar       → the listening rule's trigger
 *   4 Jira durumları         → the optional status map, OFF by default
 *   5 özet & kaydet          → in sentences, then two writes
 *
 * Nothing here is a new capability. Every field maps to something `/projects`
 * can already set, every write goes to an endpoint that already exists, and the
 * two screens can be used interchangeably on the same platform — which is the
 * reason the wizard reuses `common/status-map.ts` rather than re-deriving what
 * a status map looks like on the wire.
 *
 * ONE DRAFT, never per-step state. "Geri gidince yazdıklarım gitti" is what
 * makes a wizard worse than the form it replaced; the panes are pure functions
 * of a single object that navigation does not touch.
 */

/** Mirrors the BFF's WRITE_ROLES for both surfaces this wizard writes to. */
const WRITE_ROLES = ["admin"] as const;

export function SetupScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const canWrite = hasAnyRole(session, WRITE_ROLES);

  /**
   * The start-guide's state, moved here with the guide itself.
   *
   * `useSetupState` is REUSED, never re-derived: it is the one place that
   * measures whether a step is finished, and a second implementation on this
   * screen would be the drift that made the old Panel disagree with the old
   * guide about the same platform. The webhook acknowledgement is held in state
   * because the checkbox inside the guide flips it and the checklist has to
   * re-render when it does.
   */
  const [webhookAck, setWebhookAck] = useState(() => webhookAcked());
  const [guideDismissed, setGuideDismissed] = useState(() => readFlag(GUIDE_DISMISSED_KEY));
  const setupState = useSetupState(webhookAck);
  const setupIncomplete = !setupState.loading && !setupState.complete;

  const [draft, setDraft] = useState<SetupDraft>(EMPTY_SETUP_DRAFT);
  const [stepIndex, setStepIndex] = useState(0);
  const step: SetupStep = SETUP_STEPS[stepIndex]!;
  // Set once both writes have gone through, so the wizard can end on "what to
  // do next" instead of leaving the operator on a form they are done with.
  const [finished, setFinished] = useState<{ awaitingApproval: boolean } | null>(null);
  /**
   * A failure the operator can act on, rendered beside the save button rather
   * than only as a toast. The duplicate-rule case in particular is not an error
   * so much as a fact ("bu kural zaten var"), and a toast that fades after four
   * seconds is the wrong place for a fact the operator has to decide about.
   */
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  /**
   * The field-level violations behind a validation 400 (`details.issues`).
   * "Taslak reddedildi" alone left the operator diffing their answers against
   * a schema they cannot see; the named fields under the sentence are what
   * make the refusal fixable from this screen.
   */
  const [saveProblemIssues, setSaveProblemIssues] = useState<readonly string[]>([]);

  const patch = (next: Partial<SetupDraft>): void => {
    setDraft((current) => ({ ...current, ...next }));
    // A changed answer invalidates a stale complaint about the previous one.
    setSaveProblem(null);
    setSaveProblemIssues([]);
  };

  // ── the live lists, read from exactly the endpoints /projects reads ────────

  const options = useQuery({
    queryKey: ["onboarding-options"],
    queryFn: ({ signal }) => api.get<OnboardingOptions>("/onboarding/options", { signal }),
    retry: false,
  });

  const jiraConnections = useQuery({
    queryKey: ["onboarding-jira-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly (JiraConnection & { botAccountId?: string | null })[] }>(
        "/onboarding/jira-connections",
        { signal },
      ),
    retry: false,
  });
  const jiraConnList = jiraConnections.data?.connections ?? [];

  const scmConnections = useQuery({
    queryKey: ["onboarding-scm-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly ScmConnection[] }>("/onboarding/scm-connections", { signal }),
    retry: false,
  });

  const jiraProjects = useQuery({
    queryKey: ["onboarding-jira-projects", draft.jiraConnectionId],
    enabled: draft.jiraConnectionId !== "",
    retry: false,
    queryFn: ({ signal }) =>
      api.get<JiraProjectsResult>(
        `/onboarding/jira-projects?connectionId=${encodeURIComponent(draft.jiraConnectionId)}`,
        { signal },
      ),
  });

  const scmRepos = useQuery({
    queryKey: ["onboarding-scm-repos", draft.connectionId],
    enabled: draft.connectionId !== "",
    retry: false,
    queryFn: ({ signal }) =>
      api.get<ScmReposResult>(
        `/onboarding/scm-repos?connectionId=${encodeURIComponent(draft.connectionId)}`,
        { signal },
      ),
  });

  // Already-bound projects. Two uses: the summary must not promise a four-eyes
  // approval for a project that is already live, and step 2 can tell an
  // operator that the project they picked needs no new binding at all.
  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingView>("/routing", { signal }),
    retry: false,
  });
  const boundProjects = routing.data?.projects?.map((p) => p.projectKey) ?? [];
  const alreadyBound = draft.jiraProject !== "" && boundProjects.includes(draft.jiraProject);

  // The bot's own accountId, learned when a Jira connection was tested. With it
  // step 3 pre-fills itself instead of asking an operator to hand-copy a 40-char
  // GUID out of a Jira profile URL.
  const botAccountId = jiraConnList.find((c) => c.botAccountId)?.botAccountId ?? null;
  const [assigneeTouched, setAssigneeTouched] = useState(false);
  useEffect(() => {
    if (!assigneeTouched && draft.assigneeAccountId === "" && botAccountId) {
      setDraft((current) => ({ ...current, assigneeAccountId: botAccountId }));
    }
  }, [botAccountId, assigneeTouched, draft.assigneeAccountId]);

  // The Jira connection the match values are read through: the one the operator
  // picked in step 2, falling back to the first configured connection so step 3
  // still offers a live list when the picker was skipped over a bound project.
  const matchConnId = draft.jiraConnectionId !== "" ? draft.jiraConnectionId : (jiraConnList[0]?.id ?? null);

  // The project's real issue types / statuses, so step 3 is a dropdown of the
  // names Jira actually uses rather than a text box that accepts a typo.
  // Not fetched for `assigned`: that rule has no value to pick, and the
  // endpoint only understands status|issuetype anyway — asking it for a third
  // kind would be a 400 on a step the operator has already answered.
  const matchValues = useQuery({
    queryKey: ["jira-match-values", matchConnId, draft.jiraProject, draft.matchKind],
    enabled: matchConnId !== null && draft.jiraProject !== "" && draft.matchKind !== "assigned",
    retry: false,
    queryFn: ({ signal }) =>
      api.get<{ ok: boolean; values?: readonly string[]; degradedKey?: string }>(
        `/onboarding/jira-match-values?connectionId=${encodeURIComponent(matchConnId ?? "")}` +
          `&project=${encodeURIComponent(draft.jiraProject)}&kind=${draft.matchKind}`,
        { signal },
      ),
  });

  // The STATUS names, pinned to kind=status whatever the rule matches on: a
  // rule can trigger on an issue type and still move the ticket through
  // statuses, so the map can never borrow the list above. Only fetched once the
  // operator has actually turned the map on — a step nobody opted into must not
  // spend a Jira call.
  const statusNames = useQuery({
    queryKey: ["jira-match-values", matchConnId, draft.jiraProject, "status"],
    enabled: draft.statusOn && matchConnId !== null && draft.jiraProject !== "",
    retry: false,
    queryFn: ({ signal }) =>
      api.get<{ ok: boolean; values?: readonly string[] }>(
        `/onboarding/jira-match-values?connectionId=${encodeURIComponent(matchConnId ?? "")}` +
          `&project=${encodeURIComponent(draft.jiraProject)}&kind=status`,
        { signal },
      ),
  });

  const projectsBody = jiraProjects.data;
  const reposBody = scmRepos.data;
  const data: PaneData = {
    jiraConnections: jiraConnList.map((c) => ({
      id: c.id,
      label: `${c.displayName} · ${t(`onboard.jira.kind.${c.kind}`)}`,
    })),
    jiraProjects: projectsBody?.ok === true ? projectsBody.projects : [],
    jiraProjectsLoading: draft.jiraConnectionId !== "" && jiraProjects.isFetching,
    jiraProjectsError:
      projectsBody !== undefined && projectsBody.ok === false
        ? t(projectsBody.messageKey, projectsBody.messageParams ?? {})
        : null,
    scmConnections: (scmConnections.data?.connections ?? []).map((c) => ({
      id: c.id,
      label: `${c.displayName} · ${t(`onboard.scm.kind.${c.kind}`)}`,
    })),
    // `isSuccess`, for the same reason `missingScm` below uses it: only an
    // ANSWERED request may be turned into "this install has no repository".
    // In flight or failed, the count stays unknown and step 1 offers every
    // flow rather than accusing the deployment of a gap it may not have.
    scmConnectionCount: scmConnections.isSuccess
      ? (scmConnections.data?.connections ?? []).length
      : null,
    scmRepos: reposBody?.ok === true ? reposBody.repos.map((r) => r.fullName) : [],
    scmReposLoading: draft.connectionId !== "" && scmRepos.isFetching,
    scmReposError:
      reposBody !== undefined && reposBody.ok === false
        ? t(reposBody.messageKey, reposBody.messageParams ?? {})
        : null,
    platforms: options.data?.platforms ?? [],
    matchValues: matchValues.data?.ok === true ? (matchValues.data.values ?? []) : [],
    // Set when the issue-type list came from the fallback source and may be in
    // a different language than the tickets — see `jira-match-values-service`.
    matchValuesNote:
      matchValues.data?.ok === true && matchValues.data.degradedKey !== undefined
        ? t(matchValues.data.degradedKey)
        : null,
    statusNames: statusNames.data?.ok === true ? (statusNames.data.values ?? []) : [],
    botKnown: botAccountId !== null,
  };

  // ── prerequisites ─────────────────────────────────────────────────────────

  /**
   * What stops the wizard before it starts, and where the operator fixes it.
   *
   * Only checked once the lists have actually loaded: "hiç Jira bağlantısı yok"
   * shown while the request is still in flight is a lie that sends an operator
   * to Ayarlar for nothing. `isSuccess` rather than `!isPending` because a
   * failed request is not evidence of an empty list either.
   */
  const missingJira = jiraConnections.isSuccess && jiraConnList.length === 0;
  // Only a prerequisite for the flows that write code. For `analiz` the
  // repository is an offer (step 2 says so in place), and a warning card
  // claiming setup cannot proceed would contradict the wizard that then
  // proceeds — the exact sentence this card used to carry was false for
  // analysis-only teams.
  const missingScm =
    flowNeedsRepository(draft.flowType) &&
    scmConnections.isSuccess &&
    (scmConnections.data?.connections ?? []).length === 0;

  // ── the two writes ────────────────────────────────────────────────────────

  /**
   * Save is TWO requests, in a deliberate order.
   *
   * The listening rule first, because it is the one that can fail in a way the
   * operator must resolve (a duplicate trigger) and because it applies
   * immediately. The binding proposal second, because it does NOT apply — it
   * waits for a second admin — so filing it after a failed rule would leave a
   * pending approval for a configuration that was never completed.
   *
   * A project that is already bound skips the proposal entirely: `POST
   * /onboarding` would answer `project_already_bound`, and re-proposing a live
   * binding is not what the operator asked for by picking that project.
   */
  const save = useMutation({
    mutationFn: async (input: SetupDraft) => {
      await api.post<{ rule: unknown }>("/studio/listening-rules", {
        projectKey: input.jiraProject,
        assigneeAccountId: input.assigneeAccountId.trim(),
        matchKind: input.matchKind,
        // An `assigned` rule compares no field, but `matchValue` is NOT NULL and
        // carries the unique trigger index, so it gets the literal both sides
        // agree on. The BFF pins it to the same value regardless of what
        // arrives — this is the client not sending something the server would
        // only have to overwrite.
        matchValue:
          input.matchKind === "assigned" ? ASSIGNED_MATCH_VALUE : input.matchValue.trim(),
        flowType: input.flowType,
        // The wizard never offers per-role agent overrides: the default agent is
        // right for a first setup, and the expert screen is where a variant gets
        // chosen. Sent as null explicitly rather than omitted, so the rule the
        // wizard writes has the same shape as one the expert screen writes.
        analystVariantId: null,
        engineerVariantId: null,
        // Flow-aware on purpose: a düzeltme rule never reaches the two
        // analysis-approval moments, so values a draft may still hold there
        // (typed before the operator switched flows) stay off the wire — the
        // summary the operator just confirmed did not list them either.
        statusMap: buildStatusMap(
          input.statusOn,
          input.statusDraft,
          input.reassignOnNeedInfo,
          input.flowType,
        ),
      });

      if (alreadyBound) return { awaitingApproval: false };

      const defaults = flowDefaults(input.flowType);
      await api.post<{ proposalId: string }>("/onboarding", {
        jiraProject: input.jiraProject,
        // The picked repo travels in `adoRepo` — the wire field the BFF reads.
        // OMITTED, together with `platform`, for an analysis-only draft: the
        // BFF's schema requires the pair together-or-not-at-all, and sending
        // "" would claim a repository named nothing. A platform value the
        // draft may still hold (picked before the repo was cleared) stays off
        // the wire with it — the summary the operator confirmed said
        // ticket-text mode, and the request has to say the same thing.
        ...(bindsNoRepository(input)
          ? {}
          : { adoRepo: input.repoFullName, platform: input.platform }),
        // The operator's ANSWER, not a default filled in on their behalf. The
        // BFF still falls back to `gizli` when the field is absent, but it must
        // not be absent here: this wizard asked the question, showed the
        // consequence, and has to send what was chosen.
        dataClass: input.dataClass,
        ...defaults,
      });
      return { awaitingApproval: true };
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["listening-rules"] });
      void queryClient.invalidateQueries({ queryKey: ["routing"] });
      setFinished(result);
      toast.show("success", t("setup.toast.saved"));
    },
    onError: (error) => {
      /**
       * The duplicate trigger, explained rather than reported.
       *
       * `duplicate_listening_rule` means a rule for this exact (proje, hesap,
       * eşleşme) is already listening — which is not a failure of the wizard so
       * much as a sign the operator has already done this. The generic catalog
       * line says the tuple collided; this one says what to do about it, and
       * points at the expert screen where the existing rule can be seen.
       */
      if (error instanceof ApiError && error.code === "duplicate_listening_rule") {
        setSaveProblem("setup.error.duplicate_rule");
        return;
      }
      setSaveProblem(messageKeyOf(error));
      // A validation 400 names the violated fields; render them under the
      // sentence rather than leaving "geçersiz gövde" as the whole answer.
      setSaveProblemIssues(issueDetailsOf(error));
    },
  });

  // ── navigation ────────────────────────────────────────────────────────────

  // The repository count is what step 1 needs: a flow that writes code cannot
  // be walked toward on an install that has no repository connection.
  const blocked = stepBlockedReason(step, draft, data.scmConnectionCount);
  const isLast = stepIndex === SETUP_STEPS.length - 1;

  const goBack = (): void => {
    setSaveProblem(null);
    setSaveProblemIssues([]);
    setStepIndex((i) => Math.max(0, i - 1));
  };
  const goNext = (): void => {
    setSaveProblem(null);
    setSaveProblemIssues([]);
    setStepIndex((i) => Math.min(SETUP_STEPS.length - 1, i + 1));
  };

  if (finished !== null) {
    return (
      <div className="scr-stack">
        <DonePane draft={draft} awaitingApproval={finished.awaitingApproval} />
        <Card>
          <div className="screen-actions">
            <Link className="ui-btn" to="/projects?tab=listening">
              {t("setup.done.open_expert")}
            </Link>
            <Button
              onClick={() => {
                // A second project from a clean draft — but keep the operator's
                // bot account, which is a property of the platform rather than
                // of the project they just configured.
                setDraft({ ...EMPTY_SETUP_DRAFT, assigneeAccountId: draft.assigneeAccountId });
                setStepIndex(0);
                setFinished(null);
              }}
            >
              {t("setup.done.again")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="scr-stack">
      {/*
        What is ALREADY connected, before the wizard asks for anything new.

        `/routing` has carried this list all along and the screen used it for
        one thing only: a warning when the operator picked a project that was
        already bound. So an operator who had just finished the wizard came
        back, saw the same empty form, and had no way to tell whether their
        project had been saved — the panel knew and did not say.
      */}
      {boundProjects.length > 0 && (
        <Card title={t("setup.bound.title")} subtitle={t("setup.bound.sub")}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {(routing.data?.projects ?? []).map((project) => (
              <li key={project.projectKey} className="scr-prose" style={{ marginBottom: 4 }}>
                <strong className="scr-mono">{project.projectKey}</strong>
                {/* Boş anahtar da yok sayılır: `/routing` bir projeyi notsuz
                    dönebilir, ve `t("")` katalogda karşılığı olmayan bir
                    anahtardır — ekrana ham anahtar basmaktansa hiç basma. */}
                {project.noteKey === undefined || project.noteKey === ""
                  ? ""
                  : ` — ${t(project.noteKey, project.noteParams ?? {})}`}
                {project.apps.length > 0 && (
                  <span className="scr-mini" style={{ opacity: 0.8 }}>
                    {" · "}
                    {project.apps.join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title={t("setup.title")} subtitle={t("setup.sub")}>
        <p className="scr-prose">{t("setup.intro")}</p>
        {/* The step strip: where the operator is, and how much is left. Every
            step already visited is clickable, so going back three steps to fix a
            typo is one click rather than three "Geri"s. Steps AHEAD are not,
            because jumping forward past an unanswered question is how a wizard
            ends up saving a half-filled draft. */}
        <ol className="scr-wiz" style={{ marginTop: 12, marginBottom: 0 }}>
          {SETUP_STEPS.map((id, i) => (
            <li key={id} style={{ listStyle: "none" }}>
              <button
                type="button"
                className={
                  "scr-wiz__step" +
                  (i === stepIndex ? " scr-wiz__step--on" : "") +
                  (i < stepIndex ? " scr-wiz__step--done" : "")
                }
                disabled={i > stepIndex}
                aria-current={i === stepIndex ? "step" : undefined}
                onClick={() => setStepIndex(i)}
              >
                {i + 1} · {t(`setup.step.${id}`)}
              </button>
            </li>
          ))}
        </ol>
      </Card>

      {/* A prerequisite the operator cannot solve from this page. Named, and
          linked to the screen that fixes it — "bir şeyler eksik" with no noun in
          it is the sentence that generates a support ticket. */}
      {(missingJira || missingScm) && (
        <Card title={t("setup.prereq.title")}>
          <div className="scr-note scr-note--warn">
            {missingJira ? t("setup.prereq.no_jira") : t("setup.prereq.no_scm")}
          </div>
          <div className="screen-actions">
            {/* Connections are a panel on /settings, not a tab of their own. */}
            <Link className="ui-btn" to="/settings">
              {t("setup.prereq.open_settings")}
            </Link>
          </div>
        </Card>
      )}

      {!canWrite && (
        <Card>
          <div className="scr-note scr-note--warn">{t("setup.blocked.read_only")}</div>
        </Card>
      )}

      {/* The "where do I start" checklist, moved here from the Panel.
          It belongs with the work, not on the report screen: the five steps it
          lists are the five things this page and its siblings DO, and the Panel
          is where an operator goes to read numbers. The Panel keeps one line
          saying setup is open, pointing here.
          It appears only while something is actually open, and only until the
          operator hides it — both the state and the two localStorage keys are
          the ones it already used, so a dismissal made on the old Panel is
          still honoured here. */}
      {setupIncomplete && !guideDismissed && (
        <StartGuide
          setup={setupState}
          onWebhookAck={setWebhookAck}
          onDismiss={() => {
            writeFlag(GUIDE_DISMISSED_KEY, true);
            setGuideDismissed(true);
          }}
        />
      )}

      {step === "flow" && <FlowPane draft={draft} data={data} onChange={patch} />}
      {step === "project" && <ProjectPane draft={draft} data={data} onChange={patch} />}
      {step === "tickets" && (
        <TicketsPane
          draft={draft}
          data={data}
          onChange={(next) => {
            if (next.assigneeAccountId !== undefined) setAssigneeTouched(true);
            patch(next);
          }}
        />
      )}
      {step === "status" && <StatusPane draft={draft} data={data} onChange={patch} />}
      {step === "review" && <ReviewPane draft={draft} alreadyBound={alreadyBound} />}

      <Card>
        <div className="screen-actions">
          <Button disabled={stepIndex === 0} onClick={goBack}>
            {t("setup.action.back")}
          </Button>
          {isLast ? (
            <Button
              variant="success"
              busy={save.isPending}
              disabled={!canWrite}
              onClick={() => save.mutate(draft)}
            >
              {t("setup.action.save")}
            </Button>
          ) : (
            <Button variant="primary" disabled={blocked !== null} onClick={goNext}>
              {t("setup.action.next")}
            </Button>
          )}
          {/* The optional step says so on the button itself: an operator who does
              not want a status map should not have to guess that "İleri" with
              everything blank is the supported way through. */}
          {step === "status" && !draft.statusOn && (
            <span className="scr-note">{t("setup.status.skip_hint")}</span>
          )}
        </div>
        {/* WHY the button is dead, in the operator's own terms and right where
            they are looking. */}
        {blocked !== null && (
          <div className="scr-note scr-note--warn" style={{ marginTop: 10 }}>
            {t(blocked)}
          </div>
        )}
        {saveProblem !== null && (
          <div className="scr-note scr-note--danger" style={{ marginTop: 10 }}>
            {t(saveProblem)}
            {/* The violated fields, when the refusal named them (a validation
                400's `details.issues`). Rendered as the BFF's own field/message
                lines: they are schema field names, and translating them away
                would hide the one thing the operator can act on. */}
            {saveProblemIssues.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {saveProblemIssues.map((issue) => (
                  <li key={issue} className="scr-mono">
                    {issue}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
