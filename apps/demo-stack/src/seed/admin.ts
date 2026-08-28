import type {
  ConnectionView,
  DocTemplateOutput,
  DocTemplateRecord,
  NotifyDriverView,
  RoutingProjectView,
  RoutingRuleView,
} from "@maestro/bff";
import { DEMO_BINDINGS } from "./platform.js";

/**
 * The three administration screens' demo data: platform wiring, ticket routing
 * and the corporate Word template.
 *
 * The demo stack's whole discipline applies here — the BFF and its routes are
 * the shipped ones, and only the STORES are seeded — so this file is the demo's
 * answer to "what would a bank's wiring look like", not a second implementation
 * of the endpoints.
 *
 * The states are deliberately mixed. Every connection green would make the
 * settings screen useless as a demo of the thing it exists for: telling
 * "nobody configured this" apart from "this is configured and broken".
 */

export const DEMO_CONNECTIONS: readonly ConnectionView[] = [
  {
    id: "jira",
    endpoint: "https://jira.ugurbank.local",
    status: "connected",
    credentialRef: "vault:maestro/jira#token",
    checkedAt: null,
  },
  {
    id: "ado",
    endpoint: "https://tfs.ugurbank.local/tfs/DefaultCollection",
    status: "connected",
    credentialRef: "vault:maestro/ado#pat",
    checkedAt: null,
  },
  {
    id: "vault",
    endpoint: "https://vault.ugurbank.local",
    status: "connected",
    // Vault holds the credentials, so it authenticates with a workload
    // identity rather than with a secret of its own.
    credentialRef: "kubernetes-auth",
    checkedAt: null,
  },
  {
    id: "storage",
    endpoint: "https://s3.ugurbank.local",
    status: "degraded",
    credentialRef: "vault:maestro/storage#access-key",
    checkedAt: null,
  },
  {
    id: "egress_proxy",
    endpoint: "http://egress.ugurbank.local:3128",
    status: "connected",
    credentialRef: "none",
    checkedAt: null,
  },
  {
    id: "identity",
    endpoint: "ldaps://ad.ugurbank.local:636",
    status: "connected",
    credentialRef: "vault:maestro/ldap#bind-password",
    checkedAt: null,
  },
  {
    // Never wired in this deployment, and listed anyway: a connection missing
    // from the table reads as "not part of the platform", and audit forwarding
    // very much is (M33).
    id: "siem",
    endpoint: "",
    status: "unconfigured",
    credentialRef: "none",
    checkedAt: null,
  },
  {
    id: "publish",
    endpoint: "https://jira.ugurbank.local",
    status: "connected",
    credentialRef: "vault:maestro/jira#token",
    checkedAt: null,
  },
];

export const DEMO_NOTIFY_DRIVERS: readonly NotifyDriverView[] = [
  { channel: "jira", enabled: true, target: "ticket comment" },
  { channel: "teams", enabled: true, target: "platform channel" },
  { channel: "smtp", enabled: true, target: "approver mailbox" },
  // Not every bank runs Slack. Shown disabled rather than omitted, so an
  // operator can see the channel exists and is off.
  { channel: "slack", enabled: false, target: "platform channel" },
];

/**
 * Routing, derived from the demo's own bindings rather than typed out twice.
 *
 * Deriving it is the point: the routing screen and the intake path must agree
 * about which projects are bound, and two hand-maintained lists drift the
 * moment somebody edits one.
 */
export const DEMO_ROUTING_PROJECTS: readonly RoutingProjectView[] = DEMO_BINDINGS.map(
  (binding) => ({
    projectKey: binding.projectKey,
    trigger: binding.triggerMode === "auto" ? "auto" : "label",
    apps: binding.appId === null ? [] : [binding.appId],
    ...noteFor(binding.active, binding.triggerMode),
  }),
);

/**
 * The note as a catalog key, mirroring `notePhrase` in the Postgres store —
 * the demo stack must exercise the SAME wire shape the real one produces, or
 * it stops being a rehearsal of the screen.
 */
function noteFor(
  active: boolean,
  triggerMode: "auto" | "opt_in",
): { noteKey: string; noteParams?: Record<string, string> } {
  if (!active) return { noteKey: "routing.note.unbound" };
  return triggerMode === "auto"
    ? { noteKey: "routing.note.active_auto" }
    : { noteKey: "routing.note.active_label", noteParams: { label: "maestro" } };
}

export const DEMO_ROUTING_RULES: readonly RoutingRuleView[] = [
  {
    ruleId: "pay-odeme",
    conditionKey: "routing.condition.component",
    conditionParams: { value: "odeme" },
    effect: "ugurpay",
    priority: 10,
    projectKey: "UGURPAY",
  },
  {
    ruleId: "web-default",
    conditionKey: "routing.condition.always",
    effect: "ugurweb",
    priority: 20,
    projectKey: "UGURWEB",
  },
  {
    // Org-wide, which the contract spells `"*"` and the column stores as NULL.
    ruleId: "org-hotfix",
    conditionKey: "routing.condition.label",
    conditionParams: { value: "hotfix" },
    effect: "assignment queue",
    priority: 5,
    projectKey: "*",
  },
];

/**
 * No corporate template is uploaded in the demo, and that is the interesting
 * state rather than a gap: the template screen's job is to show that generation
 * continues on a plain fallback WITH a visible warning, and seeding a file
 * would hide the exact behaviour a document owner needs to see before they
 * upload one.
 */
export const DEMO_DOC_TEMPLATES: readonly DocTemplateRecord[] = [];

/** Documents already produced — on the fallback layout, hence version 0. */
export const DEMO_DOC_OUTPUTS: readonly DocTemplateOutput[] = [
  { fileName: "UGURPAY-1042-analiz.docx", at: "2026-08-07T14:22:00.000Z", templateVersion: 0 },
  { fileName: "UGURWEB-318-analiz.docx", at: "2026-08-06T10:05:00.000Z", templateVersion: 0 },
];
