import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Table, useToast } from "../ui/index.ts";
import type {
  ApplicationRecord,
  DataClassPolicy,
  Page,
  ParamPutResult,
  PendingBinding,
  RoutingUpdate,
  RoutingView,
} from "./common/index.ts";
import { useEnumLabel, usePhrase } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { outcomeExplanationKey, outcomeKey, outcomeTone } from "./shared/outcome.ts";
import { RoutingPolicyEditor } from "./routing/RoutingPolicyEditor.tsx";

/**
 * Screen: routing — Jira binding, ticket→application matching and the LLM
 * routing policy (M99/M100/M102).
 *
 * The two tables answer different questions. The bindings are rows written by
 * the onboarding flow (which project is live, how a ticket enters). The policy
 * is the GUARDED `dataclass.policy` parameter — editable here, but every save
 * takes four eyes because it decides whether a `gizli` ticket may reach a cloud
 * model. The Application Registry below is the TARGET of a match: each row is a
 * repo an agent may be told to push to, so it is shown, never implied.
 */

/**
 * The named reasons `POST /onboarding/approve` can give for a seed that did
 * not run (`seedSkipped.reason`, from `listening-seed.ts` plus the route's own
 * `seed_error` catch-all), each mapped to its short Turkish/English phrase. An
 * unknown reason — a BFF newer than this screen — falls back to the generic
 * one rather than crashing `t()` on a key that does not exist.
 */
const SEED_SKIP_REASON_KEYS: Readonly<Record<string, string>> = {
  issue_types_unavailable: "listening.seedskip.issue_types_unavailable",
  no_jira_connection: "listening.seedskip.no_jira_connection",
  bot_account_unknown: "listening.seedskip.bot_account_unknown",
  listening_unwired: "listening.seedskip.listening_unwired",
  connections_unwired: "listening.seedskip.connections_unwired",
  seed_error: "listening.seedskip.seed_error",
};

function seedSkipReasonKey(reason: string): string {
  return SEED_SKIP_REASON_KEYS[reason] ?? "listening.seedskip.seed_error";
}

