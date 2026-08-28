import { z } from "zod";
import type { ResolvedDeps, RoutingProjectView } from "./deps.js";
import { badRequest } from "./errors.js";
import { putParam, type ParamPutResult } from "./params-service.js";

/**
 * The routing screen (M99/M102 + M18): which projects are bound and how a
 * ticket enters the flow, and which LLM backend a piece of work is allowed to
 * reach.
 *
 * The two tables answer different questions and come from different places.
 * The bindings are rows in the database, written by the onboarding flow. The
 * policy is the `dataclass.policy` parameter — GUARDED, so changing it takes
 * four eyes: it decides whether a `gizli` ticket may be sent to a cloud model,
 * which is the single most consequential setting on this screen.
 */

/** Data classes the policy assigns a backend to, most open first. */
const DATA_CLASSES = ["acik", "dahili", "gizli"] as const;
type DataClassName = (typeof DATA_CLASSES)[number];

/** The parameter this screen edits. Guarded (M32/M78). */
export const DATA_CLASS_POLICY_KEY = "dataclass.policy";

/**
 * What happens when the on-prem backend a class requires is not available.
 * Straight from the parameter; the screen turns each into the shared outcome
 * vocabulary below.
 */
const OnpremFallback = z.enum(["degrade_ai_assist", "block", "masked_cloud"]);

export const DataClassPolicy = z.object({
  backendByClass: z.object({
    acik: z.string().min(1),
    dahili: z.string().min(1),
    gizli: z.string().min(1),
  }),
  whenOnpremMissing: OnpremFallback,
});
export type DataClassPolicy = z.infer<typeof DataClassPolicy>;

export const RoutingUpdate = z.object({ policy: DataClassPolicy });
export type RoutingUpdate = z.infer<typeof RoutingUpdate>;

/**
 * A policy row as the screen renders it.
 *
 * Named `PolicyRuleView` rather than `RoutingRuleView` because `deps.ts`
 * already owns that name for the ticket→application rules, and the two are
 * genuinely different things: one decides which APPLICATION a ticket belongs
 * to, the other decides which MODEL may see it.
 */
export interface PolicyRuleView {
  ruleId: string;
  /**
   * The condition as a CATALOG KEY plus its substitutions (M104).
   *
   * It used to be the finished sentence (`dataClass = gizli`), rendered here
   * "so the same sentence appears identically on the cost and llm screens".
   * One place still decides what it says — it now decides in keys, so the
   * sentence is identical AND readable in the operator's language.
   */
  conditionKey: string;
  conditionParams?: Readonly<Record<string, string>>;
  backend: string;
  model: string;
  /** `ok` | `queued` | `degraded` | `blocked` — the shared outcome vocabulary. */
  outcome: string;
}

export interface RoutingView {
  projects: readonly RoutingProjectView[];
  rules: readonly PolicyRuleView[];
  /**
   * The stored policy verbatim, so the editor round-trips it EXACTLY.
   *
   * The rendered `rules` above are lossy: both `degrade_ai_assist` and
   * `masked_cloud` collapse to the `degraded` outcome, so an editor that
   * reconstructed `whenOnpremMissing` from a rule would guess. A screen that
   * PUTs a guessed fallback for a field the operator never touched silently
   * downgrades the stored policy — e.g. a strict `block` on the `gizli` class
   * becomes `degrade_ai_assist`, and four-eyes does NOT catch it because
   * `putParam` compares the two proposals to each other, not to the live value.
   * The raw policy is the only safe thing to edit against (symmetric with
   * `ladderRaw` on the notify view).
   */
  policy: DataClassPolicy;
}

/**
 * What the routing screen shows.
 *
 * Both halves refuse rather than answering empty when their source is
 * unreachable — the reader throws, and an unseeded policy parameter is named
 * as unseeded. "No projects are bound" is a real and different answer, and it
 * comes back as an empty list only when the table really is empty.
 */
export async function readRouting(deps: ResolvedDeps): Promise<RoutingView> {
  const [projects, policy] = await Promise.all([deps.routing.projects(), readPolicy(deps)]);
  return { projects, rules: policyRules(policy), policy };
}

