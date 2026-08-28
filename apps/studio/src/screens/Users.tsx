import { ROLES, type Role } from "@maestro/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { ApiError, messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Modal, Table, useToast } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import {
  ASSIGNABLE_GROUPS,
  type CreateUserRequest,
  type DirectoryUser,
  type EditUserRequest,
  type PasswordViolation,
  ROLE_BY_GROUP,
  type UsersView,
} from "./common/index.ts";
import { ConfirmModal, QueryState, useEnumLabel } from "./common/index.ts";

const ROLE_TONE: Readonly<Record<Role, BadgeTone>> = {
  admin: "purple",
  "tech-lead": "blue",
  "product-owner": "teal",
  qa: "orange",
  developer: "green",
  viewer: "gray",
};

/**
 * The tone for a role that arrived on the wire.
 *
 * `roles` is typed `readonly string[]` because the directory owns group names
 * and may carry one outside the contract's six roles. A missing tone must not
 * become `undefined` (an unstyled badge) or borrow a known role's colour (an
 * authority the platform never granted). Neutral grey is the honest answer.
 */
function roleTone(role: string): BadgeTone {
  return Object.hasOwn(ROLE_TONE, role) ? ROLE_TONE[role as Role] : "gray";
}

/**
 * Separation-of-duty rules (M32/M92) as the platform enforces them. Static
 * because they are properties of the workflow engine — `canDecideGate` in
 * contracts is the same fact in code.
 */
const SOD_RULES = [
  "producer_approver",
  "po_tl",
  "approver_merger",
  "qa_split",
  "ai_cannot_approve",
] as const;

interface Draft {
  /** The account being edited, or `null` for a brand-new one. */
  readonly editing: DirectoryUser | null;
}

/**
 * User administration (M8/M86).
 *
 * Admin-only, and a real management surface: the directory is still the source
 * of truth for AUTHORITY — roles are derived from group membership, never typed
 * in — but the platform's local accounts are created, edited and off-boarded
 * here, which is what the bank needs to onboard people without a shell on the
 * BFF. Off-boarding DEACTIVATES rather than deletes: a departed approver's name
 * is on closed gates, so the row survives its revocation (see the BFF's DELETE
 * route). Roles still come from groups; the "add user" form offers groups, and
 * the role badges that appear are the platform's reading of them.
 */
