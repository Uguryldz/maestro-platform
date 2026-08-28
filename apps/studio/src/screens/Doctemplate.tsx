import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";
import { hasRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Table, useToast } from "../ui/index.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";

/**
 * Screen: doctemplate — the corporate Word/PDF document template (M103r/M109).
 *
 * The analysis is placed INSIDE the institution's own .docx: cover, header and
 * footer, logo slot, styles and the approval table all come from the uploaded
 * file; Maestro only fills placeholders. This screen shows which placeholders
 * were recognised, which are missing, and which analysis sections map to which
 * {{bolum:N}} slot.
 *
 * When no template is uploaded, generation does NOT stop — it falls back to a
 * plain default cover — but that is surfaced as a visible warning here rather
 * than passing silently.
 */

/** Placeholder found (or not) in the uploaded .docx. */
interface Placeholder {
  readonly token: string;
  /** Catalog key describing what gets written here. */
  readonly descriptionKey: string;
  /** Where in the document it sits, as free text from the scan. */
  readonly location: string;
  readonly found: boolean;
}

interface DocTemplateFile {
  readonly fileName: string;
  readonly version: number;
  readonly uploadedAt: string;
  readonly uploadedBy: string;
  readonly sizeBytes: number;
  /** Style names read out of the .docx. */
  readonly styles: readonly string[];
}

interface SectionMapping {
  readonly index: number;
  readonly title: string;
  readonly token: string;
  /** False when the .docx has no slot — the section is appended at the end. */
  readonly mapped: boolean;
}