export function RoutingScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const enumLabel = useEnumLabel();
  const phrase = usePhrase();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [pendingBy, setPendingBy] = useState<string | null>(null);
  // After an approval, the just-bound project — drives the "add a listening
  // rule" prompt (Faz 4), the chain's natural next step.
  const [boundProject, setBoundProject] = useState<string | null>(null);
  // Which bound project's "Düzenle" is open, or null. See `BindingEdit`.
  const [editingBinding, setEditingBinding] = useState<string | null>(null);

  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingView>("/routing", { signal }),
  });

  // The Application Registry (M100). Read here so the admin can see the targets
  // a match resolves to without opening another screen.
  const apps = useQuery({
    queryKey: ["studio-apps"],
    queryFn: ({ signal }) => api.get<Page<ApplicationRecord>>("/studio/apps", { signal }),
  });

  // Which projects have at least one listening rule. A bound project with NO
  // rule accepts no ticket — it looks "live" but does nothing — so the table
  // flags it and points the operator to the step that finishes the setup.
  const listeningRules = useQuery({
    queryKey: ["listening-rules"],
    queryFn: ({ signal }) =>
      api.get<{ rules: readonly { projectKey: string }[] }>("/studio/listening-rules", { signal }),
  });
  const projectsWithRule = new Set(
    (listeningRules.data?.rules ?? []).map((r) => r.projectKey),
  );

  const canEdit = hasRole(session, "admin");

  /**
   * The current policy, taken VERBATIM from the server.
   *
   * It must never be reconstructed from the rendered `rules`: the outcome is
   * lossy (`degrade_ai_assist` and `masked_cloud` both read as `degraded`), so a
   * guessed `whenOnpremMissing` PUT back on a save that never touched the field
   * silently downgrades the stored policy — a strict `block` on the `gizli`
   * class becoming `degrade_ai_assist` — and four-eyes cannot catch it because
   * the two proposals agree with each other. The raw value round-trips exactly.
   */
  const currentPolicy: DataClassPolicy | null = routing.data?.policy ?? null;

  const save = useMutation({
    mutationFn: (policy: DataClassPolicy) =>
      api.put<ParamPutResult>("/routing", { policy } satisfies RoutingUpdate),
    onSuccess: (result) => {
      setEditing(false);
      if (result.status === "applied") {
        setPendingBy(null);
        void queryClient.invalidateQueries({ queryKey: ["routing"] });
        toast.show("success", t("routing.policy.toast.applied"));
      } else {
        setPendingBy(result.pending.proposedBy);
        toast.show("warning", t("routing.policy.toast.pending"));
      }
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  // Onboarding packages awaiting a second approver (M93). This is the queue that
  // was invisible before: a submitted binding sat in `params.pending` with no
  // screen reading it, so nobody could approve it.
  const pending = useQuery({
    queryKey: ["onboarding-pending"],
    queryFn: ({ signal }) =>
      api.get<{ items: readonly PendingBinding[] }>("/onboarding/pending", { signal }),
  });

  const approve = useMutation({
    mutationFn: (projectKey: string) =>
      api.post<{
        status: string;
        projectKey: string;
        nextStep: string;
        /** Ready-made rules auto-seeded on approval; null when nothing ran. */
        listeningSeed?: { created: number; skipped: number } | null;
        /** WHY nothing ran, when `listeningSeed` is null — never absent silently. */
        seedSkipped?: { reason: string } | null;
      }>("/onboarding/approve", { projectKey }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["onboarding-pending"] });
      void queryClient.invalidateQueries({ queryKey: ["routing"] });
      void queryClient.invalidateQueries({ queryKey: ["listening-rules"] });
      // Approval now seeds the ready-made listening rules server-side; when it
      // did, say so — the admin learns the project is already listening rather
      // than assuming a manual rule step is still ahead.
      const seeded = result.listeningSeed;
      if (seeded != null && seeded.created > 0) {
        toast.show(
          "success",
          t("routing.pending.toast.bound_seeded", {
            project: result.projectKey,
            n: String(seeded.created),
          }),
        );
      } else if (result.seedSkipped != null) {
        // Bound, but the default rules could NOT be seeded — until now this
        // rendered as the same cheerful "bağlandı" while zero tickets were
        // listened to. A warning that names the reason and the way out
        // (test the Jira connection, re-seed from the listening screen, or
        // write a rule by hand) instead of a green half-truth.
        toast.show(
          "warning",
          t("routing.pending.toast.bound_seed_skipped", {
            project: result.projectKey,
            reason: t(seedSkipReasonKey(result.seedSkipped.reason)),
          }),
        );
      } else {
        toast.show("success", t("routing.pending.toast.bound", { project: result.projectKey }));
      }
      setBoundProject(result.projectKey);
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const reject = useMutation({
    mutationFn: (projectKey: string) => api.post("/onboarding/reject", { projectKey }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["onboarding-pending"] });
      toast.show("success", t("routing.pending.toast.rejected"));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  return (
    <>
      {/* The onboarding approval queue (M93). Admins only, and only when there is
          something to approve — a submitted package was invisible before this.
          Approving here is what turns a proposal into a live binding. */}
      {canEdit && (pending.data?.items.length ?? 0) > 0 && (
        <div style={{ marginTop: 14 }}>
          <Card title={t("routing.pending.title")} subtitle={t("routing.pending.sub")} padded={false}>
            <Table
              columns={[
                {
                  key: "project",
                  header: t("routing.col.project"),
                  cell: (row: PendingBinding) => <b>{row.projectKey}</b>,
                },
                {
                  key: "repo",
                  header: t("routing.pending.col.repo"),
                  // An analysis-only package binds no repository, and the
                  // approver is confirming exactly that — so the cell says it
                  // in words. An empty cell here would read as data loss on
                  // the one screen where the second human decides.
                  cell: (row: PendingBinding) =>
                    row.adoRepo === null ? (
                      <span className="scr-mini">{t("routing.pending.norepo")}</span>
                    ) : (
                      <span className="scr-mono">{row.adoRepo}</span>
                    ),
                },
                {
                  key: "platform",
                  header: t("routing.pending.col.platform"),
                  cell: (row: PendingBinding) => row.platform ?? "—",
                },
                {
                  key: "by",
                  header: t("routing.pending.col.by"),
                  cell: (row: PendingBinding) => <span className="scr-mini">{row.proposedBy}</span>,
                },
                {
                  key: "act",
                  header: "",
                  cell: (row: PendingBinding) => (
                    <div className="scr-row">
                      <Button
                        size="sm"
                        variant="success"
                        busy={approve.isPending}
                        onClick={() => approve.mutate(row.projectKey)}
                      >
                        {t("routing.pending.approve")}
                      </Button>
                      <Button
                        size="sm"
                        busy={reject.isPending}
                        onClick={() => reject.mutate(row.projectKey)}
                      >
                        {t("routing.pending.reject")}
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={pending.data?.items ?? []}
              rowKey={(row) => row.projectKey}
              emptyLabel={t("routing.pending.empty")}
            />
            {/* Faz 4: the chain's next step. A freshly bound project has no
                listening rules, so the ticket it now accepts would match nothing.
                Point the operator straight at the pre-filled rule editor. */}
            {boundProject !== null && (
              <div className="scr-note" style={{ margin: 12 }}>
                {t("routing.pending.next_listening", { project: boundProject })}{" "}
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    navigate(
                      `/projects?tab=listening&projectKey=${encodeURIComponent(boundProject)}`,
                    )
                  }
                >
                  {t("routing.pending.add_listening")}
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <Card
          title={t("routing.projects")}
          subtitle={t("routing.projects_sub")}
          padded={false}
          actions={
            <Button size="sm" onClick={() => navigate("/projects?tab=onboard")}>
              {t("routing.action.bind")}
            </Button>
          }
        >
          <MaybeUnwired
            isPending={routing.isPending}
            error={routing.error}
            isEmpty={(routing.data?.projects ?? []).length === 0}
            emptyTitle={t("routing.no_projects")}
            onRetry={() => void routing.refetch()}
          >
            <Table
              columns={[
                {
                  key: "project",
                  header: t("routing.col.project"),
                  cell: (row) => row.projectKey,
                },
                {
                  key: "trigger",
                  header: t("routing.col.trigger"),
                  cell: (row) => {
                    const label = enumLabel("routing.trigger", row.trigger);
                    return <Badge tone={label.unknown ? "gray" : "blue"}>{label.text}</Badge>;
                  },
                },
                {
                  key: "apps",
                  header: t("routing.col.apps"),
                  cell: (row) =>
                    row.apps.length === 0 ? t("routing.no_apps") : row.apps.join(", "),
                },
                {
                  key: "note",
                  header: t("routing.col.note"),
                  cell: (row) => phrase(row.noteKey, row.noteParams),
                },
                {
                  key: "edit",
                  header: "",
                  // The edit affordance the bound list never had (Listening.tsx
                  // gained the same "Düzenle" for its rules). It opens the panel
                  // below rather than a form, because most of what an operator
                  // wants to change here HAS no endpoint — see `BindingEdit`.
                  // A button that pretended otherwise would be worse than the
                  // read-only table it replaces.
                  cell: (row) =>
                    canEdit ? (
                      <Button size="sm" onClick={() => setEditingBinding(row.projectKey)}>
                        {t("routing.action.edit_binding")}
                      </Button>
                    ) : null,
                },
                {
                  key: "status",
                  header: t("routing.col.status"),
                  // A bound project with no listening rule accepts no ticket. Say
                  // so plainly and link to the step that fixes it, rather than
                  // letting the operator believe it is working.
                  cell: (row) =>
                    projectsWithRule.has(row.projectKey) ? (
                      <Badge tone="green">{t("routing.status.ready")}</Badge>
                    ) : (
                      <button
                        type="button"
                        className="scr-linkbtn"
                        onClick={() => navigate(`/projects?tab=listening&projectKey=${row.projectKey}`)}
                      >
                        <Badge tone="amber">{t("routing.status.no_rule")}</Badge>
                      </button>
                    ),
                },
              ]}
              rows={routing.data?.projects ?? []}
              rowKey={(row) => row.projectKey}
              emptyLabel={t("routing.no_projects")}
            />
          </MaybeUnwired>
          {editingBinding !== null && (
            <BindingEdit
              projectKey={editingBinding}
              onClose={() => setEditingBinding(null)}
              onOpenRules={(key) =>
                navigate(`/projects?tab=listening&projectKey=${encodeURIComponent(key)}`)
              }
            />
          )}
        </Card>
      </div>

      {/* Everything below is reference / infrastructure, not the operator's task
          (approve a binding, see what is bound). It is collapsed by default so
          the two cards above are what an admin lands on; whoever needs the model
          policy or the app inventory opens it. */}
      <details className="scr-adv" style={{ marginTop: 14 }}>
        <summary className="scr-adv__summary">{t("routing.advanced.summary")}</summary>
        <p className="scr-mini" style={{ margin: "8px 2px 4px" }}>
          {t("routing.advanced.how_it_works")}
        </p>

      <div style={{ marginTop: 14 }}>
        <Card
          title={t("routing.policy")}
          subtitle={t("routing.policy_sub")}
          padded={false}
          actions={
            canEdit ? (
              <Button
                size="sm"
                variant="primary"
                disabled={currentPolicy === null}
                onClick={() => setEditing(true)}
              >
                {t("routing.policy.action.edit")}
              </Button>
            ) : undefined
          }
        >
          <MaybeUnwired
            isPending={routing.isPending}
            error={routing.error}
            isEmpty={(routing.data?.rules ?? []).length === 0}
            emptyTitle={t("routing.no_rules")}
          >
            <Table
              columns={[
                {
                  key: "condition",
                  header: t("routing.col.condition"),
                  cell: (row) => phrase(row.conditionKey, row.conditionParams),
                },
                {
                  key: "backend",
                  header: t("routing.col.backend"),
                  cell: (row) => <Badge tone="teal">{row.backend}</Badge>,
                },
                { key: "model", header: t("routing.col.model"), cell: (row) => <code>{row.model}</code> },
                {
                  key: "outcome",
                  header: t("routing.col.outcome"),
                  cell: (row) => (
                    <Badge tone={outcomeTone(row.outcome)}>{t(outcomeKey(row.outcome))}</Badge>
                  ),
                },
                {
                  key: "meaning",
                  header: t("routing.col.meaning"),
                  cell: (row) => t(outcomeExplanationKey(row.outcome)),
                },
              ]}
              rows={routing.data?.rules ?? []}
              rowKey={(row) => row.ruleId}
              emptyLabel={t("routing.no_rules")}
            />
          </MaybeUnwired>
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={t("routing.registry")} subtitle={t("routing.registry_sub")} padded={false}>
          <MaybeUnwired
            isPending={apps.isPending}
            error={apps.error}
            isEmpty={(apps.data?.items ?? []).length === 0}
            emptyTitle={t("routing.registry_empty")}
            onRetry={() => void apps.refetch()}
          >
            <Table
              columns={[
                {
                  key: "app",
                  header: t("routing.registry.col.app"),
                  cell: (row) => <b>{row.displayName}</b>,
                },
                {
                  key: "repo",
                  header: t("routing.registry.col.repo"),
                  cell: (row) => (
                    <code className="scr-mono">{`${row.adoProject}/_git/${row.adoRepo}`}</code>
                  ),
                },
                {
                  key: "platform",
                  header: t("routing.registry.col.platform"),
                  cell: (row) => <Badge tone="gray">{row.platform}</Badge>,
                },
                {
                  key: "yaml",
                  header: t("routing.registry.col.yaml"),
                  cell: (row) =>
                    row.maestroYamlPresent ? (
                      <Badge tone="green">{t("routing.registry.yaml_present")}</Badge>
                    ) : (
                      <Badge tone="amber">{t("routing.registry.yaml_absent")}</Badge>
                    ),
                },
                {
                  key: "source",
                  header: t("routing.registry.col.source"),
                  cell: (row) => t(`routing.registry.source.${row.createdVia}`),
                },
              ]}
              rows={apps.data?.items ?? []}
              rowKey={(row) => row.appId}
              emptyLabel={t("routing.registry_empty")}
            />
          </MaybeUnwired>
          <p className="scr-mini" style={{ margin: "9px 14px 12px" }}>
            {t("routing.registry_note")}
          </p>
        </Card>
      </div>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("routing.config_note")}
      </p>
      </details>

      {currentPolicy !== null && (
        <RoutingPolicyEditor
          open={editing}
          current={currentPolicy}
          pendingBy={pendingBy}
          busy={save.isPending}
          onClose={() => setEditing(false)}
          onSubmit={(policy) => save.mutate(policy)}
        />
      )}
    </>
  );
}

/**
 * "Düzenle" on a bound project — what can be changed, and what honestly cannot.
 *
 * This is NOT a form, and the reason is a measurement rather than a preference.
 * Once a project is bound, the platform offers no way to change the binding:
 *
 *  · `POST /onboarding` is the only path that writes one, and it refuses an
 *    already-bound project outright (`assertProjectBindable` →
 *    `project_already_bound`, apps/bff/src/onboarding-service.ts). It is a
 *    CREATE path, not an update path.
 *  · `bindingWriter.bind` is an upsert and could physically overwrite the row,
 *    but nothing reachable from a client calls it except the four-eyes APPROVE
 *    step, which needs a pending proposal that the create path will not file.
 *  · There is no `PUT /routing/projects/:key`, and `RoutingProjectView` does not
 *    even carry the repo mapping or the data class, so a form here would have
 *    nothing to load and nowhere to save.
 *
 * A "Kaydet" button over that would file nothing and report success, which on a
 * four-eyes-governed decision — where a repo mapping says which repository an
 * agent may push to — is the worst possible lie. So the panel does the two true
 * things instead: it sends the operator to the one thing that IS editable per
 * project (its listening rules, which decide which tickets are picked up and
 * how they run), and it names the gap and the way round it in plain Turkish,
 * so nobody spends an afternoon looking for a button that does not exist.
 *
 * The gap is written up for the API owners as ARAYÜZ İSTEĞİ: a real
 * `POST /onboarding/rebind` filing a four-eyes proposal against a LIVE binding
 * would let this panel become the form it looks like it should be. Governance
 * is the reason it cannot simply be a PUT: changing where an agent pushes is
 * exactly the decision the second approver exists for.
 */
function BindingEdit({
  projectKey,
  onClose,
  onOpenRules,
}: {
  readonly projectKey: string;
  readonly onClose: () => void;
  readonly onOpenRules: (projectKey: string) => void;
}): ReactNode {
  const t = useT();
  return (
    <div className="scr-note" style={{ margin: 12 }} role="note">
      <b>{t("routing.edit.title", { project: projectKey })}</b>
      {/* What IS editable, first — an operator who came here to change which
          tickets Maestro takes gets their answer before the bad news. */}
      <p style={{ marginTop: 6 }}>{t("routing.edit.rules_body")}</p>
      <div className="scr-row" style={{ marginTop: 8 }}>
        <Button size="sm" variant="primary" onClick={() => onOpenRules(projectKey)}>
          {t("routing.edit.open_rules")}
        </Button>
        <Button size="sm" onClick={onClose}>
          {t("routing.edit.close")}
        </Button>
      </div>
      {/* What is NOT, named field by field rather than as "bazı ayarlar". */}
      <p style={{ marginTop: 10 }}>{t("routing.edit.binding_locked")}</p>
      <p style={{ marginTop: 6 }}>{t("routing.edit.workaround")}</p>
    </div>
  );
}
