import { CONNECTION_KIND_SPECS, missingConfigKeys } from "@maestro/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useApi } from "../../auth/AuthProvider.tsx";
import { useAuth } from "../../auth/AuthProvider.tsx";
import { hasRole } from "../../auth/types.ts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Modal, Select, Table, useToast } from "../../ui/index.ts";
import type { BadgeTone, Column } from "../../ui/index.ts";
import type {
  ConnectionTestResponse,
  ManagedConnection,
  ManagedConnectionAuthKind,
  ManagedConnectionInput,
  ManagedConnectionKind,
} from "../common/index.ts";
import { ConfirmModal, QueryState } from "../common/index.ts";
import { ageLabel } from "../shared/format.ts";

/**
 * The connector-management section of the settings screen.
 *
 * The platform's outbound connections, made admin-editable: add a URL + token,
 * test it LIVE, and see the token only as a mask (****abcd). Everything a leak
 * would need is designed out — the token is write-only in the form, the API
 * never returns it, and the live test runs server-side against the STORED
 * credential. The whole section is admin-gated; a viewer never sees it.
 */

const KINDS: readonly ManagedConnectionKind[] = [
  "jira_cloud",
  "jira_dc",
  "github",
  "ado",
  "openrouter",
  "anthropic",
  "openai_compat",
  "vault",
  "smtp",
  "storage",
];

/** The order the screen lists families in — required first, optional last. */
const FAMILIES = ["issue_tracker", "model", "scm", "infra"] as const;

/**
 * The live-test result held per row so the screen can render it inline.
 *
 * `warn` marks a test that CONNECTED but found the stored bot account did not
 * belong to the token. It is not a failure and not a clean pass: the credential
 * works, yet anything keyed to the old account id — listening rules, four-eyes
 * exemptions, comment attribution — was pointing at the wrong person.
 */
type TestState = Readonly<Record<string, { ok: boolean; warn?: boolean; text: string } | "testing">>;

