import type { ParamDefinition } from "@maestro/contracts";

/**
 * The operational parameter set (M71).
 *
 * Every `descriptionKey` here is a key `packages/config/locales` ALREADY
 * carries — none is invented for the demo. That matters more than it looks: the
 * params screen renders the description through the catalog, so a key the
 * catalog does not know would render as a raw dotted string in a bank's console,
 * and a demo that shipped one would be demonstrating the M104 failure rather
 * than the parameter.
 *
 * `guarded: true` is the four-eyes flag: changing one of those needs a second
 * approver, and the params service enforces it. Both kinds are present so a
 * reviewer can watch the guarded path refuse a single-handed change.
 */
export const DEMO_PARAMS: readonly ParamDefinition[] = [
  {
    key: "gate.set",
    scope: "global",
    type: "json",
    guarded: true,
    descriptionKey: "params.description.gate_set",
    defaultValue: { dusuk: ["5", "12"], orta: ["4", "5", "11", "12"], kritik: ["4", "5", "9", "11", "12"] },
  },
  {
    key: "scan.block_level",
    scope: "global",
    type: "enum",
    guarded: true,
    enumValues: ["low", "medium", "high", "critical"],
    descriptionKey: "params.description.scan_block_level",
    defaultValue: "high",
  },
  {
    key: "merge.mode",
    scope: "global",
    type: "enum",
    guarded: true,
    enumValues: ["human_merge", "auto_merge"],
    descriptionKey: "params.description.merge_mode",
    defaultValue: "human_merge",
  },
  {
    key: "data_class.policy",
    scope: "global",
    type: "enum",
    guarded: true,
    enumValues: ["block", "degrade", "queue"],
    descriptionKey: "params.description.data_class_policy",
    defaultValue: "block",
  },
  {
    key: "sod.qa_split",
    scope: "global",
    type: "boolean",
    guarded: true,
    descriptionKey: "params.description.sod_qa_split",
    defaultValue: true,
  },
  {
    key: "reminder.channel",
    scope: "global",
    type: "enum",
    guarded: false,
    enumValues: ["teams", "smtp", "slack"],
    descriptionKey: "params.description.reminder_channel",
    defaultValue: "teams",
  },
  {
    key: "output.language",
    scope: "project",
    type: "enum",
    guarded: false,
    enumValues: ["tr", "en"],
    descriptionKey: "params.description.output_language",
    defaultValue: "tr",
  },
  {
    key: "quota.warn_pct",
    scope: "global",
    type: "number",
    guarded: false,
    descriptionKey: "params.description.quota_warn_pct",
    defaultValue: 80,
  },
  {
    key: "build.timeout_min",
    scope: "application",
    type: "number",
    guarded: false,
    descriptionKey: "params.description.build_timeout_min",
    defaultValue: 45,
  },
  {
    key: "stuck.threshold",
    scope: "global",
    type: "number",
    guarded: false,
    descriptionKey: "params.description.stuck_threshold",
    defaultValue: 3,
  },
  {
    key: "workspace.max_age_days",
    scope: "global",
    type: "number",
    guarded: false,
    descriptionKey: "params.description.workspace_max_age_days",
    defaultValue: 14,
  },
  {
    key: "trigger.mode",
    scope: "project",
    type: "enum",
    guarded: false,
    enumValues: ["auto", "label", "command"],
    descriptionKey: "params.description.trigger_mode",
    defaultValue: "auto",
  },
];
