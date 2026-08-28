import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useApi } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, useToast } from "../../ui/index.ts";
import type { RepoPolicy } from "../common/index.ts";

export interface ProtectedPathsProps {
  readonly policy: RepoPolicy;
}

/**
 * Protected paths (M52): globs an agent may never write to.
 *
 * The list has two halves and the UI keeps them apart. Platform defaults —
 * migrations, signing material, production settings — are the floor the
 * platform guarantees; they render as a read-only list with no delete control,
 * because the server refuses to remove them and an X that always errors is
 * worse than no X. A repo may only ADD to that floor. Widening protection is
 * safe in one direction only, so the screen offers exactly that direction.
 */
export function ProtectedPaths({ policy }: ProtectedPathsProps): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);

  const addPath = useMutation({
    mutationFn: (path: string) =>
      api.post<RepoPolicy>(
        `/repo-policy/${encodeURIComponent(policy.appId)}/protected-paths`,
        { path },
      ),
    onSuccess: (_result, path) => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: ["repo-policy"] });
      toast.show("success", t("yaml.toast.path_added", { path }));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const removePath = useMutation({
    mutationFn: (path: string) =>
      api.request<RepoPolicy>(
        `/repo-policy/${encodeURIComponent(policy.appId)}/protected-paths/${encodeURIComponent(path)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_result, path) => {
      void queryClient.invalidateQueries({ queryKey: ["repo-policy"] });
      toast.show("success", t("yaml.toast.path_removed", { path }));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const submit = (): void => {
    const path = draft.trim();
    if (path === "") {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    addPath.mutate(path);
  };

  return (
    <Card title={t("yaml.card.protected")} subtitle={t("yaml.card.protected_sub")}>
      <div className="scr-grid scr-grid--2">
        <div>
          <div className="scr-row" style={{ marginBottom: 8 }}>
            <b className="scr-mini">{t("yaml.protected.defaults")}</b>
            <Badge tone="gray">{t("yaml.protected.read_only")}</Badge>
          </div>
          {policy.protectedPaths.platformDefaults.length === 0 ? (
            <p className="scr-mini">{t("yaml.protected.no_defaults")}</p>
          ) : (
            <ul className="scr-mono scr-mini">
              {policy.protectedPaths.platformDefaults.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          )}
          <div className="scr-note" style={{ marginTop: 10 }}>
            {t("yaml.protected.defaults_note")}
          </div>
        </div>

        <div>
          <div className="scr-row" style={{ marginBottom: 8 }}>
            <b className="scr-mini">{t("yaml.protected.additions")}</b>
          </div>
          {policy.protectedPaths.repoAdditions.length === 0 ? (
            <p className="scr-mini">{t("yaml.protected.no_additions")}</p>
          ) : (
            <ul className="scr-mini">
              {policy.protectedPaths.repoAdditions.map((path) => (
                <li key={path} className="scr-row">
                  <code className="scr-mono">{path}</code>
                  <Button
                    size="sm"
                    variant="danger"
                    busy={removePath.isPending}
                    onClick={() => removePath.mutate(path)}
                  >
                    {t("yaml.action.remove_path")}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="scr-row" style={{ marginTop: 10, alignItems: "flex-end" }}>
            <Input
              label={t("yaml.field.add_path")}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              hint={t("yaml.field.add_path_hint")}
              {...(invalid ? { error: t("yaml.error.path_required") } : {})}
            />
            <Button variant="primary" busy={addPath.isPending} onClick={submit}>
              {t("yaml.action.add_path")}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
