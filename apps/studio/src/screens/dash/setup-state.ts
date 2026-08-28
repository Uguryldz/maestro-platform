import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../auth/AuthProvider.tsx";

/**
 * The platform's REAL setup state, read once and shared by the Panel (which
 * decides whether to show the start guide) and the guide itself (which renders
 * the checklist).
 *
 * Both used to answer "is this platform set up?" differently: the Panel asked
 * "are there zero runs?" while the guide measured the actual steps. That gap is
 * the bug this module closes — a deployment with 16 runs but no webhook and no
 * bound connections is NOT set up, and the guide is exactly what such an
 * operator needs to see. One hook, one answer, no drift.
 *
 * Every read fails soft: a step whose endpoint errors stays UNCHECKED rather
 * than counting as done, because claiming a step is finished on the strength of
 * a failed read is the one mistake that would hide a real gap.
 */

/** The webhook step's local acknowledgement key (see `webhookAcked`). */
const WEBHOOK_ACK_KEY = "maestro.setup.webhookAcked";
/** The "I understand, hide this" preference key. */
export const GUIDE_DISMISSED_KEY = "maestro.setup.guideDismissed";

export interface SetupState {
  /** At least one Jira or SCM connection is wired. */
  readonly hasConn: boolean;
  /** At least one project is bound (routing lists it). */
  readonly hasBinding: boolean;
  /** At least one agent variant holds knowledge files. */
  readonly hasTrainedAgent: boolean;
  /**
   * The Jira webhook is registered. NOTE: no endpoint reports this — Jira does
   * not tell us, and Maestro stores no record of the registration — so this is
   * the operator's own acknowledgement, kept locally. See ARAYÜZ İSTEĞİ in the
   * report: a real `GET /studio/webhook-status` would replace it.
   */
  readonly hasWebhook: boolean;
  /**
   * Is a ticket sweep running? The OTHER way a ticket can arrive.
   *
   * The checklist used to treat the webhook as the only path, so an install
   * that polls Jira instead was told forever that it was missing a step it did
   * not need — and one that had neither was told the same thing, with no way to
   * tell the two apart.
   */
  readonly hasSweep: boolean;
  /** Every step above is finished → the guide has nothing left to teach. */
  readonly complete: boolean;
  /** True until every underlying read has settled. */
  readonly loading: boolean;
}

/** Reads a boolean flag from localStorage, tolerating a disabled/absent store. */
export function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Persists a boolean flag, tolerating a disabled/absent store (private mode). */
export function writeFlag(key: string, value: boolean): void {
  try {
    if (value) globalThis.localStorage?.setItem(key, "1");
    else globalThis.localStorage?.removeItem(key);
  } catch {
    /* a browser that refuses storage simply does not remember the choice */
  }
}

export function webhookAcked(): boolean {
  return readFlag(WEBHOOK_ACK_KEY);
}

export function setWebhookAcked(value: boolean): void {
  writeFlag(WEBHOOK_ACK_KEY, value);
}

export { WEBHOOK_ACK_KEY };

/**
 * The shared setup read. `webhookAck` is passed in rather than read here so the
 * caller that owns the toggle re-renders when it flips.
 */
export function useSetupState(webhookAck: boolean): SetupState {
  const api = useApi();

  const jiraConns = useQuery({
    queryKey: ["onboarding-jira-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly unknown[] }>("/onboarding/jira-connections", { signal }),
    retry: false,
  });
  const scmConns = useQuery({
    queryKey: ["onboarding-scm-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly unknown[] }>("/onboarding/scm-connections", { signal }),
    retry: false,
  });
  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<{ projects: readonly unknown[] }>("/routing", { signal }),
    retry: false,
  });
  /**
   * Is anything picking tickets up? Either path counts.
   *
   * A webhook is the better one when it exists; the sweep is the answer for a
   * site that cannot register one. Treating the webhook as the only path told
   * a polling install forever that it was missing a step it did not need.
   */
  const sweep = useQuery({
    queryKey: ["listening-status"],
    queryFn: ({ signal }) =>
      api.get<{ enabled: boolean }>("/studio/listening-status", { signal }),
    retry: false,
  });
  const variants = useQuery({
    queryKey: ["variants"],
    queryFn: ({ signal }) =>
      api.get<{ variants: readonly { knowledgeFiles?: number }[] }>("/variants", { signal }),
    retry: false,
  });

  const hasConn =
    (jiraConns.data?.connections.length ?? 0) > 0 || (scmConns.data?.connections.length ?? 0) > 0;
  const hasBinding = (routing.data?.projects.length ?? 0) > 0;
  const hasTrainedAgent = (variants.data?.variants ?? []).some((v) => (v.knowledgeFiles ?? 0) > 0);
  const hasSweep = sweep.data?.enabled === true;

  const loading =
    jiraConns.isPending || scmConns.isPending || routing.isPending || variants.isPending;

  return {
    hasConn,
    hasBinding,
    hasTrainedAgent,
    hasWebhook: webhookAck,
    hasSweep,
    /**
     * Done means "tickets can arrive and be worked", not "every optional
     * extra is filled in".
     *
     * Two changes from the first version, both measured against a real
     * install that was working and told otherwise. Ticket INTAKE is satisfied
     * by either path — a webhook or a running sweep — because those are
     * alternatives, not a checklist. And uploaded knowledge files are NOT
     * required: they improve an analysis, they do not enable one, and
     * demanding them left a finished setup showing a permanent banner.
     */
    complete: hasConn && hasBinding && (webhookAck || hasSweep),
    loading,
  };
}