/**
 * Change the policy.
 *
 * Through `putParam`, which is where the four-eyes rule lives: this parameter
 * is guarded, so the first call files a PROPOSAL and a different human has to
 * confirm the identical value. The result says which of the two happened —
 * a screen that reported "saved" for a pending proposal would be telling an
 * operator that confidential tickets are already routed somewhere they are not.
 */
export async function updateRouting(
  deps: ResolvedDeps,
  update: RoutingUpdate,
  actor: string,
): Promise<ParamPutResult> {
  return putParam(deps, {
    key: DATA_CLASS_POLICY_KEY,
    scopeRef: null,
    value: update.policy,
    actor,
  });
}

/**
 * The policy as one rule per data class, plus the fallback rule.
 *
 * Rendered here rather than in Studio because the same sentence has to appear
 * identically on the cost and llm screens — "quota exhausted → queue" reads
 * the same wherever it appears only if one place decides what it says.
 */
function policyRules(policy: DataClassPolicy): readonly PolicyRuleView[] {
  const rules: PolicyRuleView[] = DATA_CLASSES.map((dataClass) => ({
    ruleId: `dataclass:${dataClass}`,
    conditionKey: "routing.policy.condition.data_class",
    conditionParams: { dataClass },
    backend: policy.backendByClass[dataClass],
    model: policy.backendByClass[dataClass],
    // A class that resolves to a backend is served. `gizli` on `onprem` is
    // still `ok` — the degradation is the FALLBACK rule below, and marking the
    // normal path amber would cry wolf on every confidential ticket.
    outcome: "ok",
  }));

  rules.push({
    ruleId: "dataclass:onprem_missing",
    conditionKey: "routing.policy.condition.backend_unavailable",
    conditionParams: { backend: policy.backendByClass.gizli },
    backend: policy.backendByClass.gizli,
    model: policy.backendByClass.gizli,
    outcome: fallbackOutcome(policy.whenOnpremMissing, policy.backendByClass.gizli),
  });

  return rules;
}

/**
 * The fallback, in the shared vocabulary.
 *
 * `masked_cloud` is `degraded` and NOT `ok`: the work proceeds, but a
 * confidential ticket went to a cloud model with its identifiers masked, and
 * that is not what was asked for. Painting it green would hide the one event a
 * compliance reviewer opens this screen to find.
 */
function fallbackOutcome(fallback: z.infer<typeof OnpremFallback>, gizliBackend: string): string {
  switch (fallback) {
    case "block":
      return "blocked";
    case "masked_cloud":
      return "degraded";
    case "degrade_ai_assist":
      // The run continues with a human applying what the AI proposes. Degraded
      // rather than queued: nothing is waiting for capacity, the mode dropped.
      return gizliBackend === "onprem" ? "degraded" : "degraded";
  }
}

/**
 * Read the guarded policy parameter at global scope.
 *
 * A missing row is a refusal that names the key. There is no compiled-in
 * default here on purpose: a fallback policy would decide where confidential
 * material goes precisely when the database could not, and it would do it
 * silently.
 */
async function readPolicy(deps: ResolvedDeps): Promise<DataClassPolicy> {
  const values = await deps.params.values();
  const rows = values.filter(
    (value) => value.key === DATA_CLASS_POLICY_KEY && value.scopeRef === null,
  );
  const newest = rows.reduce<(typeof rows)[number] | null>(
    (best, row) => (best === null || row.version > best.version ? row : best),
    null,
  );
  if (newest === null) {
    throw badRequest("param_not_seeded", {
      key: DATA_CLASS_POLICY_KEY,
      reason: "the data-class routing policy lives in the database (M71); run the parameter seed",
    });
  }

  const parsed = DataClassPolicy.safeParse(newest.value);
  if (!parsed.success) {
    throw badRequest("param_unusable", {
      key: DATA_CLASS_POLICY_KEY,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    });
  }
  return parsed.data;
}

export type { DataClassName };
