import { describe, expect, it } from "vitest";
import { buildTurnRunner } from "../src/bin/worker.js";
import { DEGRADED_CAPABILITIES, degradedCapabilities, MISSING_CORE_DEPS } from "../src/boot.js";
import { loadDeployEnv, type DeployEnv } from "../src/env.js";
import { buildCoreStores } from "../src/stores/core.js";
import { unrunnableTurnRunner } from "../src/stores/execution.js";
import { liveReadModels, type ReadModelDb } from "../src/stores/read-live.js";

/**
 * A digest-pinned reference. A tag would be refused by the runner's own schema
 * (M27), which is the point of the pin: a build environment that can change
 * without a deployment makes every verification result unreproducible.
 */
const PINNED_IMAGE = `node@sha256:${"a".repeat(64)}`;

/** The environment, with only the variables these tests care about set. */
function envWith(over: Record<string, string>): DeployEnv {
  return loadDeployEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    ...over,
  });
}

/**
 * A strike-counter delegate that answers empty.
 *
 * The wired runner hydrates a run's counters before its first turn, so it
 * genuinely reaches the database — which is the difference between a seam that
 * refuses and one that works. Handing it `{}` would make it throw a
 * `TypeError` and look, to an anti-drift check, exactly like a refusal.
 */
function emptyCounters(): never {
  return {
    findMany: () => Promise.resolve([]),
    upsert: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(undefined),
  } as never;
}

/**
 * An `LlmPort` that never answers. No network, no subscription: these tests
 * are about which runner was BUILT, not about what a turn produces.
 */
function stubLlm(): never {
  const refuse = (): Promise<never> => Promise.reject(new Error("llm: not used by this test"));
  return { generateObject: refuse, agentSession: refuse } as never;
}

/**
 * A `ReadModelDb` whose every delegate answers empty.
 *
 * The read models under test here never reach it — they refuse before touching
 * a delegate — but `liveReadModels` builds all twelve, so the nine live ones
 * need something to hold.
 */
function emptyReadDb(): ReadModelDb {
  const page = {
    findMany: () => Promise.resolve([]),
    count: () => Promise.resolve(0),
    // Never reached (these models refuse first), but `RunCatalogDelegate` now
    // declares the 0019 write and every delegate has to hold its whole shape.
    updateMany: () => Promise.resolve({ count: 0 }),
  };
  return {
    workflowRun: page,
    llmCall: { ...page, groupBy: () => Promise.resolve([]) },
    journalEntry: page,
    gate: page,
    application: { ...page, findUnique: () => Promise.resolve(null) },
    repoCard: { findFirst: () => Promise.resolve(null) },
    knowledgeDoc: page,
    subscriptionAccount: { findMany: () => Promise.resolve([]) },
    evidencePackageRow: { findFirst: () => Promise.resolve(null) },
    jiraProjectBinding: { ...page, findUnique: () => Promise.resolve(null) },
    auditLog: { findMany: () => Promise.resolve([]) },
  };
}

/**
 * The worker's start-up precondition.
 *
 * Through wave 4 `bin/worker.ts` composed every port and then threw, because
 * `MISSING_CORE_DEPS` named six unimplemented stores. These tests are what
 * make the change to that list a deliberate act rather than a side effect: if
 * somebody re-adds an entry, the worker refuses to poll again, and the first
 * test below says so out loud.
 */