export function UsersScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deactivating, setDeactivating] = useState<DirectoryUser | null>(null);

  const users = useQuery({
    queryKey: ["studio-users"],
    queryFn: ({ signal }) => api.get<UsersView>("/studio/users", { signal }),
  });

  const columns: readonly Column<DirectoryUser>[] = [
    {
      key: "username",
      header: t("users.col.username"),
      // The readable name leads and the username follows it, rather than the
      // username leading alone. For a person the two are the same string and
      // nothing changes visually; for the Jira bot the heading becomes
      // "maestro (Jira bot)" instead of the slug `jira-bot-maestro`, which is
      // the whole point of provisioning it with a name. The username is still
      // shown — it is what an admin types into every other surface — but as the
      // secondary line beside the actor id.
      cell: (row) => {
        // `?? username` even though the BFF always sends a name: this screen
        // also has to render a directory served by an OLDER BFF, where the
        // field does not exist. Rendering `undefined` as the heading turns a
        // cosmetic gap into a row with no name at all, which reads as a broken
        // account rather than an unnamed one.
        const name = row.displayName ?? row.username;
        return (
          <div>
            <b>{name}</b>
            <div className="scr-mono scr-mini">
              {name === row.username ? row.userId : `${row.username} · ${row.userId}`}
            </div>
          </div>
        );
      },
    },
    {
      key: "groups",
      header: t("users.col.groups"),
      cell: (row) => (
        <span className="scr-mono scr-mini">
          {row.groups.join(", ") || t("users.value.none")}
        </span>
      ),
    },
    {
      key: "roles",
      header: t("users.col.roles"),
      cell: (row) => <RoleBadges user={row} />,
    },
    {
      key: "state",
      header: t("users.col.state"),
      cell: (row) =>
        row.active ? (
          <Badge tone="green">{t("users.state.active")}</Badge>
        ) : (
          <Badge tone="red">{t("users.state.disabled")}</Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      cell: (row) => (
        <span className="scr-row" style={{ gap: 6, justifyContent: "flex-end" }}>
          <Button size="sm" onClick={() => setDraft({ editing: row })}>
            {t("users.action.edit")}
          </Button>
          {row.active && (
            <Button size="sm" variant="danger" onClick={() => setDeactivating(row)}>
              {t("users.action.deactivate")}
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="scr-stack">
      <Card
        title={t("users.card.list")}
        subtitle={t("users.card.list_sub")}
        padded={false}
        actions={
          <Button variant="primary" size="sm" onClick={() => setDraft({ editing: null })}>
            {t("users.action.add")}
          </Button>
        }
      >
        <QueryState
          isPending={users.isPending}
          error={users.error}
          onRetry={() => void users.refetch()}
          skeletonRows={4}
        >
          <Table
            columns={columns}
            rows={users.data?.items ?? []}
            rowKey={(row) => row.username}
            emptyLabel={t("users.empty")}
            caption={t("users.card.list")}
          />
        </QueryState>
      </Card>

      <Card title={t("users.card.roles")} subtitle={t("users.card.roles_sub")}>
        <dl className="scr-kv">
          {ROLES.map((role) => (
            <div key={role} style={{ display: "contents" }}>
              <dt>
                <Badge tone={ROLE_TONE[role]}>{t(`role.${role}`)}</Badge>
              </dt>
              <dd>{t(`role.${role}.desc`)}</dd>
            </div>
          ))}
        </dl>
        <div className="scr-note" style={{ marginTop: 12 }}>
          {t("users.note.directory_owns_roles")}
        </div>
      </Card>

      <Card title={t("users.card.sod")} subtitle={t("users.card.sod_sub")}>
        <ul className="scr-stack" style={{ gap: 7, margin: 0, paddingLeft: 18 }}>
          {SOD_RULES.map((rule) => (
            <li key={rule} className="scr-prose" style={{ margin: 0 }}>
              {t(`users.sod.${rule}`)}
            </li>
          ))}
        </ul>
        <div className="scr-note" style={{ marginTop: 12 }}>
          {t("users.note.ai_cannot_approve")}
        </div>
      </Card>

      {draft !== null && (
        <UserFormModal
          editing={draft.editing}
          onClose={() => setDraft(null)}
          onSaved={() => setDraft(null)}
        />
      )}

      {deactivating !== null && (
        <DeactivateModal user={deactivating} onClose={() => setDeactivating(null)} />
      )}
    </div>
  );
}

function RoleBadges({ user }: { readonly user: DirectoryUser }): ReactNode {
  const t = useT();
  const enumLabel = useEnumLabel();

  if (user.roles.length === 0) return <span className="scr-mini">{t("users.value.none")}</span>;

  return (
    <span className="scr-row" style={{ gap: 6, flexWrap: "wrap" }}>
      {user.roles.map((role) => {
        const label = enumLabel("role", role);
        // A disabled account's roles are struck through and muted — a purple
        // `admin` badge in its normal register would say "still privileged",
        // the opposite of what a revocation means.
        const tone = label.unknown || !user.active ? "gray" : roleTone(role);
        return (
          <Badge key={role} tone={tone}>
            {user.active ? (
              label.text
            ) : (
              <s title={t("users.note.role_not_in_force")}>{label.text}</s>
            )}
          </Badge>
        );
      })}
    </span>
  );
}

/**
 * Create or edit. One modal for both: the only difference is the username and
 * password fields, which an edit hides — the password is never re-keyed as a
 * side effect of editing groups, and the username of an existing account is its
 * identity and cannot move.
 */
function UserFormModal({
  editing,
  onClose,
  onSaved,
}: {
  readonly editing: DirectoryUser | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isEdit = editing !== null;

  const [username, setUsername] = useState(editing?.username ?? "");
  const [displayName, setDisplayName] = useState(editing?.username ?? "");
  const [password, setPassword] = useState("");
  const [groups, setGroups] = useState<readonly string[]>(editing?.groups ?? []);
  const [violations, setViolations] = useState<readonly PasswordViolation[]>([]);
  const [touched, setTouched] = useState(false);

  const save = useMutation({
    mutationFn: (): Promise<DirectoryUser> => {
      if (isEdit) {
        const body: EditUserRequest = { displayName, groups };
        return api.put<DirectoryUser>(
          `/studio/users/${encodeURIComponent(editing.username)}`,
          body,
        );
      }
      const body: CreateUserRequest = { username, displayName, groups, password };
      return api.post<DirectoryUser>("/studio/users", body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["studio-users"] });
      toast.show("success", t(isEdit ? "users.toast.edited" : "users.toast.created"));
      onSaved();
    },
    onError: (error) => {
      // A weak password comes back with the exact rules it broke — show them
      // inline against the field rather than as a single opaque toast.
      if (error instanceof ApiError && error.code === "password_policy") {
        setViolations(readViolations(error.details));
        return;
      }
      toast.show("error", t(messageKeyOf(error)));
    },
  });

  const toggleGroup = (group: string): void => {
    setGroups((current) =>
      current.includes(group) ? current.filter((g) => g !== group) : [...current, group],
    );
  };

  const nameInvalid = username.trim() === "";
  const displayInvalid = displayName.trim() === "";
  const passwordInvalid = !isEdit && password === "";
  const blocked = (!isEdit && (nameInvalid || passwordInvalid)) || displayInvalid;

  const submit = (): void => {
    setTouched(true);
    setViolations([]);
    if (blocked) return;
    save.mutate();
  };

  // The derived roles preview, so an admin sees what the groups they picked will
  // grant BEFORE saving — the same reading the BFF does server-side.
  const previewRoles = derivePreviewRoles(groups);

  return (
    <Modal
      open
      onClose={onClose}
      title={t(isEdit ? "users.modal.edit_title" : "users.modal.add_title")}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant="primary" busy={save.isPending} onClick={submit}>
            {t(isEdit ? "users.action.save" : "users.action.add")}
          </Button>
        </>
      }
    >
      {!isEdit && (
        <Input
          label={t("users.field.username")}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          hint={t("users.field.username_hint")}
          {...(touched && nameInvalid ? { error: t("users.error.username_required") } : {})}
        />
      )}

      <Input
        label={t("users.field.display_name")}
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        {...(touched && displayInvalid ? { error: t("users.error.display_required") } : {})}
      />

      {!isEdit && (
        <Input
          label={t("users.field.password")}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint={t("users.field.password_hint")}
          {...(touched && passwordInvalid ? { error: t("users.error.password_required") } : {})}
        />
      )}

      {violations.length > 0 && (
        <div className="scr-note scr-note--danger" style={{ marginTop: 8 }}>
          <div>{t("users.error.password_policy")}</div>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {violations.map((rule) => (
              <li key={rule}>{t(`users.password.${rule}`)}</li>
            ))}
          </ul>
        </div>
      )}

      <fieldset className="scr-fieldset" style={{ marginTop: 12 }}>
        <legend className="ui-field__label">{t("users.field.groups")}</legend>
        <div className="scr-mini" style={{ marginBottom: 8 }}>{t("users.field.groups_hint")}</div>
        <div className="scr-checklist">
          {ASSIGNABLE_GROUPS.map((group) => {
            const role = ROLE_BY_GROUP[group] ?? "viewer";
            return (
              <label key={group} className="scr-check" style={{ alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={groups.includes(group)}
                  onChange={() => toggleGroup(group)}
                />
                <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span className="scr-row" style={{ gap: 6, alignItems: "center" }}>
                    <b>{t(`users.group.${group}`).split(" — ")[0]}</b>
                    <Badge tone={roleTone(role)}>{t(`role.${role}`)}</Badge>
                    <span className="scr-mono scr-mini">{group}</span>
                  </span>
                  <span className="scr-mini">{t(`users.group.${group}`)}</span>
                </span>
              </label>
            );
          })}
        </div>
        <div className="scr-mini" style={{ marginTop: 8 }}>
          {t("users.field.roles_preview")}:{" "}
          {previewRoles.map((role) => t(`role.${role}`)).join(", ")}
        </div>
      </fieldset>
    </Modal>
  );
}

function DeactivateModal({
  user,
  onClose,
}: {
  readonly user: DirectoryUser;
  readonly onClose: () => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();

  const deactivate = useMutation({
    mutationFn: () =>
      api.delete<DirectoryUser>(`/studio/users/${encodeURIComponent(user.username)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["studio-users"] });
      toast.show("warning", t("users.toast.deactivated", { username: user.username }));
      onClose();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  return (
    <ConfirmModal
      open
      onClose={onClose}
      onConfirm={() => deactivate.mutate()}
      title={t("users.confirm.deactivate_title")}
      description={t("users.confirm.deactivate_desc", { username: user.username })}
      confirmLabel={t("users.action.deactivate")}
      destructive
      busy={deactivate.isPending}
    >
      <div className="scr-note scr-note--warn">{t("users.confirm.deactivate_warning")}</div>
    </ConfirmModal>
  );
}

/** Roles the given groups grant, mirroring the BFF's `rolesOf` for the preview. */
function derivePreviewRoles(groups: readonly string[]): readonly Role[] {
  const roles = new Set<Role>(["viewer"]);
  for (const group of groups) {
    const role = ROLE_BY_GROUP[group];
    if (role !== undefined) roles.add(role);
  }
  return [...roles];
}

/** The failed-rule list from `password_policy.details`, defensively narrowed. */
function readViolations(details: unknown): readonly PasswordViolation[] {
  if (typeof details !== "object" || details === null) return [];
  const value = (details as { violations?: unknown }).violations;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PasswordViolation => typeof entry === "string");
}