export function ConnectorsPanel(): ReactNode {
  const api = useApi();
  const t = useT();
  const { session } = useAuth();
  const isAdmin = hasRole(session, "admin");
  const [editing, setEditing] = useState<ManagedConnection | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ManagedConnection | null>(null);
  const [tests, setTests] = useState<TestState>({});
  const toast = useToast();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly ManagedConnection[] }>("/studio/connections", { signal }),
  });

  const test = useMutation({
    mutationFn: (id: string) => api.post<ConnectionTestResponse>(`/studio/connections/${id}/test`),
    onMutate: (id) => setTests((prev) => ({ ...prev, [id]: "testing" })),
    onSuccess: (result, id) => {
      const text = t(result.messageKey, result.messageParams ?? {});
      const corrected = result.botAccountCorrected !== undefined;
      setTests((prev) => ({ ...prev, [id]: { ok: result.ok, warn: corrected, text } }));
      // A silently-fixed identity is exactly the thing an operator would miss in
      // a table cell, so it also gets a toast they have to dismiss.
      if (corrected) toast.show("error", text);
      void queryClient.invalidateQueries({ queryKey: ["connections"] });
    },
    onError: (error, id) => {
      setTests((prev) => ({ ...prev, [id]: { ok: false, text: t(messageKeyOf(error)) } }));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/studio/connections/${id}`),
    onSuccess: (_void, id) => {
      void queryClient.invalidateQueries({ queryKey: ["connections"] });
      toast.show("success", t("connections.toast.deleted", { name: id }));
      setDeleting(null);
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const columns: readonly Column<ManagedConnection>[] = [
    {
      key: "name",
      header: t("connections.col.name"),
      cell: (row) => (
        <div>
          <b>{row.displayName}</b>
          <div className="scr-mono scr-mini">{t(`connections.kind.${row.kind}`)}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: t("connections.col.status"),
      cell: (row) => {
        const live = tests[row.id];
        if (live === "testing") return <Badge tone="gray">…</Badge>;
        // A just-run test wins the cell; otherwise the last recorded result.
        const ok = live !== undefined ? live.ok : row.lastTestOk;
        const { tone, icon, key } = statusOf(ok, live !== undefined && live.warn === true);
        // Under the badge: when the test was last run, and — on failure — WHY,
        // from the secret-free note. A just-run test shows its own text; the
        // stored note (a catalog key) is translated. Never a token/DSN.
        const age = ageLabel(row.lastTestedAt);
        // A corrected bot account reads out in full here too — the badge alone
        // cannot carry two 36-char ids, and "which id replaced which" is the
        // whole point of telling the operator.
        const failNote =
          live === undefined && row.lastTestOk === false && row.lastTestNote !== null
            ? renderNote(t, row.lastTestNote)
            : live !== undefined && (!live.ok || live.warn === true)
              ? live.text
              : null;
        return (
          <div>
            <Badge tone={tone} icon={icon}>
              {live !== undefined ? live.text : t(key)}
            </Badge>
            {(age !== null || failNote !== null) && (
              <div className="scr-mini" style={{ marginTop: 3 }}>
                {age !== null && <span>{t(age.key, age.params)}</span>}
                {failNote !== null && (
                  <span style={{ color: "var(--red)" }}>
                    {age !== null ? " · " : ""}
                    {failNote}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "url",
      header: t("connections.col.url"),
      cell: (row) => <span className="scr-mono scr-mini">{row.baseUrl}</span>,
    },
    {
      key: "token",
      header: t("connections.col.token"),
      cell: (row) =>
        row.secretSet ? (
          <span className="scr-mono scr-mini">{`****${row.secretMask ?? ""}`}</span>
        ) : (
          <span className="scr-mini">{t("connections.token.unset")}</span>
        ),
    },
    {
      key: "actions",
      header: "",
      cell: (row) =>
        isAdmin ? (
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <Button size="sm" busy={tests[row.id] === "testing"} onClick={() => test.mutate(row.id)}>
              🔌 {t("connections.action.test")}
            </Button>
            <Button size="sm" onClick={() => setEditing(row)}>
              {t("connections.action.edit")}
            </Button>
            <Button size="sm" variant="danger" onClick={() => setDeleting(row)}>
              {t("connections.action.delete")}
            </Button>
          </div>
        ) : null,
      align: "right",
    },
  ];

  return (
    <>
      <Card
        title={t("connections.card.title")}
        subtitle={t("connections.card.sub")}
        padded={false}
        actions={
          isAdmin ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              ➕ {t("connections.action.add")}
            </Button>
          ) : undefined
        }
      >
        <QueryState
          isPending={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          skeletonRows={3}
        >
          {/*
            Grouped by family rather than one flat ten-row table.
            The families are not decoration: the analysis flow REQUIRES an issue
            tracker and a model, and works without a repository — the subtitles
            say so, which is the question operators kept asking.
          */}
          {FAMILIES.map((family) => {
            const rows = (query.data?.connections ?? []).filter(
              (row) => CONNECTION_KIND_SPECS[row.kind].family === family,
            );
            return (
              <section key={family} style={{ marginBottom: 20 }}>
                <h3 className="scr-mini" style={{ margin: "0 0 2px", fontWeight: 600 }}>
                  {t(`connections.family.${family}`)}
                </h3>
                <div className="scr-mini" style={{ opacity: 0.8, margin: "0 0 8px", lineHeight: 1.5 }}>
                  {t(`connections.family.${family}_sub`)}
                </div>
                <Table
                  columns={columns}
                  rows={rows}
                  rowKey={(row) => row.id}
                  emptyLabel={t("connections.empty_family")}
                  caption={t(`connections.family.${family}`)}
                />
              </section>
            );
          })}
        </QueryState>
      </Card>

      {creating && <ConnectionModal onClose={() => setCreating(false)} />}
      {editing !== null && (
        <ConnectionModal connection={editing} onClose={() => setEditing(null)} />
      )}
      {deleting !== null && (
        <ConfirmModal
          open
          onClose={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id)}
          title={t("connections.action.delete")}
          description={t("connections.confirm.delete", { name: deleting.displayName })}
          confirmLabel={t("connections.action.delete")}
          destructive
          busy={remove.isPending}
        />
      )}
    </>
  );
}

/**
 * The badge tone/icon for a tri-state test result.
 *
 * `warn` overrides a pass with amber: the connection is genuinely up, but it
 * corrected a wrong bot account on the way, and a green tick would tell the
 * operator the opposite of what happened.
 */
function statusOf(ok: boolean | null, warn = false): { tone: BadgeTone; icon: string; key: string } {
  if (ok === null) return { tone: "gray", icon: "⚪", key: "connections.status.untested" };
  if (ok && warn) return { tone: "amber", icon: "⚠", key: "connections.status.ok_fixed" };
  return ok
    ? { tone: "green", icon: "●", key: "connections.status.ok" }
    : { tone: "red", icon: "✕", key: "connections.status.fail" };
}

/**
 * The add/edit modal.
 *
 * On edit, the token field starts LOCKED showing the mask — a "değiştir"
 * (change) button reveals an input. This is the whole point: the existing token
 * is never fetched to prefill (the API would refuse), and an untouched save
 * omits `token`, so the stored credential is preserved.
 */
/**
 * Render a STORED test note, which carries its params with it.
 *
 * The server encodes them as `key?host=...` (see `noteWithParams` in the BFF).
 * Rendering the key alone left the operator reading the literal `{host}` in
 * the six diagnostics that interpolate one — correct on the first test, broken
 * on every reload, which is worse than useless because it looks like a bug in
 * the product rather than a missing value.
 */
function renderNote(t: ReturnType<typeof useT>, note: string): string {
  const split = note.indexOf("?");
  if (split === -1) return t(note);
  const key = note.slice(0, split);
  const params: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(note.slice(split + 1))) params[name] = value;
  return t(key, params);
}

function ConnectionModal({
  connection,
  onClose,
}: {
  readonly connection?: ManagedConnection;
  readonly onClose: () => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = connection !== undefined;

  const [id, setId] = useState(connection?.id ?? "");
  const [kind, setKind] = useState<ManagedConnectionKind>(connection?.kind ?? "jira_cloud");
  const [displayName, setDisplayName] = useState(connection?.displayName ?? "");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  /**
   * The kind's non-secret fields, by config key — `email` for Jira Cloud,
   * `model` for the inference kinds, `bucket`/`region` for storage.
   *
   * One state bag driven by `CONNECTION_KIND_SPECS` rather than a `useState`
   * per field: the form used to hold exactly one (`model`), so Jira Cloud's
   * `email` — which its probe REQUIRES to build Basic auth — had nowhere to be
   * typed, and every Jira Cloud row created from Studio failed its test with a
   * 401 that pointed at the token instead of the missing address.
   */
  const [cfg, setCfg] = useState<Record<string, string>>(() => ({ ...(connection?.config ?? {}) }));
  // On edit with a token set, the field is locked until the admin chooses to change it.
  const [changingToken, setChangingToken] = useState(!editing || !(connection?.secretSet ?? false));
  const [token, setToken] = useState("");
  const [touched, setTouched] = useState(false);

  /**
   * Whether this row is a MODEL — the kind that needs a model id, whose API key
   * may legitimately be blank, and which the two new switches below apply to.
   * The three kinds that speak an inference protocol are exactly the three the
   * runtime will accept as the active model (`MODEL_CONNECTION_KINDS`), so a
   * form that offered these fields for a Jira row would be promising something
   * the resolver ignores.
   */
  const spec = CONNECTION_KIND_SPECS[kind];
  const isModelKind = spec.model === true;
  /**
   * Whether the operator ASSERTS this endpoint runs inside the institution.
   *
   * Defaulted from the kind for a new row — a self-hosted server almost always
   * is, a cloud vendor never is — but it stays an explicit switch the admin can
   * override, because the M18 confidential rule leans on this and on nothing
   * else. A URL cannot answer it: a private address is evidence about routing,
   * not a claim about custody.
   */
  const [onPrem, setOnPrem] = useState(connection?.onPrem ?? false);
  const [isDefault, setIsDefault] = useState(connection?.isDefault ?? false);
  /**
   * Skip TLS certificate verification for this connection — for EVERY kind,
   * because the corporate-certificate wall is not a model-server specialty: a
   * bank's Azure DevOps Server and Jira DC sit behind the same in-house CA.
   * Stored in the non-secret `config` bag like `model`, as the string "true",
   * and REMOVED when off — an absent key is the fail-closed default everywhere
   * it is read. The hint owns the honest trade-off (spoofing exposure) and the
   * durable alternative (NODE_EXTRA_CA_CERTS).
   */
  const [skipTlsVerify, setSkipTlsVerify] = useState(
    connection?.config["skipTlsVerify"] === "true",
  );

  const idInvalid = !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id.trim());
  const urlInvalid = !isHttpUrl(baseUrl.trim());
  /**
   * The kind's own required fields, checked HERE by the same table the BFF
   * refuses on (`missingConfigKeys`). Without it the form happily saved a row
   * whose live test could only ever fail.
   */
  const missing = missingConfigKeys(kind, cfg);
  const blocked =
    (!editing && idInvalid) || urlInvalid || displayName.trim() === "" || missing.length > 0;

  /**
   * The non-secret config bag the save sends: the stored bag verbatim (so a
   * learned `botAccountId` survives), the model id layered on for the model
   * kinds, and the TLS switch layered on for all — written as "true" when on,
   * REMOVED when off, so toggling off actually clears the stored flag instead
   * of being lost under the verbatim spread.
   */
  const configBag = (): Record<string, string> => {
    const bag: Record<string, string> = { ...cfg };
    // Trim on the way out, and drop an empty optional rather than storing "".
    for (const field of spec.fields) {
      const value = (bag[field.key] ?? "").trim();
      if (value === "") delete bag[field.key];
      else bag[field.key] = value;
    }
    if (skipTlsVerify) bag["skipTlsVerify"] = "true";
    else delete bag["skipTlsVerify"];
    return bag;
  };

  const save = useMutation({
    mutationFn: () => {
      const body: ManagedConnectionInput & { id?: string } = {
        kind,
        displayName: displayName.trim(),
        baseUrl: baseUrl.trim(),
        // The KIND decides the scheme — `probeFor` hardcodes it and never read
        // this field. It was a four-option picker whose value changed nothing:
        // an operator could select "Bearer" for Jira Cloud and watch it use
        // Basic anyway. Now it is stated, not asked.
        authKind: spec.authKind,
        // `config` is round-tripped verbatim so a learned `botAccountId`
        // survives an edit; the model id is layered on top for the one kind
        // that has one, and the TLS switch for every kind (see `configBag`).
        config: configBag(),
        enabled,
        // Only meaningful for a model row; a Jira connection sends the
        // harmless defaults rather than a field the resolver would ignore.
        onPrem: isModelKind && onPrem,
        isDefault: isModelKind && isDefault,
        // Only send a token when the admin actually entered one — an untouched
        // edit preserves the stored credential.
        // An empty box means two different things by kind. For a self-hosted
        // server it is a real answer — "this endpoint needs no key" — and must
        // be SENT, or the operator can never express it. For every other kind
        // it means "I did not touch this", and must be withheld so the stored
        // credential survives the edit.
        ...(changingToken && (token !== "" || isModelKind) ? { token } : {}),
      };
      return editing
        ? api.put<{ connection: ManagedConnection }>(`/studio/connections/${connection.id}`, body)
        : api.post<{ connection: ManagedConnection }>("/studio/connections", { ...body, id: id.trim() });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connections"] });
      toast.show(
        "success",
        t(editing ? "connections.toast.updated" : "connections.toast.created", {
          name: displayName.trim() || id.trim(),
        }),
      );
      onClose();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const submit = (): void => {
    setTouched(true);
    if (blocked) return;
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t(editing ? "connections.modal.edit_title" : "connections.modal.add_title")}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant="primary" busy={save.isPending} onClick={submit}>
            {t(editing ? "connections.action.edit" : "connections.action.add")}
          </Button>
        </>
      }
    >
      {!editing && (
        <Input
          label={t("connections.field.id")}
          value={id}
          onChange={(event) => setId(event.target.value)}
          hint={t("connections.field.id_hint")}
          {...(touched && idInvalid ? { error: t("connections.error.id") } : {})}
        />
      )}
      <Select
        label={t("connections.field.kind")}
        value={kind}
        onChange={(event) => {
          const next = event.target.value as ManagedConnectionKind;
          setKind(next);
          /**
           * Switching kind used to change a string and nothing else, so an
           * Anthropic URL and a stale `model` key survived a switch to Jira DC
           * and were saved. The config bag is rebuilt for the NEW kind: keys it
           * knows are kept (an operator correcting a typo does not retype), the
           * rest are dropped.
           */
          const keep = new Set(CONNECTION_KIND_SPECS[next].fields.map((f) => f.key));
          setCfg((current) => {
            const rebuilt: Record<string, string> = {};
            for (const [key, value] of Object.entries(current)) {
              if (keep.has(key)) rebuilt[key] = value;
            }
            return rebuilt;
          });
          setOnPrem(CONNECTION_KIND_SPECS[next].family === "infra" ? true : onPrem);
        }}
        options={KINDS.map((option) => ({
          value: option,
          // Grouped by family in the label, because a bare ten-item list gave
          // no clue that jira_cloud and jira_dc are alternatives.
          label: `${t(`connections.family.${CONNECTION_KIND_SPECS[option].family}`)} · ${t(`connections.kind.${option}`)}`,
        }))}
      />
      <div className="scr-mini" style={{ opacity: 0.85 }}>
        {t("connections.auth.fixed", { scheme: spec.authKind })}
        {spec.probeless === true ? ` · ${t("connections.probeless")}` : ""}
      </div>
      <Input
        label={t("connections.field.name")}
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
      />
      <Input
        label={t("connections.field.url")}
        value={baseUrl}
        placeholder={spec.urlExample}
        // Every kind gets an example now. Five of the ten used to show a bare
        // "URL" label, so an operator had no way to know whether Jira wanted
        // the site root or the `/rest/api/3` path.
        hint={isModelKind ? t("connections.field.url_hint_onprem") : spec.urlExample}
        onChange={(event) => setBaseUrl(event.target.value)}
        {...(touched && urlInvalid ? { error: t("connections.error.url") } : {})}
      />
      {/*
        Offered on EVERY kind rather than special-cased per kind: the
        corporate-certificate wall stands in front of an in-house ADO or Jira
        DC exactly as it does a model server, and the hint — not a hidden
        checkbox — is what keeps a cloud connection's admin from flipping it
        by accident.
      */}
      <label className="scr-mini" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={skipTlsVerify}
          onChange={(event) => setSkipTlsVerify(event.target.checked)}
        />
        {t("connections.field.skip_tls")}
      </label>
      <div className="scr-mini" style={{ opacity: 0.85, lineHeight: 1.5 }}>
        {t("connections.field.skip_tls_hint")}
      </div>
      {/*
        The kind's own fields, from `CONNECTION_KIND_SPECS`. This is what makes
        Jira Cloud configurable at all: its probe builds Basic auth from
        `config.email`, and until this loop existed there was no box to type it
        into.
      */}
      {spec.fields.map((field) => (
        <Input
          key={field.key}
          label={t(field.labelKey)}
          value={cfg[field.key] ?? ""}
          onChange={(event) =>
            setCfg((current) => ({ ...current, [field.key]: event.target.value }))
          }
          {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
          {...(field.hintKey === undefined ? {} : { hint: t(field.hintKey) })}
          {...(touched && missing.includes(field.key)
            ? { error: t("connections.error.missing_config", { fields: t(field.labelKey) }) }
            : {})}
        />
      ))}
      {isModelKind && (
        /**
         * The two switches that used to be `.env` variables.
         *
         * What stood here before was an apology: a paragraph telling the
         * operator that the address and model name they had just typed would be
         * tested and then ignored, because the running services read
         * `LLM_BASE_URL`/`LLM_MODEL` from a file. That note is gone because the
         * thing it described is gone — this form now owns all of it.
         *
         * `onPrem` is a SWITCH and not an inference from the URL on purpose: it
         * is the only thing standing between the confidential class and an
         * outside endpoint (M18), so it must be something an operator asserts
         * and an auditor can read.
         */
        <>
          <label className="scr-mini" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={onPrem} onChange={(event) => setOnPrem(event.target.checked)} />
            {t("connections.field.on_prem")}
          </label>
          <div className="scr-mini" style={{ opacity: 0.85, lineHeight: 1.5 }}>
            {t("connections.field.on_prem_hint")}
          </div>
          <label className="scr-mini" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
            />
            {t("connections.field.is_default")}
          </label>
          <div className="scr-mini" style={{ opacity: 0.85, lineHeight: 1.5 }}>
            {t("connections.field.is_default_hint")}
          </div>
        </>
      )}
      <label className="scr-mini" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t("connections.field.enabled")}
      </label>
      {changingToken ? (
        <Input
          label={t("connections.field.token")}
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          hint={t(isModelKind ? "connections.field.token_hint_optional" : "connections.field.token_hint")}
        />
      ) : (
        <div className="scr-mini" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="scr-mono">{`****${connection?.secretMask ?? ""}`}</span>
          <Button size="sm" onClick={() => setChangingToken(true)}>
            {t("connections.token.change")}
          </Button>
        </div>
      )}
    </Modal>
  );
}

/** A permissive http(s) URL check for the form — the BFF validates for real. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
