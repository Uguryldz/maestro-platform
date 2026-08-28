import { z } from "zod";
import {
  AppId,
  DataClass,
  GitSha,
  IsoDateTime,
  NonEmpty,
  PlatformProfile,
  ProjectKey,
  TicketKey,
  WorkMode,
} from "./common.js";

/** Rule condition (tier ① of M99). */
export const RuleCondition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }),
  z.object({ type: z.literal("component"), component: NonEmpty }),
  z.object({ type: z.literal("label"), label: NonEmpty }),
]);
export type RuleCondition = z.infer<typeof RuleCondition>;

export const RoutingRule = z
  .object({
    ruleId: NonEmpty,
    projectKey: ProjectKey.or(z.literal("*")),
    condition: RuleCondition,
    priority: z.number().int().nonnegative(),
    effect: z.object({
      appId: AppId.optional(),
      mode: WorkMode.optional(),
      dataClass: DataClass.optional(),
    }),
  })
  .superRefine((v, ctx) => {
    const e = v.effect;
    if (e.appId === undefined && e.mode === undefined && e.dataClass === undefined) {
      ctx.addIssue({ code: "custom", path: ["effect"], message: "rule must have an effect" });
    }
  });
export type RoutingRule = z.infer<typeof RoutingRule>;

/**
 * How a ticket got its primary application (M99 three tiers + M100 fan-out).
 * No silent defaults: absence of a match halts the flow (M14).
 */
export const MatchResult = z.discriminatedUnion("via", [
  z.object({ via: z.literal("rule"), ruleId: NonEmpty, appId: AppId }),
  z.object({
    via: z.literal("ai_suggestion"),
    appId: AppId,
    confidence: z.number().min(0).max(1),
    validatedAtGate: z.boolean(), // human confirms at analysis gate (M99 tier ②)
  }),
  z.object({
    via: z.literal("human"),
    appId: AppId,
    assignedBy: NonEmpty,
    channel: z.enum(["jira_command", "studio"]),
  }),
  z.object({
    via: z.literal("analysis_fanout"), // children inherit from impact matrix (M100)
    parentTicketKey: TicketKey,
    appId: AppId,
  }),
  z.object({ via: z.literal("onboarding") }), // greenfield (M42)
]);
export type MatchResult = z.infer<typeof MatchResult>;

/** Project binding trigger (M102). */
export const TriggerMode = z.enum(["auto", "label", "command"]);
export type TriggerMode = z.infer<typeof TriggerMode>;

export const BindingState = z.enum(["draft", "dry_run", "active", "paused", "unbound"]);
export type BindingState = z.infer<typeof BindingState>;

/**
 * Jira project binding (M102). Single global webhook; events are filtered
 * against active bindings inside the BFF. Activation requires a dry run of
 * the last N tickets — enforced by the binding state machine.
 */
export const JiraProjectBinding = z.object({
  projectKey: ProjectKey,
  trigger: TriggerMode,
  triggerLabel: NonEmpty.default("maestro"),
  ruleIds: z.array(NonEmpty).default([]),
  defaults: z.object({
    mode: WorkMode,
    dataClass: DataClass,
  }),
  state: BindingState,
  dryRunSampleSize: z.number().int().positive().default(20),
  lastDryRunAt: IsoDateTime.nullable().default(null),
  version: z.number().int().positive(),
});
export type JiraProjectBinding = z.infer<typeof JiraProjectBinding>;

/** Application Registry record (M100). */
export const ApplicationRecord = z.object({
  appId: AppId,
  displayName: NonEmpty,
  adoProject: NonEmpty,
  adoRepo: NonEmpty, // rendered as <adoProject>/_git/<adoRepo>
  platform: PlatformProfile,
  jiraComponent: NonEmpty.nullable().default(null),
  maestroYamlPresent: z.boolean(),
  createdVia: z.enum(["onboarding", "import"]),
});
export type ApplicationRecord = z.infer<typeof ApplicationRecord>;

export const RepoCardModule = z.object({
  name: NonEmpty,
  path: NonEmpty,
  summary: NonEmpty.max(500),
});
export type RepoCardModule = z.infer<typeof RepoCardModule>;

/**
 * Repo card (M100): per-app module summary used by the analyst to judge
 * cross-app impact WITHOUT cloning other repos. Refreshed on merge.
 */
export const RepoCard = z.object({
  appId: AppId,
  modules: z.array(RepoCardModule).min(1),
  generatedFromSha: GitSha,
  version: z.number().int().positive(),
  updatedAt: IsoDateTime,
});
export type RepoCard = z.infer<typeof RepoCard>;
