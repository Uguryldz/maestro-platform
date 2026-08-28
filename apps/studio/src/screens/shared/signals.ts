import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult } from "@tanstack/react-query";
import { canDecideGate, type StepId, type WorkMode } from "@maestro/contracts";
import type { Session } from "../../auth/types.ts";
import { useApi } from "../../auth/AuthProvider.tsx";

/**
 * Studio's write path. There is no REST verb for "approve" — a gate decision is
 * a SIGNAL delivered to the running workflow:
 *
 *   POST /runs/:ticket/signals/gateDecision          { decision, reason? }
 *   POST /runs/:ticket/signals/clarificationAnswered { text }
 *   POST /runs/:ticket/signals/modeChange            { mode }
 *
 * The allow-list is the BFF's (apps/bff/src/signal-names.ts). `ciResult`,
 * `prChangesRequested` and `killSwitch` are deliberately absent: a button that
 * forged a build result or a review verdict would let any logged-in user
 * manufacture evidence, and the kill switch has its own role-checked route.
 *
 * The decision carries NO actor field. Identity comes from the session on the
 * server side; a body naming its own approver is a signature anyone could type.
 */

/** Signal names Studio may send, mirroring STUDIO_SIGNALS in the BFF. */
export const STUDIO_SIGNALS = {
  gateDecision: "gateDecision",
  clarificationAnswered: "clarificationAnswered",
  modeChange: "modeChange",
} as const;

export interface GateDecisionInput {
  readonly ticket: string;
  readonly decision: "approve" | "reject";
  /** Mandatory when rejecting — the BFF answers 400 `reject_needs_reason`. */
  readonly reason?: string;
}

export interface GateDecisionResult {
  readonly accepted: boolean;
  readonly step: StepId;
  readonly signatureSeq: number;
}

/**
 * Thrown before the request leaves the browser when a reject carries no reason.
 * This is a UX guard, not enforcement — the BFF rejects an empty reason too,
 * and its check is the one that counts.
 */
export class MissingReasonError extends Error {
  override readonly name = "MissingReasonError";
  readonly messageKey = "error.reject_needs_reason";
  constructor() {
    super("reject requires a reason");
  }
}

export function useGateDecision(): UseMutationResult<
  GateDecisionResult,
  unknown,
  GateDecisionInput
> {
  const api = useApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ ticket, decision, reason }: GateDecisionInput) => {
      const trimmed = reason?.trim() ?? "";
      if (decision === "reject" && trimmed === "") throw new MissingReasonError();
      return api.post<GateDecisionResult>(
        `/runs/${ticket}/signals/${STUDIO_SIGNALS.gateDecision}`,
        { decision, ...(trimmed === "" ? {} : { reason: trimmed }) },
      );
    },
    onSuccess: (_result, { ticket }) => {
      void queryClient.invalidateQueries({ queryKey: ["run", ticket] });
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["journal", ticket] });
    },
  });
}

export interface ClarificationInput {
  readonly ticket: string;
  readonly text: string;
}

export function useClarificationAnswer(): UseMutationResult<
  { readonly accepted: boolean },
  unknown,
  ClarificationInput
> {
  const api = useApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ ticket, text }: ClarificationInput) => {
      const trimmed = text.trim();
      if (trimmed === "") throw new MissingReasonError();
      return api.post<{ accepted: boolean }>(
        `/runs/${ticket}/signals/${STUDIO_SIGNALS.clarificationAnswered}`,
        { text: trimmed },
      );
    },
    onSuccess: (_result, { ticket }) => {
      void queryClient.invalidateQueries({ queryKey: ["run", ticket] });
      void queryClient.invalidateQueries({ queryKey: ["journal", ticket] });
    },
  });
}

export interface ModeChangeInput {
  readonly ticket: string;
  readonly mode: WorkMode;
}

export function useModeChange(): UseMutationResult<
  { readonly accepted: boolean; readonly mode: WorkMode },
  unknown,
  ModeChangeInput
> {
  const api = useApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ ticket, mode }: ModeChangeInput) =>
      api.post<{ accepted: boolean; mode: WorkMode }>(
        `/runs/${ticket}/signals/${STUDIO_SIGNALS.modeChange}`,
        { mode },
      ),
    onSuccess: (_result, { ticket }) => {
      void queryClient.invalidateQueries({ queryKey: ["run", ticket] });
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

/**
 * May this session decide the gate at `step`? Delegates to the frozen contract
 * so Studio and the workflow spell the rule once.
 *
 * SECURITY NOTE: this only greys out a control. It is NOT access control — the
 * bundle is public, the roles arrive in a response the client cannot verify,
 * and the URL can be typed by hand. The real check is `decideGate` in the BFF
 * (membership against the gate's owning group) plus the workflow's own
 * `actorGroup` verification. Never move an authorisation decision in here.
 */
export function mayDecide(session: Session | null, step: StepId | undefined): boolean {
  if (session === null || step === undefined) return false;
  return canDecideGate({ roles: rolesOf(session), delegated: session.delegated }, step);
}

/**
 * `canDecideGate` takes the contract's closed `Role` union; the wire sends bare
 * strings. Anything not in the union cannot own a gate anyway, so the cast is
 * safe on the only axis that matters: an unknown role never gains authority.
 */
function rolesOf(session: Session): readonly never[] {
  return session.roles as readonly never[];
}
