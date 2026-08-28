import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, EmptyState, Tabs, TabPanel } from "../ui/index.ts";
import { type RepoPolicy, type RepoPolicyView } from "./common/index.ts";
import { useLabel } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { ProtectedPaths } from "./yaml/ProtectedPaths.tsx";

/**
 * `.maestro.yaml` (M52/M71): the repo-native half of a project's configuration
 * — the build, lint and test commands, and the protected paths.
 *
 * The file itself is READ-ONLY here, and that is a product decision rather than
 * an unfinished feature: the file lives in the repository so the team owns it
 * through their own PR process. Studio shows what is currently checked in;
 * changing it means opening a pull request. Protected paths are the one place
 * with an editing affordance, and even there platform defaults are listed
 * separately and cannot be removed (see ProtectedPaths).
 */
export function YamlScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const label = useLabel();
  const [active, setActive] = useState<string>("");

  const policies = useQuery({
    queryKey: ["repo-policy"],
    queryFn: ({ signal }) => api.get<RepoPolicyView>("/repo-policy", { signal }),
  });

  const rows: readonly RepoPolicy[] = policies.data?.policies ?? [];
  const current = rows.find((policy) => policy.appId === active) ?? rows[0];

  return (
    <div className="scr-stack">
      {/*
        `GET /repo-policy` is not built yet. Template.tsx already used
        MaybeUnwired for the same class of unbuilt read model; this screen
        showing a different failure for the same server condition was an
        inconsistency, not a decision.
      */}
      <MaybeUnwired
        isPending={policies.isPending}
        error={policies.error}
        onRetry={() => void policies.refetch()}
      >
        {current === undefined ? (
          <EmptyState
            icon="📄"
            title={t("yaml.empty.title")}
            description={t("yaml.empty.description")}
          />
        ) : (
          <>
            <Tabs
              label={t("yaml.tabs.label")}
              active={current.appId}
              onChange={setActive}
              items={rows.map((policy) => ({ id: policy.appId, label: policy.appId }))}
            />

            {rows.map((policy) => (
              <TabPanel key={policy.appId} id={policy.appId} active={current.appId}>
                <div className="scr-stack">
                  <Card
                    title={policy.appId}
                    subtitle={policy.repo}
                    actions={
                      <Badge tone="blue">{label(`platform.${policy.platform}`, policy.platform)}</Badge>
                    }
                  >
                    <p className="scr-mini">{t("yaml.read_only")}</p>
                    {/*
                      No file observed: say so in the operator's language rather
                      than rendering the empty string, and rather than printing
                      the block of English YAML comments the server used to
                      send. `yamlPresent === false` is the explicit signal; a
                      build talking to an older BFF (field absent) falls back to
                      showing whatever `yaml` carried, which is what it did
                      before.
                    */}
                    {policy.yamlPresent === false ? (
                      <div className="scr-note scr-note--warn">
                        <strong>{t("yaml.absent.title")}</strong>
                        <p className="scr-mini">{t("yaml.absent.body")}</p>
                      </div>
                    ) : (
                      <pre className="scr-code">{policy.yaml}</pre>
                    )}
                  </Card>

                  <ProtectedPaths policy={policy} />
                </div>
              </TabPanel>
            ))}
          </>
        )}
      </MaybeUnwired>

      <div className="scr-note">{t("yaml.note.source_of_truth")}</div>
    </div>
  );
}
