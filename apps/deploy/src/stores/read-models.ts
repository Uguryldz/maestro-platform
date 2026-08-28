import { unavailable } from "@maestro/bff";
import type { ReadModels } from "@maestro/bff";

/**
 * Studio's read side, unbridged — deliberately, and loudly.
 *
 * `BffDeps.read` demands twelve read models (M7). Not one of them has a real
 * implementation yet: they are all Postgres-backed queries over run rows, the
 * journal, gate state, the LLM call log and the audit chain, and none of those
 * stores exist — the same gap `MISSING_CORE_DEPS` names for the worker.
 *
 * The BFF ships in-memory reference implementations of all twelve
 * (`stores/read-memory.ts`), and wiring THOSE in here is the tempting move and
 * the wrong one. They answer every question truthfully about a store that is
 * empty, which in a composition root means the Studio ticket list renders
 * "no runs", the gate board renders "nothing waiting" and the audit screen
 * renders a verified chain of zero events. An operator reads that as a quiet
 * system. The truth is a disconnected data layer, and the two look identical
 * on screen — which is the entire problem. `null` and `{items: [], nextCursor:
 * null}` are the same lie in different shapes.
 *
 * So every method refuses, and the refusal names the model, the method and
 * what is missing, because the operator's next question after "why is this
 * page erroring" is "what do I have to install to fix it". The BFF still
 * COMPOSES — `buildServer` gets a structurally complete `ReadModels` and the
 * write side (webhooks, gates, params, kill switch) works — so the process
 * boots and only the screens backed by a missing store fail.
 *
 * These disappear one at a time: each read model can be replaced by a real
 * Postgres-backed one independently, and the compiler names the survivors.
 */

/** What each read model is waiting on, in the operator's words. */
const MISSING: Record<keyof ReadModels, string> = {
  runs: "no Postgres implementation for the run store (run row: ticket, app, mode, risk, cost)",
  journal: "no Postgres implementation for the journal store (M30)",
  gates: "no Postgres implementation for the gate store (open gates + escalation ladder, M88)",
  apps: "no Postgres implementation for the application registry / repo cards (M100)",
  knowledge: "no knowledge index is wired (M18/M63: no vector store driver)",
  runners: "no runner fleet store (RunnerPort reports no fleet-wide inventory, M60)",
  quota: "no subscription account store (M55)",
  cost: "no Postgres implementation for the LLM call log (M16)",
  scans: "no scan result store, and no ContainerRunner produces results to store (M27)",
  evidence: "no evidence package store (M56)",
  audit: "no Postgres-backed AuditStore; only InMemoryAuditStore ships (M33)",
  health: "no service health probe is wired (M6)",
  onboarding:
    "no Postgres implementation for the onboarding reader (bindings + application registry, M93/M102)",
  repoPolicy:
    "no Postgres implementation for the repo policy reader (.maestro.yaml as observed by a run, M52/M71)",
};

/**
 * The one refusal, built per method.
 *
 * The message carries the model, the method and the missing store — and
 * nothing else. It reaches a log aggregator and an HTTP error body, so it must
 * never grow a connection string, a credential or a caller's filter: the
 * arguments are dropped on purpose, and a ticket key or a knowledge query is
 * not something to echo into a shared log either.
 */
export function unbridgedReadError(model: keyof ReadModels, method: string): Error {
  /**
   * A 503, not a plain Error.
   *
   * A plain `Error` reaches the client as 500 `internal_error`, which says "the
   * platform broke" about a platform that is working exactly as designed. The
   * screen-by-screen sweep caught the inconsistency: `/cache` and `/eval` —
   * unwired for the same reason, through `routes/unwired.ts` — answered 503
   * `capability_not_wired`, while `/studio/runners` and `/studio/scans`
   * answered 500. Same situation, two stories, and only one of them true.
   *
   * The message carries the model, the method and the missing store — and
   * nothing else. It reaches a log aggregator and an HTTP error body, so it
   * must never grow a connection string, a credential or a caller's filter.
   */
  const explanation =
    `read model ${model}.${method}: not wired — ${MISSING[model]} (M7). Nothing in this ` +
    `platform writes that data yet, so this refuses rather than answering "nothing found", ` +
    `which reads as a calm system when the truth is a store that was never filled.`;
  const error = unavailable("capability_not_wired", {
    capability: `${model}.${method}`,
    missing: explanation,
  });
  // `HttpError`'s own message is just the code, which is the right thing on the
  // wire and the wrong thing in a log line. The full sentence goes here too so
  // an operator reading the aggregator sees which model, which method and what
  // is missing — the property the tests below pin.
  error.message = explanation;
  return error;
}

