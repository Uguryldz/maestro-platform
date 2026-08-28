import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { LlmRole, type LlmRole as LlmRoleType } from "@maestro/contracts";
import { messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";
import { hasRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Modal, Select, Table, useToast } from "../ui/index.ts";
import { TextArea } from "./shared/TextArea.tsx";
import { useEnumLabel } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { parseKnowledge } from "./variants/knowledge.ts";

/**
 * Screen: variants — the agent variant catalogue (7 roles × platform).
 *
 * Versions are immutable: a new version is published and can be rolled back in
 * one step, and running workflows finish on the version they started with.
 *
 * An admin creates a variant here; editing the platform and publishing a new
 * version live on the detail screen. Every write is admin-only — the persona
 * and model an agent runs under decide what the AI does on every ticket — and
 * the BFF enforces that regardless of what this UI shows.
 */

export interface AgentVariant {
  readonly variantId: string;
  readonly role: LlmRoleType;
  readonly platform: string;
  readonly model: string;
  readonly activeVersion: number;
  readonly knowledgeFiles: number;
  /** Latest golden-ticket eval score, or null when never evaluated. */
  readonly evalScore: number | null;
}

export function VariantsScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const { session } = useAuth();
  const enumLabel = useEnumLabel();
  const navigate = useNavigate();
  const isAdmin = hasRole(session, "admin");
  const [creating, setCreating] = useState(false);

  const query = useQuery({
    queryKey: ["variants"],
    queryFn: ({ signal }) => api.get<{ variants: readonly AgentVariant[] }>("/variants", { signal }),
  });

  return (
    <>
      <Card
        title={t("variants.catalogue")}
        subtitle={t("variants.catalogue_sub")}
        padded={false}
        actions={
          isAdmin ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              {t("variants.action.add")}
            </Button>
          ) : undefined
        }
      >
        <MaybeUnwired
          isPending={query.isPending}
          error={query.error}
          isEmpty={(query.data?.variants ?? []).length === 0}
          emptyTitle={t("variants.empty")}
          onRetry={() => void query.refetch()}
        >
          <Table
            columns={[
              {
                key: "variant",
                header: t("variants.col.variant"),
                cell: (row: AgentVariant) => row.variantId,
              },
              {
                key: "role",
                header: t("variants.col.role"),
                cell: (row) => enumLabel("llm.role", row.role).text,
              },
              { key: "platform", header: t("variants.col.platform"), cell: (row) => row.platform },
              {
                key: "model",
                header: t("variants.col.model"),
                cell: (row) => <code>{row.model}</code>,
              },
              {
                key: "version",
                header: t("variants.col.version"),
                cell: (row) => <Badge tone="blue">v{row.activeVersion}</Badge>,
              },
              {
                key: "knowledge",
                header: t("variants.col.knowledge"),
                cell: (row) => t("variants.n_files", { n: String(row.knowledgeFiles) }),
                align: "right",
              },
              {
                key: "eval",
                header: t("variants.col.eval"),
                // null is "never evaluated", which is not the same as a score of
                // zero and must not be rendered as one.
                cell: (row) =>
                  row.evalScore === null ? (
                    <Badge tone="gray">{t("variants.never_evaluated")}</Badge>
                  ) : (
                    <Badge tone={row.evalScore >= 90 ? "green" : "amber"}>{String(row.evalScore)}</Badge>
                  ),
                align: "right",
              },
            ]}
            rows={query.data?.variants ?? []}
            rowKey={(row) => row.variantId}
            onRowClick={(row) => void navigate(`/variant?id=${encodeURIComponent(row.variantId)}`)}
            emptyLabel={t("variants.empty")}
          />
        </MaybeUnwired>
      </Card>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("variants.immutable_note")}
      </p>

      {creating && (
        <CreateVariantModal
          onClose={() => setCreating(false)}
          onCreated={(variantId) => {
            setCreating(false);
            void navigate(`/variant?id=${encodeURIComponent(variantId)}`);
          }}
        />
      )}
    </>
  );
}

/** The roles a variant may take (M17/M43), from the frozen contract. */
const ROLE_OPTIONS = LlmRole.options;

/**
 * The roles the ENGINE actually runs today: intake (fitness gate), analyst and
 * engineer. The other four exist in the frozen contract but nothing executes
 * them yet, so the create modal lists them DISABLED with a "(yakında)" mark —
 * visible so the roadmap is honest, unselectable so an admin cannot configure
 * an agent that would never run.
 */
const LIVE_ROLES: ReadonlySet<LlmRoleType> = new Set(["intake", "analyst", "engineer"]);

function CreateVariantModal({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: (variantId: string) => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const enumLabel = useEnumLabel();

  const [variantId, setVariantId] = useState("");
  const [role, setRole] = useState<LlmRoleType>("analyst");
  const [platform, setPlatform] = useState("web");
  const [model, setModel] = useState("claude-opus-5");
  const [persona, setPersona] = useState("");
  const [knowledge, setKnowledge] = useState("");
  const [note, setNote] = useState(t("variants.create.first_note"));
  const [touched, setTouched] = useState(false);

  const idInvalid = !/^[a-z0-9][a-z0-9-]*$/.test(variantId.trim());
  const platformInvalid = platform.trim() === "";
  const modelInvalid = model.trim() === "";
  const blocked = idInvalid || platformInvalid || modelInvalid;

  const create = useMutation({
    mutationFn: () =>
      api.post<AgentVariant>("/variants", {
        variantId: variantId.trim(),
        role,
        platform: platform.trim(),
        model: model.trim(),
        persona,
        knowledgeRefs: parseKnowledge(knowledge),
        note: note.trim(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["variants"] });
      toast.show("success", t("variants.toast.created", { id: variantId.trim() }));
      onCreated(variantId.trim());
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const submit = (): void => {
    setTouched(true);
    if (blocked) return;
    create.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("variants.create.title")}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant="primary" busy={create.isPending} onClick={submit}>
            {t("variants.action.add")}
          </Button>
        </>
      }
    >
      <Input
        label={t("variants.field.id")}
        value={variantId}
        onChange={(event) => setVariantId(event.target.value)}
        hint={t("variants.field.id_hint")}
        {...(touched && idInvalid ? { error: t("variants.error.id") } : {})}
      />
      <Select
        label={t("variants.field.role")}
        value={role}
        onChange={(event) => setRole(event.target.value as LlmRoleType)}
        options={ROLE_OPTIONS.map((option) => {
          const live = LIVE_ROLES.has(option);
          const text = enumLabel("llm.role", option).text;
          return {
            value: option,
            label: live ? text : t("variants.role.soon", { role: text }),
            disabled: !live,
          };
        })}
      />
      <Input
        label={t("variants.field.platform")}
        value={platform}
        onChange={(event) => setPlatform(event.target.value)}
        hint={t("variants.field.platform_hint")}
        {...(touched && platformInvalid ? { error: t("variants.error.platform") } : {})}
      />
      <Input
        label={t("variants.field.model")}
        value={model}
        onChange={(event) => setModel(event.target.value)}
        {...(touched && modelInvalid ? { error: t("variants.error.model") } : {})}
      />
      <TextArea
        label={t("variants.field.persona")}
        rows={8}
        value={persona}
        onChange={(event) => setPersona(event.target.value)}
        hint={t("variants.field.persona_hint")}
      />
      <TextArea
        label={t("variants.field.knowledge")}
        rows={3}
        value={knowledge}
        onChange={(event) => setKnowledge(event.target.value)}
        hint={t("variants.field.knowledge_hint")}
      />
      <Input
        label={t("variants.field.note")}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
    </Modal>
  );
}
