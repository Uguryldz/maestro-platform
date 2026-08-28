import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { useToast } from "../ui/Toast.tsx";
import { Badge, Button, Card, Input, Table } from "../ui/index.ts";
import { partitionByDataClass, resolveDataClass, type KnowledgeDoc } from "./knowledge/classify.ts";
import { fileToBase64 } from "./shared/file-base64.ts";
import { QueryState } from "./shared/QueryState.tsx";

/** Who may upload/toggle guidance notes. */
const GUIDANCE_WRITE_ROLES = ["admin", "tech-lead"] as const;

interface GuidanceNote {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
  /** Target agent variant; null/absent = global (every agent learns from it). */
  readonly variantId?: string | null;
}

/**
 * Screen: knowledge — search over the shared knowledge library.
 *
 * SECURITY, two layers and both wanted:
 *
 *  1. The BFF filters by data class on the way out and returns `withheld`, the
 *     count it removed for this session's clearance. That is the real control —
 *     withheld documents never reach the browser at all.
 *  2. This screen ALSO fails closed on whatever does arrive: a record whose
 *     `dataClass` is missing or unrecognised is treated as `gizli` and dropped
 *     here (see ./knowledge/classify.ts) rather than shown as public. The server
 *     promises the field is always set; the client should not stake a leak on
 *     that promise surviving every future change.
 *
 * Both counts are surfaced, so an omission is visible rather than a quietly
 * short list.
 *
 * `q` is REQUIRED by the endpoint — it is a search, not a listing — so with an
 * empty box this screen asks for nothing and says so, instead of rendering an
 * inviting empty table for data it never requested.
 */

interface KnowledgeResponse {
  readonly items: readonly KnowledgeDoc[];
  readonly nextCursor: string | null;
  /** How many results the SERVER withheld for this session's clearance. */
  readonly withheld: number;
}

const CLASS_TONE = { acik: "gray", dahili: "blue", gizli: "red" } as const;

export function KnowledgeScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const [text, setText] = useState("");

  const query = text.trim();
  const search = useQuery({
    queryKey: ["knowledge", query],
    enabled: query !== "",
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<KnowledgeResponse>("/studio/knowledge", { query: { q: query }, signal }),
  });

  // Server-side withholding, plus this screen's own fail-closed pass.
  const { visible, withheld: droppedHere } = partitionByDataClass(search.data?.items ?? []);
  const withheldTotal = (search.data?.withheld ?? 0) + droppedHere;

  return (
    <>
      <GuidanceLibrary />

      <Card title={t("knowledge.library")} subtitle={t("knowledge.library_sub")}>
        <Input
          label={t("knowledge.search")}
          value={text}
          onChange={(event) => setText(event.target.value)}
          hint={t("knowledge.search_hint")}
        />
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card
          title={t("knowledge.results")}
          actions={
            withheldTotal > 0 ? (
              <Badge tone="red">{t("knowledge.withheld_n", { n: String(withheldTotal) })}</Badge>
            ) : undefined
          }
          padded={query === ""}
        >
          {query === "" ? (
            <p className="tpl-keyline">{t("knowledge.type_to_search")}</p>
          ) : (
            <QueryState
              isPending={search.isPending}
              error={search.error}
              isEmpty={visible.length === 0}
              emptyTitle={t("knowledge.empty")}
              onRetry={() => void search.refetch()}
            >
              <Table
                columns={[
                  {
                    key: "title",
                    header: t("knowledge.col.file"),
                    cell: (row: KnowledgeDoc) => row.title,
                  },
                  { key: "source", header: t("knowledge.col.source"), cell: (row) => row.source },
                  {
                    key: "class",
                    header: t("knowledge.col.class"),
                    cell: (row) => {
                      const cls = resolveDataClass(row.dataClass);
                      return <Badge tone={CLASS_TONE[cls]}>{t(`data_class.${cls}`)}</Badge>;
                    },
                  },
                  { key: "app", header: t("knowledge.col.app"), cell: (row) => row.appId ?? "—" },
                  {
                    key: "updated",
                    header: t("knowledge.col.updated"),
                    cell: (row) => `${row.updatedBy} · ${row.updatedAt}`,
                  },
                ]}
                rows={visible}
                rowKey={(row) => row.id}
                emptyLabel={t("knowledge.empty")}
              />
            </QueryState>
          )}
        </Card>
      </div>

      {withheldTotal > 0 && (
        <p className="tpl-keyline" style={{ marginTop: 12 }}>
          {t("knowledge.withheld_note")}
        </p>
      )}
    </>
  );
}

/**
 * The "öğren" library — analysis guidance an operator uploads so the AI takes it
 * into account when preparing a NEW analysis. Upload a note, toggle whether the
 * AI learns from it, delete it. The enabled notes are injected into the
 * analyst's context ("dikkat edilecekler") when the next analysis runs.
 */
