import { unavailable } from "../errors.js";

/**
 * Why a Studio screen has no data, said in the operator's words.
 *
 * The rule this file exists to enforce: a read endpoint whose store does not
 * exist REFUSES. It does not answer `{"items": []}`.
 *
 * The reason has been re-derived enough times in this project to be worth
 * writing down where the code is. An empty list and an unwired data layer
 * render identically — a calm page with nothing on it — and only one of them
 * is true. The operator reads "no golden tickets are failing" when the fact is
 * "nobody is running golden tickets". A silent wrong answer is more dangerous
 * than a noisy error, because the noisy error is the only one that gets fixed.
 *
 * 503 rather than 404: the endpoint EXISTS and the capability does not, which
 * is a deployment fact an operator can act on. 404 would say the URL was wrong.
 */

/** What each unwired capability is waiting on. */
const MISSING: Readonly<Record<string, string>> = {
  variants:
    "no VariantCatalog is injected — the Variant/VariantVersion tables exist, but this " +
    "deployment did not wire a store over them",
  pii:
    "no PiiReader is injected — masking counts come from the M33 audit trail's PII_MASKED " +
    "rows, and no store over them was wired",
  decisions:
    "no DecisionReader is injected — the ledger is read from the M33 audit chain, and no " +
    "store over it was wired",
  cache:
    "cache layers and ticket workspaces (M4/M65) have no producer. There is no `runner` " +
    "anywhere in the schema — no fleet table and no `runnerId` on WorkflowRun — and " +
    "RunnerPort exposes no size probe, so the runner holding a workspace and its size on " +
    "disk are facts nobody records. The three M4 layers have no inventory either: " +
    "`packages/cache` is Redis coordination (token bucket, lock, semaphore) and counts " +
    "neither entries nor bytes. Only `WorkflowRun.workspacePresent` exists, and rendering " +
    "the screen from it would mean inventing a runner id, a byte count and a session state " +
    "per row — three fabricated facts that would read as a measured fleet",
  eval:
    "no EvalStore is injected — golden-ticket evaluation (M38/M43/M78) reads a pool of " +
    "reference tickets and the recorded eval runs, and this deployment did not wire a store " +
    "over them. Until one is wired the route refuses rather than answer an empty page, which " +
    "would render as \"no regressions\" on a platform that has measured none",
  connections:
    "no ConnectionStore is injected — the connector-management surface (Connection / " +
    "ConnectorSecret, migration 0010) lets an admin edit the platform's outbound " +
    "connections and encipher their tokens, and this deployment did not wire the store " +
    "and the encrypting SecretPort over those tables. Until both are wired the routes " +
    "refuse rather than answer an empty list, which would read as \"no connections\" on a " +
    "platform that simply cannot edit them here",
  listening:
    "no ListeningStore is injected — the listening-rules surface (ListeningRule, migration " +
    "0011) lets an admin define which tickets Maestro picks up and how it runs them " +
    "(status/issuetype → flow type), and this deployment did not wire the store over that " +
    "table. Until one is wired the routes refuse rather than answer an empty list, which " +
    "would read as \"no rules\" on a platform that simply cannot edit them here",
  bindingWriter:
    "no BindingWriter is injected — approving an onboarding package turns the proposal " +
    "into a live JiraProjectBinding, and this deployment did not wire a store that can " +
    "write bindings. Until one is wired the approve route refuses rather than clear the " +
    "proposal without binding anything, which would look like an approval that did nothing",
  greenfield:
    "the greenfield flow (M97) has no table and no producer. No workflow writes an " +
    "architecture proposal, a step state or a repo-setup record for a ticket whose " +
    "repository does not exist yet, so there is nothing to report. An empty step list " +
    "would render as a wizard that has not started rather than a capability that is absent",
  "jira-workflow":
    "no JiraWorkflowReader is injected — the workflow-import screen (M102) reads a " +
    "project's statuses and transitions off LIVE Jira, and this deployment did not wire a " +
    "driver capable of it (the Cloud driver's readProjectWorkflow). Until one is wired the " +
    "route refuses rather than answer an empty graph, which would render as \"this project " +
    "has no workflow\" on a project that simply cannot be read here",
};

export const UNWIRED_CAPABILITIES: readonly string[] = Object.keys(MISSING);

/**
 * The capabilities NOTHING in this platform can produce, whatever a deployment
 * wires. Distinct from the three above, which refuse only when a composition
 * root leaves their store out — a deployment can fix those by injecting one,
 * and cannot fix these by injecting anything.
 *
 * This is the list the boot banner prints, so an operator is told about a
 * missing capability rather than about a wiring choice this image already made.
 */
export const NO_PRODUCER_CAPABILITIES: readonly string[] = ["cache", "greenfield"];

/**
 * The refusal. `details.missing` carries the sentence above so an operator
 * reading the network tab gets the same explanation as one reading the boot
 * banner — the two must never be able to drift.
 *
 * Nothing caller-supplied is echoed: this body reaches a log aggregator, and a
 * ticket key or a filter is not something to copy into one.
 */
export function unwired(capability: keyof typeof MISSING & string): never {
  const missing = MISSING[capability];
  throw unavailable("capability_not_wired", {
    capability,
    missing: missing ?? "no store is wired for this capability",
  });
}

/**
 * The capabilities with no producer, spelled out for the boot banner.
 *
 * Only `NO_PRODUCER_CAPABILITIES` appear: a store this deployment simply did
 * not inject is a wiring choice its own composition root already knows about,
 * and printing it beside a genuinely absent capability would flatten the
 * difference between "we chose not to" and "nobody can".
 */
export const UNWIRED_CAPABILITY_LINES: readonly string[] = NO_PRODUCER_CAPABILITIES.map(
  (capability) => `${capability} (${MISSING[capability] ?? "no producer"})`,
);