describe("the worker's core dependencies", () => {
  /**
   * THE assertion of this wave. An empty list is what lets `bin/worker.ts`
   * reach `startMaestroWorker` instead of throwing.
   */
  it("names nothing missing, so the worker may poll", () => {
    expect([...MISSING_CORE_DEPS]).toEqual([]);
  });

  /**
   * `buildCoreStores` is what replaced those six entries, so it must produce
   * all six. A store that quietly went missing would otherwise show up as an
   * `undefined` dependency at the first activity that used it.
   */
  it("builds every store the activities need", () => {
    const stores = buildCoreStores(stubDb(), {
      sql: { query: () => Promise.resolve([]) },
      transactions: { transaction: (fn) => fn({ query: () => Promise.resolve([]) }) },
    });

    for (const name of ["runs", "gates", "params", "directory", "idempotency", "audit"] as const) {
      expect(stores[name], name).toBeDefined();
    }
  });

  /**
   * The turn runner is WIRED now — `AgentExecution`'s three collaborators all
   * exist in `@maestro/execution`. What can still stop a turn is deployment
   * configuration, and the refusal for that case says so: an operator can act
   * on "set RUNNER_IMAGE_LINUX", where the old "nobody implemented this" left
   * them nothing to do.
   *
   * `endRun` stays a no-op: it is cleanup, and throwing there would replace a
   * run's real failure with this one.
   */
  it("refuses an engineering turn only for a missing sandbox fleet, and names it", async () => {
    const runner = unrunnableTurnRunner(
      "execution: no sandbox fleet is configured — RUNNER_IMAGE_LINUX is unset",
    );
    await expect(
      runner.runTurn({
        context: {} as never,
        dataClass: "dahili",
        variantId: "v1",
        verification: [],
      }),
    ).rejects.toThrow(/RUNNER_IMAGE_LINUX/);
    expect(() => runner.endRun("run-1")).not.toThrow();
  });

  /**
   * The other half of the same change: with an image configured the seam is a
   * real `SandboxAgentTurnRunner` and nothing refuses.
   */
  it("builds a real turn runner once a sandbox fleet is configured", () => {
    const built = buildTurnRunner(
      envWith({ RUNNER_IMAGE_LINUX: PINNED_IMAGE }),
      { strikeCounter: emptyCounters() } as never,
      { llm: {} as never, storage: {} as never },
    );

    expect(built.degradedReason).toBeNull();
    expect(typeof built.runner.runTurn).toBe("function");
  });

  /**
   * The refusal above is correct but INVISIBLE at start-up, and that is its own
   * problem: the worker logs "polling", an operator reads a healthy image, and
   * the gap only appears when a real ticket reaches the engineering turn. This
   * pair keeps the declaration and the refusal tied together.
   */
  describe("declared degraded capabilities", () => {
    /**
     * THE assertion of this wave: the engineering turn is no longer a
     * permanent degradation. Its three collaborators exist, so a worker that
     * has a sandbox fleet has nothing to announce about it — and a warning
     * that is wrong once is ignored forever after.
     */
    it("does not declare the turn runner when a sandbox fleet is configured", () => {
      expect(degradedCapabilities(null).some((e) => e.includes("AgentTurnRunner"))).toBe(false);
      expect([...DEGRADED_CAPABILITIES].some((e) => e.includes("AgentTurnRunner"))).toBe(false);
    });

    /**
     * The configured-out case still has to be visible at boot. This is the
     * quieter failure the list exists to prevent, and it did not stop being
     * possible just because the code was written.
     */
    it("declares the turn runner when this deployment has no sandbox fleet", () => {
      const built = buildTurnRunner(envWith({}), { strikeCounter: emptyCounters() } as never, {
        llm: {} as never,
        storage: {} as never,
      });

      expect(built.degradedReason).not.toBeNull();
      const declared = degradedCapabilities(built.degradedReason);
      const entry = declared.find((line) => line.includes("AgentTurnRunner")) ?? "";
      // Named precisely enough that an operator can tell what to set.
      expect(entry).toMatch(/RUNNER_IMAGE_LINUX/);
      expect(entry).toMatch(/engineering turn/);
    });

    /**
     * The two read models with no store behind them (M27/M60). Declared here
     * for the same reason the turn runner is: `/studio/runners` and
     * `/studio/scans` refuse at runtime, and a refusal nobody announced at
     * boot is a screen that breaks in front of an operator with no warning.
     */
    it("declares the read models that refuse, naming what is missing", () => {
      const runners = DEGRADED_CAPABILITIES.find((line) => line.includes("runners (M60)")) ?? "";
      const scans = DEGRADED_CAPABILITIES.find((line) => line.includes("scans (M27)")) ?? "";

      expect(runners).toMatch(/studio\/runners/);
      expect(runners).toMatch(/no runner-fleet table/);
      expect(scans).toMatch(/studio\/scans/);
      expect(scans).toMatch(/nothing persists one/);
    });

    /** Every declaration is a real one; the list has no leftovers. */
    it("declares exactly the two capabilities this image lacks", () => {
      expect(DEGRADED_CAPABILITIES.length).toBe(2);
    });

    /**
     * The anti-drift assertion, kept pointing at the thing that can still
     * drift: the banner and the runner must agree about whether a turn will
     * run. It fails if a future change makes one refuse without the other
     * announcing it, in EITHER direction.
     */
    it("declares the turn runner exactly when the seam itself refuses", async () => {
      for (const image of [undefined, PINNED_IMAGE]) {
        const built = buildTurnRunner(
          envWith(image === undefined ? {} : { RUNNER_IMAGE_LINUX: image }),
          { strikeCounter: emptyCounters() } as never,
          { llm: stubLlm(), storage: {} as never },
        );

        /**
         * "Refuses" means the SEAM refused — the placeholder that rejects
         * before doing anything. A wired runner also rejects here, because the
         * stub context has no workspace to probe, and the two have to be told
         * apart or this assertion passes for the wrong reason.
         */
        const refusedAtSeam = await built.runner
          .runTurn({ context: {} as never, dataClass: "dahili", variantId: "v1", verification: [] })
          .then(
            () => false,
            (error: Error) => error.message.includes("RUNNER_IMAGE_LINUX"),
          );
        const declared = degradedCapabilities(built.degradedReason).some((e) =>
          e.includes("AgentTurnRunner"),
        );
        expect(declared, `image=${String(image)}`).toBe(refusedAtSeam);
      }
    });

    /**
     * The same anti-drift rule for the read side: the moment somebody wires a
     * real runner-fleet or scan store, the composition root stops refusing and
     * this assertion fails — which is what stops the banner from announcing a
     * gap the image no longer has.
     */
    it("declares the read models only for as long as they actually refuse", async () => {
      const read = liveReadModels({
        db: emptyReadDb(),
        audit: {
          head: () => Promise.resolve(null),
          append: () => Promise.resolve(),
          read: () => Promise.resolve([]),
        },
        probes: [],
      });

      for (const [name, call] of [
        ["runners (M60)", () => read.runners.list({ limit: 1, cursor: null })],
        ["scans (M27)", () => read.scans.list({ limit: 1, cursor: null, projectKeys: null })],
      ] as const) {
        const refuses = await call().then(
          () => false,
          () => true,
        );
        const declared = DEGRADED_CAPABILITIES.some((entry) => entry.includes(name));
        expect(declared).toBe(refuses);
      }
    });
  });
});

/** Just enough shape for `buildCoreStores`; nothing here is called. */
function stubDb(): Parameters<typeof buildCoreStores>[0] {
  const never = (): never => {
    throw new Error("not called");
  };
  return {
    workflowRun: { findFirst: never, update: never, findUnique: never, create: never },
    gate: { findUnique: never, update: never },
    auditLog: { findFirst: never, findMany: never, create: never },
    paramVersion: { findMany: never },
    routingRule: { findMany: never },
    user: { findMany: never },
    idempotencyKey: { findUnique: never, update: never, delete: never },
  };
}
