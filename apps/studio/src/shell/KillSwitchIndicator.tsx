import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge } from "../ui/Badge.tsx";

export type KillSwitchLevel = "off" | "intake_only" | "all";

export interface KillSwitchState {
  readonly level: KillSwitchLevel;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
}

const TONE = {
  off: "green",
  intake_only: "amber",
  all: "red",
} as const;

const LABEL_KEY: Readonly<Record<KillSwitchLevel, string>> = {
  off: "killswitch.level.off",
  intake_only: "killswitch.level.intake_only",
  all: "killswitch.level.all",
};

/**
 * Global pause indicator in the top bar. GET /killswitch needs a session but no
 * role, so every signed-in operator sees the platform state. Polled rather than
 * pushed: there is no event stream from the BFF today.
 */
export function KillSwitchIndicator(): ReactNode {
  const api = useApi();
  const t = useT();

  const { data, isPending, isError } = useQuery({
    queryKey: ["killswitch"],
    queryFn: ({ signal }) => api.get<KillSwitchState>("/killswitch", { signal }),
    refetchInterval: 30_000,
  });

  if (isPending || isError || data === undefined) return null;

  return (
    <Badge tone={TONE[data.level]} icon="●">
      {t(LABEL_KEY[data.level])}
    </Badge>
  );
}