interface DocTemplateResponse {
  /** null when the institution has not uploaded a template yet. */
  readonly template: DocTemplateFile | null;
  readonly placeholders: readonly Placeholder[];
  readonly sectionMapping: readonly SectionMapping[];
  readonly outputs: readonly { readonly fileName: string; readonly at: string; readonly templateVersion: number }[];
}

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function DoctemplateScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const isAdmin = hasRole(session, "admin");
  const fileInput = useRef<HTMLInputElement>(null);

  const query = useQuery({
    queryKey: ["doctemplate"],
    queryFn: ({ signal }) => api.get<DocTemplateResponse>("/doc-template", { signal }),
  });

  const data = query.data;
  const missing = (data?.placeholders ?? []).filter((p) => !p.found).length;

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const bytes = await file.arrayBuffer();
      // The name travels in a header and the bytes go up verbatim (M103r).
      return api.postBinary<DocTemplateResponse>("/doc-template", bytes, {
        "content-type": DOCX_MIME,
        "x-maestro-filename": file.name,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["doctemplate"] });
      toast.show("success", t("doctemplate.toast.uploaded"));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reset so picking the same file twice still fires a change event.
    event.target.value = "";
    if (file === undefined) return;
    if (!file.name.toLowerCase().endsWith(".docx")) {
      toast.show("error", t("doctemplate.error.not_docx"));
      return;
    }
    upload.mutate(file);
  };

  const download = async (version: number, fileName: string): Promise<void> => {
    try {
      const blob = await api.getBlob(`/doc-template/versions/${String(version)}/file`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.show("error", t(messageKeyOf(error)));
    }
  };

  return (
    <>
      <Card
        title={t("doctemplate.file")}
        subtitle={t("doctemplate.file_sub")}
        actions={
          isAdmin ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".docx"
                style={{ display: "none" }}
                onChange={onPick}
              />
              <Button
                variant="primary"
                size="sm"
                busy={upload.isPending}
                onClick={() => fileInput.current?.click()}
              >
                {t("doctemplate.action.upload")}
              </Button>
            </>
          ) : undefined
        }
      >
        <MaybeUnwired isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
          {data?.template === null || data?.template === undefined ? (
            <p className="tpl-keyline">
              <Badge tone="amber">{t("doctemplate.none_badge")}</Badge> {t("doctemplate.none")}
            </p>
          ) : (
            <>
              <p className="scr-row" style={{ gap: 8, alignItems: "center" }}>
                <b>{data.template.fileName}</b>
                <Badge tone="blue">
                  {t("doctemplate.version_n", { n: String(data.template.version) })}
                </Badge>
                <Button
                  size="sm"
                  onClick={() => {
                    if (data.template !== null) {
                      void download(data.template.version, data.template.fileName);
                    }
                  }}
                >
                  {t("doctemplate.action.download")}
                </Button>
              </p>
              <p className="tpl-keyline">
                {t("doctemplate.uploaded_meta", {
                  at: data.template.uploadedAt,
                  by: data.template.uploadedBy,
                  kb: String(Math.round(data.template.sizeBytes / 1024)),
                })}
              </p>
              <div className="tpl-chips" style={{ marginTop: 10 }}>
                <span className="tpl-row__key">{t("doctemplate.styles")}</span>
                {data.template.styles.map((style) => (
                  <Badge key={style} tone="gray">
                    {style}
                  </Badge>
                ))}
              </div>
            </>
          )}
          <p className="tpl-keyline" style={{ marginTop: 12 }}>
            {t("doctemplate.fallback_note")}
          </p>
        </MaybeUnwired>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card
          title={t("doctemplate.placeholders")}
          subtitle={
            missing > 0 ? t("doctemplate.missing_n", { n: String(missing) }) : t("doctemplate.all_found")
          }
          padded={false}
        >
          <MaybeUnwired
            isPending={query.isPending}
            error={query.error}
            isEmpty={(data?.placeholders ?? []).length === 0}
            emptyTitle={t("doctemplate.no_placeholders")}
          >
            <Table
              columns={[
                {
                  key: "token",
                  header: t("doctemplate.col.token"),
                  cell: (row: Placeholder) => <code>{row.token}</code>,
                },
                {
                  key: "what",
                  header: t("doctemplate.col.what"),
                  cell: (row) => t(row.descriptionKey),
                },
                { key: "where", header: t("doctemplate.col.where"), cell: (row) => row.location },
                {
                  key: "status",
                  header: t("doctemplate.col.status"),
                  cell: (row) => (
                    <Badge tone={row.found ? "green" : "amber"}>
                      {row.found ? t("doctemplate.found") : t("doctemplate.not_in_template")}
                    </Badge>
                  ),
                },
              ]}
              rows={data?.placeholders ?? []}
              rowKey={(row) => row.token}
              emptyLabel={t("doctemplate.no_placeholders")}
            />
          </MaybeUnwired>
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={t("doctemplate.mapping")} subtitle={t("doctemplate.mapping_sub")} padded={false}>
          <MaybeUnwired
            isPending={query.isPending}
            error={query.error}
            isEmpty={(data?.sectionMapping ?? []).length === 0}
            emptyTitle={t("doctemplate.no_mapping")}
          >
            <Table
              columns={[
                {
                  key: "n",
                  header: t("doctemplate.col.n"),
                  cell: (row: SectionMapping) => String(row.index),
                  align: "right",
                },
                { key: "title", header: t("doctemplate.col.section"), cell: (row) => row.title },
                {
                  key: "token",
                  header: t("doctemplate.col.token"),
                  cell: (row) => <code>{row.token}</code>,
                },
                {
                  key: "status",
                  header: t("doctemplate.col.status"),
                  cell: (row) => (
                    <Badge tone={row.mapped ? "green" : "amber"}>
                      {row.mapped ? t("doctemplate.mapped") : t("doctemplate.appended")}
                    </Badge>
                  ),
                },
              ]}
              rows={data?.sectionMapping ?? []}
              rowKey={(row) => row.token}
              emptyLabel={t("doctemplate.no_mapping")}
            />
          </MaybeUnwired>
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={t("doctemplate.outputs")} padded={false}>
          <MaybeUnwired
            isPending={query.isPending}
            error={query.error}
            isEmpty={(data?.outputs ?? []).length === 0}
            emptyTitle={t("doctemplate.no_outputs")}
          >
            <Table
              columns={[
                {
                  key: "file",
                  header: t("doctemplate.col.file"),
                  cell: (row: { fileName: string }) => row.fileName,
                },
                { key: "at", header: t("doctemplate.col.at"), cell: (row) => row.at },
                {
                  key: "ver",
                  header: t("doctemplate.col.template_version"),
                  cell: (row) => t("doctemplate.version_n", { n: String(row.templateVersion) }),
                },
              ]}
              rows={data?.outputs ?? []}
              rowKey={(row) => row.fileName}
              emptyLabel={t("doctemplate.no_outputs")}
            />
          </MaybeUnwired>
        </Card>
      </div>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("doctemplate.standard_note")}
      </p>
    </>
  );
}
