import type { Prisma } from "@prisma/client";
import { ORG_WIDE_PROJECT_KEY, toColumnProjectKey } from "../routing-map.js";
import { ago } from "./clock.js";

/** Jira bindings and routing rules (M102 / M99) — the mock's routing screen. */

export const BINDINGS: Prisma.JiraProjectBindingCreateManyInput[] = [
  {
    projectKey: "UGURPAY",
    trigger: "auto",
    triggerLabel: "maestro",
    defaultsJson: { mode: "full_auto", dataClass: "dahili" },
    state: "active",
    dryRunSampleSize: 20,
    lastDryRunAt: ago(24 * 8),
    version: 3,
  },
  {
    projectKey: "UGURWEB",
    trigger: "label",
    triggerLabel: "maestro",
    defaultsJson: { mode: "full_auto", dataClass: "dahili" },
    state: "active",
    dryRunSampleSize: 20,
    lastDryRunAt: ago(24 * 7),
    version: 2,
  },
  {
    projectKey: "UGURMOB",
    trigger: "command", // /ai-start
    triggerLabel: "maestro",
    defaultsJson: { mode: "full_auto", dataClass: "dahili" },
    state: "active",
    dryRunSampleSize: 20,
    lastDryRunAt: ago(24 * 6),
    version: 2,
  },
  {
    projectKey: "UGURDESK",
    trigger: "auto",
    triggerLabel: "maestro",
    defaultsJson: { mode: "full_auto", dataClass: "dahili" },
    state: "active",
    dryRunSampleSize: 20,
    lastDryRunAt: ago(24 * 5),
    version: 1,
  },
  {
    // Onboarding wizard step 3/4 — not yet dry-run, so it cannot be activated.
    projectKey: "UGURKREDI",
    trigger: "label",
    triggerLabel: "maestro",
    defaultsJson: { mode: "ai_assist", dataClass: "dahili" },
    state: "draft",
    dryRunSampleSize: 20,
    lastDryRunAt: null,
    version: 1,
  },
];

/**
 * Routing rules. `projectKey` goes through `toColumnProjectKey`, so the demo
 * writes the org-wide rule the same way any other writer must (`"*"` in, NULL
 * stored) — the sentinel is never typed out by hand.
 *
 * Rule 5 of the mock ("component missing") is deliberately absent: no match is
 * what triggers tier ② (AI suggestion), and a rule that matched everything
 * would remove the very case the mock is demonstrating (M14/M99).
 */
export const ROUTING_RULES: Prisma.RoutingRuleCreateManyInput[] = [
  {
    ruleId: "rule-1",
    projectKey: toColumnProjectKey("UGURPAY"),
    conditionJson: { type: "always" },
    effectJson: { appId: "ugurpay", mode: "full_auto" },
    priority: 1,
  },
  {
    ruleId: "rule-2",
    projectKey: toColumnProjectKey("UGURWEB"),
    conditionJson: { type: "always" },
    effectJson: { appId: "ugurweb", mode: "full_auto" },
    priority: 2,
  },
  {
    ruleId: "rule-3",
    projectKey: toColumnProjectKey("UGURMOB"),
    conditionJson: { type: "component", component: "ios" },
    effectJson: { appId: "ugurmobil-ios", mode: "full_auto" },
    priority: 3,
  },
  {
    ruleId: "rule-4",
    projectKey: toColumnProjectKey("UGURMOB"),
    conditionJson: { type: "component", component: "android" },
    effectJson: { appId: "ugurmobil-android", mode: "full_auto" },
    priority: 4,
  },
  {
    ruleId: "rule-6",
    projectKey: toColumnProjectKey("UGURDESK"),
    conditionJson: { type: "always" },
    effectJson: { appId: "ugurmasaustu", mode: "full_auto" },
    priority: 6,
  },
  {
    // The org-wide data-class guard: any ticket labelled `musteri-verisi`, in
    // any project, drops to human_lead and the `gizli` class. It has no
    // binding to hang off — that is the point of an org-wide rule (M18/M99).
    ruleId: "rule-7",
    projectKey: toColumnProjectKey(ORG_WIDE_PROJECT_KEY),
    conditionJson: { type: "label", label: "musteri-verisi" },
    effectJson: { mode: "human_lead", dataClass: "gizli" },
    priority: 7,
  },
];
