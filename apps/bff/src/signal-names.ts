import type { StepId } from "@maestro/contracts";

/**
 * The names the workflow answers to.
 *
 * These strings are duplicated from `packages/workflows/src/signals.ts` on
 * purpose: importing the workflow module would drag `@temporalio/workflow` —
 * and its sandbox expectations — into an HTTP process that must never run
 * workflow code. The duplication is pinned by `test/signal-names.test.ts`,
 * which imports the real definitions and fails the build on any drift. A
 * producer and a consumer disagreeing about a key is exactly how v1 died.
 */
export const SIGNALS = {
  gateDecision: "gateDecision",
  clarificationAnswered: "clarificationAnswered",
  ciResult: "ciResult",
  prChangesRequested: "prChangesRequested",
  modeChange: "modeChange",
  killSwitch: "killSwitch",
} as const;

export type SignalName = (typeof SIGNALS)[keyof typeof SIGNALS];

export const QUERIES = {
  runState: "runState",
} as const;

/**
 * Signals Studio may deliver through `POST /runs/:ticket/signals/:name`.
 *
 * `ciResult` is absent: a build verdict is only evidence when it arrives on the
 * authenticated Service Hook and carries its origin (M106). Letting a logged-in
 * user post one would hand anybody a green CI gate.
 *
 * `killSwitch` is absent too: it has its own endpoint, its own role check and
 * its own audit action (M58).
 *
 * `prChangesRequested` is absent because it is not Studio's to send: a PR
 * thread asking for changes is an ADO event (M13/12b), and a button that
 * fabricates one would let the flow claim review feedback nobody wrote.
 */
export const STUDIO_SIGNALS = [
  SIGNALS.gateDecision,
  SIGNALS.clarificationAnswered,
  SIGNALS.modeChange,
] as const;

export type StudioSignal = (typeof STUDIO_SIGNALS)[number];

export function isStudioSignal(name: string): name is StudioSignal {
  return (STUDIO_SIGNALS as readonly string[]).includes(name);
}

/**
 * Default gate owner groups, mirroring `GATE_OWNER` in the workflows package
 * and pinned against it by `test/signal-names.test.ts`. Deployments override
 * them per project through {@link GateDirectory} (M71), which is why this is a
 * fallback rather than the answer.
 */
export const DEFAULT_GATE_OWNER_GROUPS: Readonly<Partial<Record<StepId, string>>> = {
  "4": "product-owners",
  "5": "tech-leads",
  "9": "qa",
  "11": "qa",
  "12": "tech-leads",
};