/**
 * A refusing method. Rejects rather than throwing synchronously so that a
 * caller who forgot to `await` still gets a rejected promise instead of a
 * value — a synchronous throw from a `Promise`-returning method is the one
 * shape that can slip past an `await`-less call site.
 */
function refuse(model: keyof ReadModels, method: string): () => Promise<never> {
  return () => Promise.reject(unbridgedReadError(model, method));
}

/**
 * One refusing method, for a read model that is still unbacked while its
 * neighbours are live (`stores/read-live.ts`).
 *
 * Exported because the refusal is no longer all-or-nothing: ten read models
 * answer from Postgres and two have no data to answer from, so the composition
 * root needs to refuse model-by-model rather than swap the whole set. Same
 * error, same wording — an operator gets the identical message whether nothing
 * is wired or only these two are.
 */
export function unbridgedReadModel(
  model: keyof ReadModels,
  method: string,
): () => Promise<never> {
  return refuse(model, method);
}

/**
 * The read models with no table and no producer (M27/M60).
 *
 * Not "not implemented yet": nothing in this platform WRITES a runner
 * inventory or a scan result, so a store for either would read rows that never
 * arrive. Kept as data so the boot banner and the report say the same thing.
 */
export const UNBACKED_READ_MODELS: readonly string[] = ["runners", "scans"].map(
  (model) => `${model} (${MISSING[model as keyof ReadModels]})`,
);

/**
 * The twelve read models, each refusing every method it declares.
 *
 * Every key of `ReadModels` appears; the compiler enforces that, and
 * `MISSING`'s `Record<keyof ReadModels, string>` enforces that each one also
 * explains itself. Adding a thirteenth read model to the BFF breaks this file
 * at build time, which is the correct place to find out.
 */
export function unbridgedReadModels(): ReadModels {
  return {
    runs: {
      get: refuse("runs", "get"),
      list: refuse("runs", "list"),
      // Refuses like the reads, and it matters more here: this is a WRITE. An
      // unbridged store that resolved `true` would tell an operator their run
      // was archived, hide nothing, and leave them pressing the button again.
      setArchived: refuse("runs", "setArchived"),
    },
    journal: { list: refuse("journal", "list"), summary: refuse("journal", "summary") },
    gates: { listOpen: refuse("gates", "listOpen") },
    apps: {
      get: refuse("apps", "get"),
      list: refuse("apps", "list"),
      repoCard: refuse("apps", "repoCard"),
    },
    knowledge: { search: refuse("knowledge", "search") },
    runners: { list: refuse("runners", "list"), sandboxes: refuse("runners", "sandboxes") },
    quota: { accounts: refuse("quota", "accounts") },
    cost: { calls: refuse("cost", "calls") },
    scans: { list: refuse("scans", "list") },
    evidence: { get: refuse("evidence", "get") },
    audit: { list: refuse("audit", "list"), verify: refuse("audit", "verify") },
    health: { services: refuse("health", "services") },
    onboarding: {
      options: refuse("onboarding", "options"),
      recentTickets: refuse("onboarding", "recentTickets"),
      binding: refuse("onboarding", "binding"),
    },
    repoPolicy: { list: refuse("repoPolicy", "list"), get: refuse("repoPolicy", "get") },
  };
}

/** The read models still waiting on a store, for the boot banner and RAPOR.md. */
export const MISSING_READ_MODELS: readonly string[] = Object.entries(MISSING).map(
  ([model, why]) => `${model} (${why})`,
);
