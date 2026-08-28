import type { FlowType } from "./listening.js";

/**
 * What a flow type actually CHANGES about the run — the pilot's answer to
 * "Ne yapılsın (akış)". Until now the listening rule's flow type was a label
 * only (`run.ts` classified it and logged it, but every ticket ran the full
 * pipeline regardless). This turns the choice into real behaviour, the same way
 * `gatesFor(risk)` turns a risk tier into a gate set — here `planFor(flow)`
 * turns a flow type into which steps run.
 *
 * The three flows, by what a manager means when they pick them:
 *
 *  - **analiz** — "just analyse it". Produce the analysis document and stop.
 *    No code, no PR, no merge. Used for a ticket that needs investigation and a
 *    written analysis before anyone decides whether to build anything.
 *  - **duzeltme** — "small fix". A targeted bug fix that does not need the full
 *    analysis-approval gate: skip the analysis gate and go straight from intake
 *    to engineering. The PR gate still stands — nothing merges without review.
 *  - **gelistirme** (and the null default) — "full SDLC". The complete pipeline
 *    exactly as before: intake → analysis → analysis gate → engineering → PR →
 *    PR gate → merge. This is the backward-compatible path.
 */
export interface FlowPlan {
  /** Run the analysis-approval gate (step 4/5). `duzeltme` skips it. */
  analysisGate: boolean;
  /** Run engineering + PR + PR gate + merge. `analiz` stops before this. */
  engineering: boolean;
}

const FULL: FlowPlan = { analysisGate: true, engineering: true };

/**
 * The plan for a flow type. A null/unknown flow (no matching listening rule)
 * gets the full pipeline, so a ticket is never silently under-processed.
 */
export function planFor(flow: FlowType | null): FlowPlan {
  switch (flow) {
    case "analiz":
      // Analyse and stop — the analysis IS the deliverable.
      return { analysisGate: true, engineering: false };
    case "duzeltme":
      // Small fix — skip the analysis gate, but still gate the PR.
      return { analysisGate: false, engineering: true };
    case "gelistirme":
    case null:
    default:
      return FULL;
  }
}
