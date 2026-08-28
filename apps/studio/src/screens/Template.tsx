import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Table, useToast } from "../ui/index.ts";
import { MaybeUnwired, UnwiredNote } from "./shared/unwired.tsx";
import { SectionEditor } from "./template/SectionEditor.tsx";
import { SectionList } from "./template/SectionList.tsx";
import { TemplatePreview } from "./template/TemplatePreview.tsx";
import {
  addSection,
  canRemoveSection,
  moveSection,
  removeSection,
  selectSection,
  toDraftSections,
  toWireSections,
  updateSection,
  type TemplateDraft,
  type TemplateHistoryEntry,
  type TemplateProjectBinding,
  type TemplateVersion,
} from "./template/model.ts";
import "./template/template.css";

interface TemplateResponse {
  readonly template: TemplateVersion;
  readonly history: readonly TemplateHistoryEntry[];
  readonly projects: readonly TemplateProjectBinding[];
}

/**
 * Screen: template — the analysis template DESIGNER (M108).
 *
 * The template is built here rather than uploaded: sections are added, removed
 * and ordered, and each one carries the title, description, AI instruction,
 * required flag, expected format and few-shot example that the server turns
 * into a Zod schema. Adding a section therefore needs no code change.
 *
 * Saving publishes a NEW version; runs already in flight finish on the version
 * they started with (M83 pinning), which is why nothing here mutates a
 * published version in place.
 */
export function TemplateScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["template"],
    queryFn: ({ signal }) => api.get<TemplateResponse>("/template", { signal }),
  });

  const [previewOpen, setPreviewOpen] = useState(false);

  /**
   * The editable draft, seeded from the server copy and re-seeded ONLY when the
   * published version changes.
   *
   * This is derived during render rather than in an effect, on purpose. Seeding
   * editable state from a query inside `useEffect` is the classic way to lose an
   * author's work: StrictMode double-invokes effects, and any refetch that
   * produces a new object identity re-runs them, so a half-typed section
   * silently disappears. Comparing the version we seeded from against the
   * version we just received makes the seed idempotent however many times React
   * renders or re-runs.
   *
   * A save publishes `version + 1`, so the new version re-seeds and picks up the
   * server's canonical copy; a refetch that still reports the same version
   * leaves the in-progress draft alone.
   */
  const loaded = query.data?.template;
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [seededVersion, setSeededVersion] = useState<number | null>(null);

  if (loaded !== undefined && seededVersion !== loaded.version) {
    setSeededVersion(loaded.version);
    setDraft({
      name: loaded.name,
      version: loaded.version,
      sections: toDraftSections(loaded.sections),
      selectedId: null,
    });
  }

  const save = useMutation({
    mutationFn: (next: TemplateDraft) =>
      api.post<TemplateVersion>("/template/versions", {
        name: next.name,
        sections: toWireSections(next.sections),
      }),
    onSuccess: (published) => {
      toast.show(
        "success",
        t("template.saved", {
          name: published.name,
          version: String(published.version),
          n: String(published.sections.length),
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ["template"] });
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const selected = draft?.sections.find((s) => s.id === draft.selectedId);
  const selectedIndex = draft?.sections.findIndex((s) => s.id === draft.selectedId) ?? -1;

  return (
    <>
      {/* Honest strip: the designer edits a template the engine does not read
          yet — the engine still runs the built-in corporate template. Saying so
          up front beats letting an author believe their edits steer runs. */}
      <div style={{ marginBottom: 14 }}>
        <UnwiredNote>{t("template.unwired_note")}</UnwiredNote>
      </div>
      <Card
        title={t("template.designer")}
        subtitle={t("template.designer_sub")}
        actions={
          draft !== null && (
            <div className="tpl-bar__actions">
              <Badge tone="blue">{t("template.version_n", { n: String(draft.version) })}</Badge>
              <Button size="sm" onClick={() => setPreviewOpen(true)}>
                {t("template.preview")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                busy={save.isPending}
                onClick={() => save.mutate(draft)}
              >
                {t("template.save_as_new_version")}
              </Button>
            </div>
          )
        }
      >
        <MaybeUnwired isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
          {draft !== null && (
            <>
              <div className="tpl-chips">
                <span className="tpl-row__key">{t("template.used_by")}</span>
                {(query.data?.projects ?? []).map((binding) => (
                  <Badge
                    key={binding.projectKey}
                    tone={binding.pinnedRuns > 0 ? "amber" : "gray"}
                  >
                    {binding.pinnedRuns > 0
                      ? t("template.project_pinned", {
                          project: binding.projectKey,
                          version: String(binding.version),
                          n: String(binding.pinnedRuns),
                        })
                      : t("template.project_version", {
                          project: binding.projectKey,
                          version: String(binding.version),
                        })}
                  </Badge>
                ))}
              </div>

              <div className="tpl-split" style={{ marginTop: 14 }}>
                <Card
                  title={t("template.sections_n", { n: String(draft.sections.length) })}
                  actions={
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        setDraft(
                          addSection(draft, {
                            title: t("template.new_section"),
                            aiInstruction: t("template.new_section_instruction"),
                          }),
                        )
                      }
                    >
                      {t("template.add_section")}
                    </Button>
                  }
                >
                  <SectionList
                    sections={draft.sections}
                    selectedId={draft.selectedId}
                    canRemove={canRemoveSection(draft)}
                    onSelect={(id) => setDraft(selectSection(draft, id))}
                    onMove={(id, delta) => setDraft(moveSection(draft, id, delta))}
                    onRemove={(id) => {
                      if (!canRemoveSection(draft)) {
                        toast.show("error", t("template.last_section"));
                        return;
                      }
                      setDraft(removeSection(draft, id));
                      toast.show("warning", t("template.section_removed"));
                    }}
                  />
                  <p className="tpl-keyline">{t("template.order_note")}</p>
                </Card>

                <SectionEditor
                  section={selected}
                  index={selectedIndex}
                  onChange={(id, field, value) => setDraft(updateSection(draft, id, field, value))}
                />
              </div>

              <TemplatePreview
                open={previewOpen}
                onClose={() => setPreviewOpen(false)}
                name={draft.name}
                version={draft.version}
                sections={draft.sections}
              />
            </>
          )}
        </MaybeUnwired>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card title={t("template.history")} padded={false}>
          <MaybeUnwired
            isPending={query.isPending}
            error={query.error}
            isEmpty={(query.data?.history ?? []).length === 0}
            emptyTitle={t("template.no_history")}
          >
            <Table
              columns={[
                {
                  key: "version",
                  header: t("template.col.version"),
                  cell: (row: TemplateHistoryEntry) => (
                    <Badge tone="blue">{t("template.version_n", { n: String(row.version) })}</Badge>
                  ),
                },
                { key: "at", header: t("template.col.at"), cell: (row) => row.at },
                { key: "author", header: t("template.col.author"), cell: (row) => row.author },
                { key: "summary", header: t("template.col.summary"), cell: (row) => row.summary },
              ]}
              rows={query.data?.history ?? []}
              rowKey={(row) => String(row.version)}
              emptyLabel={t("template.no_history")}
            />
          </MaybeUnwired>
        </Card>
      </div>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("template.pin_note")}
      </p>
    </>
  );
}
