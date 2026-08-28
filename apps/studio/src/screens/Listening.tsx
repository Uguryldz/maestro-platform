import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Select, Table, useToast } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import type { RoutingView } from "./common/index.ts";
import { englishAside, matchValueLabel } from "./common/jira-english.ts";
import {
  EMPTY_STATUS_DRAFT,
  STATUS_POINTS,
  buildStatusMap,
  deadStatusEntries,
  firesFor,
  statusSummary,
  type StatusDraft,
  type StatusMap,
  type StatusPoint,
} from "./common/status-map.ts";
import { ageLabel } from "./shared/format.ts";
import { QueryState } from "./shared/QueryState.tsx";
import "./shared/screens.css";

/**
 * Screen: listening — the "dinleme kuralları" surface.
 *
 * Turns Maestro's discovery from hard-coded code into rows an admin edits here:
 * "in project X, a ticket assigned to the bot whose <status|issuetype> is
 * <value> runs as <analiz|duzeltme|gelistirme>". Backed by the real DB table
 * (migration 0011) through `/studio/listening-rules`, which is the single
 * source of truth: the Temporal line reads discovery from that table, so a
 * saved rule is a live rule with nothing to mirror anywhere.
 *
 * Each rule also carries an OPTIONAL Jira status map — which status the ticket
 * moves to at each point of the flow. Absent is the default and means
 * comment-only: Maestro writes its comments and never touches the board. The
 * server has accepted the map since it was added, but nothing here could set
 * it, so the only way to use the feature was to write jsonb into Postgres by
 * hand — which in practice meant an operator could not use it at all. The
 * collapsed opt-in section in the form, the "Düzenle" path out of the table and
 * the "Jira durumu" column are that gap closed.
 *
 * WRITES ARE ADMIN-ONLY, mirroring the BFF's WRITE_ROLES. A tech-lead can read
 * the table but the form is hidden; the BFF is the real gate (a viewer who
 * forged the request still gets a 403).
 */

/** Mirrors the BFF WRITE_ROLES for the listening surface. */
const WRITE_ROLES = ["admin"] as const;

type FlowType = "analiz" | "duzeltme" | "gelistirme";
/**
 * Mirrors the BFF's `MATCH_KINDS` and the DB CHECK (migration 0020).
 * `assigned` compares no field: the rule fires because the ticket was handed to
 * the bot, full stop. Its `matchValue` is the fixed literal `*` the server
 * pins, carried only so the unique trigger index keeps one such rule per
 * (project, bot) — it is never shown and never compared.
 */
type MatchKind = "status" | "issuetype" | "assigned";
/** The value the BFF stores for an `assigned` rule. See ASSIGNED_MATCH_VALUE. */
const ASSIGNED_MATCH_VALUE = "*";

/**
 * The status map's shape, point list, empty draft and the `buildStatusMap` /
 * `statusSummary` pair now live in `common/status-map.ts` — the setup wizard
 * writes the same map, and the "no map is null, never `{}`" rule must have
 * exactly one implementation for both surfaces to obey it.
 */

interface ListeningRule {
  readonly ruleId: string;
  readonly projectKey: string;
  readonly assigneeAccountId: string;
  readonly matchKind: MatchKind;
  readonly matchValue: string;
  readonly flowType: FlowType;
  readonly priority: number;
  readonly enabled: boolean;
  /** Agent variant for the analysis side; null/absent → the default agent. */
  readonly analystVariantId?: string | null;
  /** Agent variant for the engineering side; null/absent → the default agent. */
  readonly engineerVariantId?: string | null;
  /**
   * Which Jira status the ticket is moved to at each point of the flow.
   * null/absent is the DEFAULT and means comment-only: Maestro writes its
   * comments and never touches the ticket's status.
   */
  readonly statusMap?: StatusMap | null;
}

/** The slice of `GET /variants` this screen needs: id + role, for filtering. */
interface VariantOption {
  readonly variantId: string;
  readonly role: string;
}

const FLOW_TONE: Readonly<Record<FlowType, BadgeTone>> = {
  analiz: "blue",
  duzeltme: "amber",
  gelistirme: "green",
};

/**
 * `95000` → `"1 dk 35 sn"`, `300000` → `"5 dk"`, `45000` → `"45 sn"`.
 *
 * Rounded to nothing: the interval is a number the operator typed, and a
 * screen that rounds 80s to "1 dakika" reads as the setting having been
 * ignored.
 */
function durationLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} sn`;
  if (seconds === 0) return `${minutes} dk`;
  return `${minutes} dk ${seconds} sn`;
}

/** What one manual sweep answers: what it took, and the round's numbers. */
interface SweepRunResult {
  readonly started: readonly string[];
  readonly error?: string;
  readonly status: SweepStatus | null;
}

/** What `/studio/listening-status` answers; see the BFF route for why. */
interface SweepStatus {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly lastRunAt: string | null;
  readonly lastStarted: number;
  readonly rulesSearched: number;
  readonly lastError: string | null;
}

export function ListeningScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const canWrite = hasAnyRole(session, WRITE_ROLES);

  const query = useQuery({
    queryKey: ["listening-rules"],
    queryFn: ({ signal }) =>
      api.get<{ rules: readonly ListeningRule[] }>("/studio/listening-rules", { signal }),
    retry: false,
  });

  /**
   * Is anything actually LOOKING for tickets?
   *
   * The rules below say what Maestro should pick up. Without this the screen
   * could not say whether a sweep was running at all — and an operator whose
   * tickets never arrive has to tell three states apart: the sweep is off, it
   * runs and finds nothing, or it is failing. Each needs a different fix.
   *
   * Refetched on an interval so the "last run" line ages honestly rather than
   * freezing at whatever it said when the screen opened.
   */
  const sweep = useQuery({
    queryKey: ["listening-status"],
    queryFn: ({ signal }) => api.get<SweepStatus>("/studio/listening-status", { signal }),
    refetchInterval: 30_000,
    retry: false,
  });

  // The bound projects, so the operator PICKS one instead of typing a key from
  // memory. A rule on a project that is not bound never fires — a dropdown of
  // real bindings makes that mistake impossible.
  /**
   * "Şimdi tara" — run one sweep without waiting for the interval.
   *
   * Asked for directly: "tarama ok ama yine de panele gelmiyor, daha test
   * butonu yok mu?". Writing a rule and then waiting five minutes to find out
   * whether it matches anything is not a test; and reading the container log
   * needs a shell, which the admin writing rules does not necessarily have.
   */
  const sweepNow = useMutation({
    mutationFn: () => api.post<SweepRunResult>("/studio/listening-sweep", {}),
    onSuccess: (result) => {
      // The round's own numbers come back with the response, but the strip
      // reads the status query — refresh it so both agree.
      void queryClient.invalidateQueries({ queryKey: ["listening-status"] });
      // A ticket that was taken becomes a run, so the runs list is stale too.
      if (result.started.length > 0) {
        void queryClient.invalidateQueries({ queryKey: ["runs"] });
      }
    },
  });

  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingView>("/routing", { signal }),
  });
  const boundProjects = routing.data?.projects?.map((p) => p.projectKey) ?? [];

  // The Maestro Bot's own accountId, learned when a Jira connection was tested.
  // With it, the "Bot kullanıcısı" field pre-fills itself instead of asking the
  // operator to hand-copy a 40-char GUID from a Jira profile URL. `null` until a
  // connection has been tested once — then the field falls back to free text.
  const jiraConns = useQuery({
    queryKey: ["onboarding-jira-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly { id: string; botAccountId: string | null }[] }>(
        "/onboarding/jira-connections",
        { signal },
      ),
  });
  const botAccountId =
    jiraConns.data?.connections?.find((c) => c.botAccountId)?.botAccountId ?? null;
  // The Jira connection to read match values through (first enabled one).
  const jiraConnId = jiraConns.data?.connections?.[0]?.id ?? null;

  // Form state for a new rule. The project is pre-filled from `?projectKey=` when
  // an operator arrives here straight from approving an onboarding package (M93),
  // so they land on the rule editor for the project they just bound.
  const [searchParams] = useSearchParams();
  const [projectKey, setProjectKey] = useState(searchParams.get("projectKey") ?? "");
  const [assigneeAccountId, setAssigneeAccountId] = useState("");
  // Pre-fill the bot id once it is known and the operator has not typed their
  // own. Runs when the query resolves; a manual edit is never overwritten.
  const [assigneeTouched, setAssigneeTouched] = useState(false);
  useEffect(() => {
    if (!assigneeTouched && assigneeAccountId === "" && botAccountId) {
      setAssigneeAccountId(botAccountId);
    }
  }, [botAccountId, assigneeTouched, assigneeAccountId]);
  const [matchKind, setMatchKind] = useState<MatchKind>("issuetype");
  const [matchValue, setMatchValue] = useState("");
  const [flowType, setFlowType] = useState<FlowType>("analiz");
  // Which agent variant runs each side of the flow. "" means "default agent"
  // and is sent as null — the engine then picks its own.
  const [analystVariantId, setAnalystVariantId] = useState("");
  const [engineerVariantId, setEngineerVariantId] = useState("");

  // The Jira status map. `statusOn` is the opt-in: OFF by default, because
  // comment-only is the behaviour every existing rule already has and moving a
  // customer's tickets is not something a form should start doing on its own.
  // The draft survives toggling off and on again, so an operator who collapses
  // the section to re-read a hint does not lose what they typed — only what is
  // sent depends on the toggle.
  const [statusOn, setStatusOn] = useState(false);
  // Whether the disclosure is expanded, tracked separately from `statusOn`: an
  // operator opens the section to READ what it does long before deciding to use
  // it, and closing it must never be read as "turn this off".
  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
  const [statusDraft, setStatusDraft] = useState<StatusDraft>(EMPTY_STATUS_DRAFT);
  const [reassignOnNeedInfo, setReassignOnNeedInfo] = useState(false);
  const setStatusAt = (point: StatusPoint, value: string): void =>
    setStatusDraft((prev) => ({ ...prev, [point]: value }));

  // Which of the five points the SELECTED flow can reach. `duzeltme` skips the
  // analysis gate (see `firesFor`), so its two approval moments are dead:
  // mapping them moves nothing, ever. The fields stay visible but disabled with
  // the reason — the same gating the wizard applies, from the same helper, so
  // the two surfaces cannot drift apart about what the engine does.
  const livePoints = new Set(firesFor(flowType));
  // Dead points that nonetheless HOLD a value — a rule stored before this
  // gating existed can carry `onReview` on a düzeltme flow, and the draft keeps
  // a value typed before the operator switched flows. These are the values a
  // save will stop storing, so they get a warning, not silence.
  const deadDraftEntries = deadStatusEntries(statusDraft, flowType);

  // Editing an existing rule: its id, or null while the form is adding a new
  // one. The BFF's PUT is a full replace, so the form carries EVERY field of
  // the rule being edited — a half-filled edit would silently blank the rest.
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);

  // The agent-variant catalogue, for the two per-role dropdowns. A platform
  // without the variants surface (503) simply leaves both lists empty and the
  // selects offer only "default agent" — the rule still saves.
  const variants = useQuery({
    queryKey: ["variants"],
    queryFn: ({ signal }) =>
      api.get<{ variants: readonly VariantOption[] }>("/variants", { signal }),
    retry: false,
  });
  const analystOptions = (variants.data?.variants ?? []).filter((v) => v.role === "analyst");
  const engineerOptions = (variants.data?.variants ?? []).filter((v) => v.role === "engineer");

  // The real status / issue-type names for the chosen project, read live off
  // Jira. Turns "Değer" from free text (silent typos) into a dropdown of exactly
  // the names Jira uses. Only runs once a project AND a Jira connection exist;
  // any failure (connection down, project unreadable) leaves the list empty and
  // the field falls back to free text.
  const matchValues = useQuery({
    queryKey: ["jira-match-values", jiraConnId, projectKey, matchKind],
    // Never for `assigned`: that rule has no value to pick, and the endpoint
    // only understands status|issuetype — asking for a third kind is a 400.
    enabled: jiraConnId !== null && projectKey.trim() !== "" && matchKind !== "assigned",
    retry: false,
    queryFn: ({ signal }) =>
      api.get<{ ok: boolean; values?: readonly string[]; degradedKey?: string }>(
        `/onboarding/jira-match-values?connectionId=${encodeURIComponent(jiraConnId ?? "")}` +
          `&project=${encodeURIComponent(projectKey.trim())}&kind=${matchKind}`,
        { signal },
      ),
  });
  const valueOptions = matchValues.data?.ok ? (matchValues.data.values ?? []) : [];
  // The server could only reach the FALLBACK source for issue types, so these
  // names may be a different localisation than the ones on the tickets
  // ("Task" where the ticket says "Görev") — a rule built from them would match
  // nothing. Still a dropdown, but one that says to check it against a real
  // ticket rather than one that quietly looks authoritative.
  const valuesDegradedKey = matchValues.data?.ok ? matchValues.data.degradedKey : undefined;

  // The project's real STATUS names, for the status-map fields. Same endpoint as
  // "Değer", pinned to kind=status regardless of what the rule matches on: a
  // rule can trigger on an issue type and still move the ticket through
  // statuses, so the map can never borrow `matchValues` — that one follows
  // `matchKind` and would offer issue types half the time. Only fetched once the
  // section is actually opened; a closed section must not spend a Jira call.
  // Any failure leaves the list empty and the five fields fall back to free
  // text, which is why the "birebir aynı yazın" warning stays on screen either
  // way.
  const statusNames = useQuery({
    queryKey: ["jira-match-values", jiraConnId, projectKey, "status"],
    enabled: statusOn && jiraConnId !== null && projectKey.trim() !== "",
    retry: false,
    queryFn: ({ signal }) =>
      api.get<{ ok: boolean; values?: readonly string[] }>(
        `/onboarding/jira-match-values?connectionId=${encodeURIComponent(jiraConnId ?? "")}` +
          `&project=${encodeURIComponent(projectKey.trim())}&kind=status`,
        { signal },
      ),
  });
  const statusOptions = statusNames.data?.ok ? (statusNames.data.values ?? []) : [];

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["listening-rules"] });
  };

  /** The status-map half of the form, back to "this rule only comments". */
  const clearStatusForm = (): void => {
    setStatusOn(false);
    setStatusPanelOpen(false);
    setStatusDraft(EMPTY_STATUS_DRAFT);
    setReassignOnNeedInfo(false);
  };

  /** Leave edit mode and hand the form back to "add a new rule". */
  const cancelEdit = (): void => {
    setEditingRuleId(null);
    setMatchValue("");
    setAnalystVariantId("");
    setEngineerVariantId("");
    clearStatusForm();
  };

  type RuleBody = Omit<ListeningRule, "ruleId" | "priority" | "enabled">;

  const create = useMutation({
    mutationFn: (body: RuleBody) =>
      api.post<{ rule: ListeningRule }>("/studio/listening-rules", body),
    onSuccess: () => {
      invalidate();
      toast.show("success", t("listening.toast.created"));
      setMatchValue("");
      // The status map is per-rule, not a form default: leaving it filled after
      // a save would quietly attach the previous rule's transitions to the next
      // one an operator adds.
      clearStatusForm();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  // Editing replaces the whole rule (the BFF's PUT is a replace, not a patch),
  // which is exactly what the form holds — every field of the rule that was
  // loaded into it. This is the only way to reach the status map from the UI for
  // a rule that already exists, which until now meant hand-editing jsonb in
  // Postgres.
  const update = useMutation({
    mutationFn: ({ ruleId, body }: { ruleId: string; body: RuleBody }) =>
      api.put<{ rule: ListeningRule }>(`/studio/listening-rules/${ruleId}`, body),
    onSuccess: () => {
      invalidate();
      toast.show("success", t("listening.toast.updated"));
      cancelEdit();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  /** Load an existing rule into the form — the round trip out of the table. */
  const onEdit = (rule: ListeningRule): void => {
    setEditingRuleId(rule.ruleId);
    setProjectKey(rule.projectKey);
    setAssigneeTouched(true); // never let the bot-id pre-fill overwrite the rule's own
    setAssigneeAccountId(rule.assigneeAccountId);
    setMatchKind(rule.matchKind);
    setMatchValue(rule.matchValue);
    setFlowType(rule.flowType);
    setAnalystVariantId(rule.analystVariantId ?? "");
    setEngineerVariantId(rule.engineerVariantId ?? "");
    const map = rule.statusMap ?? null;
    // A rule with no map opens with the section CLOSED — the form must show what
    // the rule actually does today (comment only), not invite an edit nobody
    // asked for.
    setStatusOn(map !== null);
    setStatusPanelOpen(map !== null);
    setStatusDraft(
      map === null
        ? EMPTY_STATUS_DRAFT
        : (Object.fromEntries(
            STATUS_POINTS.map((point) => [point, map[point] ?? ""]),
          ) as StatusDraft),
    );
    setReassignOnNeedInfo(map?.reassignOnNeedInfo === true);
  };

  // One-click defaults: the BFF reads the project's Jira issue types and seeds
  // a rule per type (bug-like types → düzeltme, the rest → analiz), skipping
  // any value that already has a rule.
  //
  // The response is 200 in TWO shapes: `{created, skipped, rules}` on a real
  // seed, and `{created: 0, skipped: 0, rules: [], reason:
  // "issue_types_unavailable"}` when Jira's type list could not be read — the
  // fail-soft case where nothing was written rather than inventing type names.
  // That one is a WARNING with its own message, not a cheerful "0 kural
  // eklendi". Named 409s (no connection / untested connection) and the 400 come
  // through the error catalog as actionable Turkish messages.
  const seed = useMutation({
    mutationFn: (key: string) =>
      api.post<{
        created: number;
        skipped: number;
        rules: readonly ListeningRule[];
        reason?: string;
      }>("/studio/listening-rules/seed-defaults", { projectKey: key }),
    onSuccess: ({ created, skipped, reason }) => {
      invalidate();
      if (reason === "issue_types_unavailable") {
        toast.show("warning", t("listening.seed.issue_types_unavailable"));
        return;
      }
      toast.show(
        "success",
        t("listening.seed.toast", { created: String(created), skipped: String(skipped) }),
      );
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const onSeed = (): void => {
    // Prefer the project picked in the form; with exactly one bound project
    // there is nothing to choose, so use it without making the admin pick.
    const key =
      projectKey.trim() !== ""
        ? projectKey.trim()
        : boundProjects.length === 1
          ? boundProjects[0]!
          : "";
    if (key === "") {
      toast.show("error", t("listening.seed.no_project"));
      return;
    }
    seed.mutate(key);
  };

  const remove = useMutation({
    mutationFn: (ruleId: string) =>
      api.delete<{ ok?: boolean }>(`/studio/listening-rules/${ruleId}`),
    onSuccess: () => {
      invalidate();
      toast.show("success", t("listening.toast.deleted"));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const rules = query.data?.rules ?? [];

  // Bound projects with ZERO rules: the platform looks "live" (the binding is
  // green) while no ticket is listened to — the exact state a failed default
  // seed leaves behind (Jira'nın issue-type listesi okunamadı) with nothing on
  // any screen saying so. Only computed once BOTH lists have actually answered:
  // an in-flight or failed query is not evidence of an empty rule set.
  const unlistenedProjects =
    query.isSuccess && routing.isSuccess
      ? boundProjects.filter((key) => !rules.some((rule) => rule.projectKey === key))
      : [];

  const onSubmit = (): void => {
    // An `assigned` rule has no value to check for — the assignee IS the whole
    // condition — so requiring one here would make the third kind unsaveable.
    const needsValue = matchKind !== "assigned";
    if (
      projectKey.trim() === "" ||
      assigneeAccountId.trim() === "" ||
      (needsValue && matchValue.trim() === "")
    ) {
      toast.show("error", t("listening.form.incomplete"));
      return;
    }
    const body: RuleBody = {
      projectKey: projectKey.trim(),
      assigneeAccountId: assigneeAccountId.trim(),
      matchKind,
      // The server pins this to the same literal for `assigned`; sending it
      // means the client is not asking the server to fix up its payload.
      matchValue: needsValue ? matchValue.trim() : ASSIGNED_MATCH_VALUE,
      flowType,
      // "" is the "default agent" choice — normalised to null on the wire.
      analystVariantId: analystVariantId === "" ? null : analystVariantId,
      engineerVariantId: engineerVariantId === "" ? null : engineerVariantId,
      // Flow-aware: only the points `firesFor(flowType)` can reach go on the
      // wire. A value sitting at a dead point (stored by an older rule, or
      // typed before the flow was switched) is dropped HERE, after the form has
      // said so on screen — the warning above the save button names the values
      // and says they will not be written, so the save itself is the operator's
      // confirmation.
      statusMap: buildStatusMap(statusOn, statusDraft, reassignOnNeedInfo, flowType),
    };
    if (editingRuleId !== null) update.mutate({ ruleId: editingRuleId, body });
    else create.mutate(body);
  };

  const columns: readonly Column<ListeningRule>[] = [
    { key: "projectKey", header: t("listening.col.project"), cell: (r) => <b className="screen-mono">{r.projectKey}</b> },
    {
      key: "trigger",
      header: t("listening.col.trigger"),
      // The stored value in bold, the English name beside it in the note voice.
      // A rule holding `Görev` is what MATCHES, and it stays the thing the cell
      // shouts; `(Task)` is there for the half of the bank whose Jira UI is in
      // English and who would otherwise not recognise their own trigger. Two
      // spans rather than one interpolated string so the value a reader copies
      // out of the table is the value the rule holds.
      cell: (r) => {
        // The catch-all's `*` is a storage detail, not a trigger anybody set;
        // printing it would invite an operator to look for a Jira status named
        // "*". The kind's own label already says everything the rule does.
        if (r.matchKind === "assigned") {
          return <b>{t("listening.match.assigned")}</b>;
        }
        const english = englishAside(r.matchValue);
        return (
          <>
            <span className="screen-note">{t(`listening.match.${r.matchKind}`)}</span>{" "}
            <b>{r.matchValue}</b>
            {english !== null && (
              <span className="screen-note"> {t("jira.english.aside", { english })}</span>
            )}
          </>
        );
      },
    },
    {
      key: "flowType",
      header: t("listening.col.flow"),
      cell: (r) => <Badge tone={FLOW_TONE[r.flowType]}>{t(`listening.flow.${r.flowType}`)}</Badge>,
    },
    {
      key: "agents",
      header: t("listening.col.agents"),
      // Which variant runs each side; an unset side reads "default", so a rule
      // that overrides nothing still says so instead of showing a blank cell.
      cell: (r) => (
        <span className="screen-note">
          {t("listening.agent.analyst_short")}:{" "}
          <b>{r.analystVariantId ?? t("listening.agent.default_short")}</b>
          {" · "}
          {t("listening.agent.engineer_short")}:{" "}
          <b>{r.engineerVariantId ?? t("listening.agent.default_short")}</b>
        </span>
      ),
    },
    {
      key: "statusMap",
      header: t("listening.col.status"),
      // The whole point of surfacing the map: whether a rule MOVES tickets or
      // only comments has to be visible from the list, not something an operator
      // discovers by opening each rule. A mapped rule shows the statuses it walks
      // through, in flow order; an unmapped one says "yorum" outright rather than
      // leaving a blank that could read as "not loaded yet". Only the points the
      // rule's FLOW can reach count as the walk — a düzeltme rule stored with an
      // `onReview` (written before the forms gated by flow) shows that value as
      // "gerçekleşmez", not as a status the ticket will visit.
      cell: (r) => {
        const steps = statusSummary(r.statusMap, r.flowType);
        const dead = deadStatusEntries(r.statusMap, r.flowType);
        if (steps.length === 0 && dead.length === 0) {
          return <span className="screen-note">{t("listening.status.comment_only_short")}</span>;
        }
        // A rule whose ONLY mappings are dead is comment-only in practice, so
        // the cell says "yorum" — but keeps the dead values beside it, because
        // "yorum" alone would hide that somebody once configured something.
        const walk =
          steps.length > 0 ? steps.join(" → ") : t("listening.status.comment_only_short");
        return (
          <span className="screen-note" title={walk}>
            {walk}
            {dead.length > 0 && (
              <span className="screen-note">
                {" · "}
                {t("listening.status.dead_cell", {
                  values: dead.map((e) => e.value).join(", "),
                })}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "assignee",
      header: t("listening.col.assignee"),
      // The raw accountId is a 40-char id that overruns the column and means
      // nothing to a reader; show a short, hoverable form.
      cell: (r) => (
        <span className="screen-mono screen-note" title={r.assigneeAccountId}>
          {shortAccount(r.assigneeAccountId)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (r) =>
        canWrite ? (
          <span style={{ display: "inline-flex", gap: 6 }}>
            {/* "Düzenle" loads the rule back into the form above — the only way
                to reach an EXISTING rule's status map, which until now meant
                editing jsonb in the database by hand. */}
            <Button size="sm" onClick={() => onEdit(r)}>
              {t("listening.action.edit")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              busy={remove.isPending}
              onClick={() => remove.mutate(r.ruleId)}
            >
              {t("listening.action.delete")}
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <div className="screen-stack">
      <Card title={t("listening.title")} subtitle={t("listening.sub")}>
        <p className="screen-note">{t("listening.intro")}</p>
        {/*
          Whether anything is LOOKING, above the rules that say what to look
          for. Three states, three different fixes — and the screen used to
          show none of them.
        */}
        {sweep.data !== undefined && (
          <div
            className="screen-note"
            style={{
              marginTop: 10,
              padding: "8px 10px",
              borderRadius: 6,
              background: sweep.data.enabled ? "rgba(21,128,61,0.08)" : "rgba(161,92,7,0.10)",
            }}
          >
            <strong>
              {sweep.data.enabled ? t("listening.sweep.on") : t("listening.sweep.off")}
            </strong>
            {sweep.data.enabled && (
              <>
                {" "}
                {/* Gerçek süre, dakikaya yuvarlanmadan: 80 saniyeye ayarlayan
                    operatörün ekranda "1 dakika" görmesi, ayarladığı şeyin
                    tutmadığını düşündürür. */}
                {t("listening.sweep.every", {
                  duration: durationLabel(sweep.data.intervalMs),
                })}
                {sweep.data.lastRunAt !== null && (
                  <>
                    {" · "}
                    {t("listening.sweep.last", {
                      // `ageLabel` answers with a catalog key + params, so the
                      // "3 dakika önce" wording lives in the catalogue like
                      // every other string.
                      age: (() => {
                        const label = ageLabel(sweep.data.lastRunAt);
                        return label === null ? "—" : t(label.key, label.params);
                      })(),
                      started: String(sweep.data.lastStarted),
                      rules: String(sweep.data.rulesSearched),
                    })}
                  </>
                )}
                {sweep.data.lastError !== null && (
                  <div style={{ marginTop: 4, color: "#b91c1c" }}>
                    {t("listening.sweep.error", { reason: sweep.data.lastError })}
                  </div>
                )}
              </>
            )}
            {/* The button sits INSIDE the strip, beside the numbers it changes:
                pressing it and then reading "3 dakika önce" somewhere else on
                the page is what makes an operator press it twice. */}
            {canWrite && (
              <div style={{ marginTop: 8 }}>
                <Button
                  size="sm"
                  busy={sweepNow.isPending}
                  onClick={() => sweepNow.mutate()}
                >
                  {t("listening.sweep.run_now")}
                </Button>
                {sweepNow.isSuccess && (
                  <span style={{ marginLeft: 8 }}>
                    {sweepNow.data.error !== undefined
                      ? t("listening.sweep.run_failed", { reason: sweepNow.data.error })
                      : sweepNow.data.started.length === 0
                        ? t("listening.sweep.run_empty")
                        : t("listening.sweep.run_took", {
                            count: String(sweepNow.data.started.length),
                            tickets: sweepNow.data.started.join(", "),
                          })}
                  </span>
                )}
                {sweepNow.isError && (
                  <span style={{ marginLeft: 8, color: "#b91c1c" }}>
                    {t(messageKeyOf(sweepNow.error))}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {canWrite && (
          <div
            style={{
              marginTop: 10,
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
              flexWrap: "wrap",
            }}
          >
            <Button variant="primary" busy={seed.isPending} onClick={onSeed}>
              {t("listening.seed.action")}
            </Button>
            <p className="screen-note" style={{ margin: 0, flex: "1 1 280px" }}>
              {t("listening.seed.desc")}
            </p>
          </div>
        )}
      </Card>

      {/* The loud version of the silent failure: a binding exists, zero rules
          listen for it, so NOTHING runs — most often because the default seed
          could not read Jira's issue-type list during approval and failed soft.
          Named warning + the way out (test the connection, re-seed, or write a
          rule by hand), instead of a green setup that quietly does nothing. */}
      {unlistenedProjects.length > 0 && (
        <Card>
          <div className="scr-note scr-note--warn">
            {t("listening.unlistened.warn", { projects: unlistenedProjects.join(", ") })}
          </div>
          {canWrite && (
            <div className="screen-actions">
              {unlistenedProjects.map((key) => (
                <Button
                  key={key}
                  size="sm"
                  busy={seed.isPending}
                  onClick={() => seed.mutate(key)}
                >
                  {t("listening.unlistened.seed", { project: key })}
                </Button>
              ))}
            </div>
          )}
        </Card>
      )}

      {canWrite && (
        <Card
          title={editingRuleId === null ? t("listening.form.title") : t("listening.form.title_edit")}
          subtitle={t("listening.form.sub")}
        >
          <div className="screen-filters">
            {boundProjects.length > 0 ? (
              <Select
                label={t("listening.form.project")}
                value={projectKey}
                onChange={(e) => setProjectKey(e.target.value)}
                options={[
                  { value: "", label: t("listening.form.project_choose") },
                  ...boundProjects.map((key) => ({ value: key, label: key })),
                ]}
                hint={t("listening.form.project_hint")}
              />
            ) : (
              // No bound projects yet: fall back to a text field rather than an
              // empty dropdown, so a rule can still be written, and say why.
              <Input
                label={t("listening.form.project")}
                value={projectKey}
                onChange={(e) => setProjectKey(e.target.value.trim().toUpperCase())}
                hint={t("listening.form.project_none_hint")}
              />
            )}
            <Input
              label={t("listening.form.assignee")}
              value={assigneeAccountId}
              onChange={(e) => {
                setAssigneeTouched(true);
                setAssigneeAccountId(e.target.value);
              }}
              placeholder="712020:…"
              hint={
                botAccountId
                  ? t("listening.form.assignee_hint_auto")
                  : t("listening.form.assignee_hint")
              }
            />
            <Select
              label={t("listening.form.matchKind")}
              value={matchKind}
              onChange={(e) => {
                // Switching the question invalidates the answer: an issue-type
                // name is not a status name, and a value left over from the
                // previous kind would silently save a rule that matches nothing.
                setMatchKind(e.target.value as MatchKind);
                setMatchValue("");
              }}
              options={[
                { value: "issuetype", label: t("listening.match.issuetype") },
                { value: "status", label: t("listening.match.status") },
                { value: "assigned", label: t("listening.match.assigned") },
              ]}
              hint={matchKind === "assigned" ? t("listening.match.assigned_hint") : undefined}
            />
            {/* "Bota atanan her ticket" has no value to give, so the field is
                absent rather than disabled — a greyed box reads as a form the
                operator failed to finish. */}
            {matchKind === "assigned" ? null : valueOptions.length > 0 ? (
              <Select
                label={t("listening.form.matchValue")}
                value={matchValue}
                onChange={(e) => setMatchValue(e.target.value)}
                // `value` is the Turkish name Jira serves and the rule stores;
                // `label` adds the English one for the reader. They are
                // DELIBERATELY different strings — a dropdown whose value was
                // "Görev (Task)" would write a matchValue no ticket can equal,
                // which is the bug this screen was fixed for today.
                options={[
                  { value: "", label: t("listening.form.matchValue_choose") },
                  ...valueOptions.map((v) => ({ value: v, label: matchValueLabel(v) })),
                ]}
                hint={
                  valuesDegradedKey !== undefined
                    ? t(valuesDegradedKey)
                    : t("listening.form.matchValue_hint_auto")
                }
              />
            ) : (
              <Input
                label={t("listening.form.matchValue")}
                value={matchValue}
                onChange={(e) => setMatchValue(e.target.value)}
                placeholder={matchKind === "issuetype" ? "Hata" : "Analiz Bekliyor"}
                hint={t("listening.form.matchValue_hint")}
              />
            )}
            <Select
              label={t("listening.form.flow")}
              value={flowType}
              onChange={(e) => setFlowType(e.target.value as FlowType)}
              options={[
                { value: "analiz", label: t("listening.flow.analiz") },
                { value: "duzeltme", label: t("listening.flow.duzeltme") },
                { value: "gelistirme", label: t("listening.flow.gelistirme") },
              ]}
              hint={t(`listening.flow.hint.${flowType}`)}
            />
            <Select
              label={t("listening.agent.analyst")}
              value={analystVariantId}
              onChange={(e) => setAnalystVariantId(e.target.value)}
              options={[
                { value: "", label: t("listening.agent.default") },
                ...analystOptions.map((v) => ({ value: v.variantId, label: v.variantId })),
              ]}
              hint={t("listening.agent.hint")}
            />
            <Select
              label={t("listening.agent.engineer")}
              value={engineerVariantId}
              onChange={(e) => setEngineerVariantId(e.target.value)}
              options={[
                { value: "", label: t("listening.agent.default") },
                ...engineerOptions.map((v) => ({ value: v.variantId, label: v.variantId })),
              ]}
              hint={t("listening.agent.hint")}
            />
          </div>

          {/* The Jira status map. Collapsed, and OPT-IN: the checkbox inside is
              off unless the rule being edited already has a map, because
              comment-only is what every rule does today and a form must not
              start moving a bank's tickets because it rendered.
              `open` is CONTROLLED (with onToggle), not left to the browser: the
              disclosure has to spring open by itself when "Düzenle" loads a rule
              that already has a map — a configured map hidden behind a closed
              summary is exactly the invisibility this screen is here to fix. */}
          <details
            className="scr-adv"
            style={{ marginTop: 14 }}
            open={statusPanelOpen}
            onToggle={(e) => setStatusPanelOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="scr-adv__summary">{t("listening.status.summary")}</summary>
            <div style={{ padding: "12px 2px 2px" }}>
              <p className="screen-note" style={{ marginTop: 0 }}>
                {t("listening.status.intro")}
              </p>
              <label
                className="screen-note"
                style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 0" }}
              >
                <input
                  type="checkbox"
                  checked={statusOn}
                  onChange={(e) => {
                    setStatusOn(e.target.checked);
                    // Turning it off never rewrites what was typed — the draft
                    // is kept so re-opening restores it. Only what `onSubmit`
                    // builds depends on the toggle.
                  }}
                />
                {t("listening.status.enable")}
              </label>

              {statusOn && (
                <>
                  <p className="screen-note">{t("listening.status.exact")}</p>
                  <div className="screen-filters" style={{ marginTop: 10 }}>
                    {STATUS_POINTS.map((point) => {
                      // Dead for the selected flow: disabled, never hidden, and
                      // the hint is the REASON. An operator who mapped five
                      // points on an analiz rule and now writes a düzeltme one
                      // should read WHY this rule has three, not wonder where
                      // two fields went. A value the draft still holds there
                      // stays visible; the warning below and `buildStatusMap`
                      // handle what happens to it on save.
                      const dead = !livePoints.has(point);
                      const hint = dead
                        ? t("listening.status.dead_hint")
                        : t(`listening.status.hint.${point}`);
                      return statusOptions.length > 0 ? (
                        <Select
                          key={point}
                          label={t(`listening.status.${point}`)}
                          value={statusDraft[point]}
                          onChange={(e) => setStatusAt(point, e.target.value)}
                          disabled={dead}
                          options={[
                            { value: "", label: t("listening.status.skip") },
                            ...statusOptions.map((v) => ({ value: v, label: v })),
                          ]}
                          hint={hint}
                        />
                      ) : (
                        // Jira's status list could not be read (no connection,
                        // no project picked yet, project unreadable). Free text
                        // rather than an empty dropdown, so the map can still be
                        // written — the "birebir aynı" warning above is what
                        // carries the risk in that case.
                        <Input
                          key={point}
                          label={t(`listening.status.${point}`)}
                          value={statusDraft[point]}
                          onChange={(e) => setStatusAt(point, e.target.value)}
                          disabled={dead}
                          hint={hint}
                        />
                      );
                    })}
                  </div>
                  {/* Values parked at dead points — an older rule's stored
                      `onReview`, or text typed before the flow was switched.
                      Saving will NOT write them, and that must be said before
                      the save, in the operator's language, naming the exact
                      values: a stored configuration vanishing without a word is
                      the same silent dishonesty this gating exists to end. */}
                  {deadDraftEntries.length > 0 && (
                    <div className="scr-note scr-note--warn" style={{ marginTop: 10 }}>
                      {t("listening.status.dead_warning", {
                        values: deadDraftEntries
                          .map((e) => `${t(`listening.status.${e.point}`)}: ${e.value}`)
                          .join(", "),
                      })}
                    </div>
                  )}
                  <label
                    className="screen-note"
                    style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}
                  >
                    <input
                      type="checkbox"
                      checked={reassignOnNeedInfo}
                      onChange={(e) => setReassignOnNeedInfo(e.target.checked)}
                    />
                    {t("listening.status.reassign")}
                  </label>
                  <p className="screen-note" style={{ marginTop: 4 }}>
                    {t("listening.status.reassign_hint")}
                  </p>
                </>
              )}
            </div>
          </details>

          <div className="screen-actions">
            <Button
              variant="primary"
              busy={create.isPending || update.isPending}
              onClick={onSubmit}
            >
              {editingRuleId === null ? t("listening.action.add") : t("listening.action.save")}
            </Button>
            {editingRuleId !== null && (
              <Button size="sm" onClick={cancelEdit}>
                {t("listening.action.cancel_edit")}
              </Button>
            )}
          </div>
        </Card>
      )}

      <Card padded={false}>
        <QueryState
          isPending={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          skeletonRows={3}
        >
          <Table
            columns={columns}
            rows={rules}
            rowKey={(r) => r.ruleId}
            emptyLabel={t("listening.empty")}
          />
        </QueryState>
      </Card>
    </div>
  );
}

/**
 * A Jira accountId is `<siteId>:<uuid>` — ~40 chars that blow out the column and
 * carry no meaning at a glance. Show the leading segment and an ellipsis; the
 * full value stays in the cell's `title` for anyone who needs to copy it.
 */
function shortAccount(accountId: string): string {
  if (accountId.length <= 14) return accountId;
  return `${accountId.slice(0, 12)}…`;
}