function GuidanceLibrary(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const canWrite = hasAnyRole(session, GUIDANCE_WRITE_ROLES);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const notes = useQuery({
    queryKey: ["guidance"],
    queryFn: ({ signal }) => api.get<{ notes: readonly GuidanceNote[] }>("/studio/guidance", { signal }),
    retry: false,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["guidance"] });
  };

  const add = useMutation({
    mutationFn: (body: { title: string; content: string }) =>
      api.post<{ note: GuidanceNote }>("/studio/guidance", { ...body, enabled: true }),
    onSuccess: () => {
      setTitle("");
      setContent("");
      invalidate();
      toast.show("success", t("guidance.toast.added"));
    },
    onError: () => toast.show("error", t("guidance.toast.error")),
  });

  /**
   * File → note ("ajan eğitimi"). The file is read in the browser and posted as
   * `{ fileName, contentBase64 }` JSON — same pipeline (auth, error codes) as
   * every other write; the BFF extracts the text (docx included) and stores an
   * enabled note. `invalidate()` then refreshes the list, exactly like a typed
   * note.
   */
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const contentBase64 = await fileToBase64(file);
      return api.post<{ note: GuidanceNote }>("/studio/guidance/upload", {
        fileName: file.name,
        contentBase64,
      });
    },
    onSuccess: () => {
      invalidate();
      toast.show("success", t("guidance.toast.uploaded"));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const pickFile = (files: FileList | null): void => {
    const file = files?.[0];
    // Reset so choosing the same file again re-fires the change event.
    if (fileInput.current !== null) fileInput.current.value = "";
    if (file === undefined) return;
    upload.mutate(file);
  };

  const toggle = useMutation({
    mutationFn: (note: GuidanceNote) =>
      api.put<{ note: GuidanceNote }>(`/studio/guidance/${note.id}`, { enabled: !note.enabled }),
    onSuccess: () => invalidate(),
    onError: () => toast.show("error", t("guidance.toast.error")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/studio/guidance/${id}`),
    onSuccess: () => {
      invalidate();
      toast.show("success", t("guidance.toast.removed"));
    },
    onError: () => toast.show("error", t("guidance.toast.error")),
  });

  const canSubmit = title.trim() !== "" && content.trim() !== "";
  const list = notes.data?.notes ?? [];

  return (
    <Card title={t("guidance.title")} subtitle={t("guidance.subtitle")}>
      <p className="screen-note" style={{ marginBottom: 12 }}>
        {t("guidance.intro")}
      </p>

      {canWrite && (
        <div className="scr-grid" style={{ gap: 8, marginBottom: 14 }}>
          <Input
            label={t("guidance.field.title")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("guidance.field.title_ph")}
          />
          <label className="ui-field">
            <span className="ui-field__label">{t("guidance.field.content")}</span>
            <textarea
              className="ui-input"
              rows={4}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t("guidance.field.content_ph")}
            />
            <span className="ui-field__hint">{t("guidance.field.content_hint")}</span>
          </label>
          <div className="scr-row" style={{ gap: 8, alignItems: "center" }}>
            <Button
              variant="primary"
              busy={add.isPending}
              disabled={!canSubmit}
              onClick={() => add.mutate({ title: title.trim(), content: content.trim() })}
            >
              {t("guidance.action.add")}
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".md,.txt,.docx"
              style={{ display: "none" }}
              onChange={(event) => pickFile(event.target.files)}
              aria-hidden="true"
              tabIndex={-1}
            />
            <Button busy={upload.isPending} onClick={() => fileInput.current?.click()}>
              {t("guidance.action.upload")}
            </Button>
            <span className="screen-note">{t("guidance.upload_hint")}</span>
          </div>
          <p className="screen-note" style={{ margin: 0 }}>
            {t("guidance.upload_scope_note")}
          </p>
        </div>
      )}

      <QueryState
        isPending={notes.isPending}
        error={notes.error}
        isEmpty={list.length === 0}
        emptyTitle={t("guidance.empty")}
        onRetry={() => void notes.refetch()}
      >
        <Table
          columns={[
            {
              key: "title",
              header: t("guidance.col.title"),
              cell: (n: GuidanceNote) => (
                <>
                  {n.title}
                  {typeof n.variantId === "string" && n.variantId !== "" && (
                    <>
                      {" "}
                      <Badge tone="blue">{t("guidance.scope.variant", { id: n.variantId })}</Badge>
                    </>
                  )}
                </>
              ),
            },
            {
              key: "content",
              header: t("guidance.col.content"),
              cell: (n) => <span className="screen-note">{n.content}</span>,
            },
            {
              key: "enabled",
              header: t("guidance.col.learn"),
              cell: (n) =>
                canWrite ? (
                  <button
                    type="button"
                    className="scr-linkbtn"
                    onClick={() => toggle.mutate(n)}
                    disabled={toggle.isPending}
                  >
                    <Badge tone={n.enabled ? "green" : "gray"}>
                      {n.enabled ? t("guidance.learn.on") : t("guidance.learn.off")}
                    </Badge>
                  </button>
                ) : (
                  <Badge tone={n.enabled ? "green" : "gray"}>
                    {n.enabled ? t("guidance.learn.on") : t("guidance.learn.off")}
                  </Badge>
                ),
            },
            ...(canWrite
              ? [
                  {
                    key: "actions",
                    header: "",
                    cell: (n: GuidanceNote) => (
                      <Button size="sm" onClick={() => remove.mutate(n.id)}>
                        {t("guidance.action.remove")}
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
          rows={list}
          rowKey={(n) => n.id}
          emptyLabel={t("guidance.empty")}
        />
      </QueryState>
    </Card>
  );
}

