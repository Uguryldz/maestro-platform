import { describe, expect, it } from "vitest";
import {
  IncompleteRunContextError,
  PrismaRunContextStore,
  RunNotFoundError,
  UnpinnedRunError,
  toRunUpdate,
  type ApplicationRow,
  type RunRow,
  type RunCreate,
  type RunUpdate,
} from "../src/stores/run-context.js";

/**
 * The run context store, against a recording fake delegate.
 *
 * The delegate is a plain object because the store takes a structural type —
 * the same reason `users.test.ts` can exercise `PrismaUserDirectory` offline.
 * What is asserted here is the behaviour the database cannot enforce: which
 * run a ticket resolves to, what happens when there is none, and the exact
 * boundary between "patch this field" and "leave it alone".
 */

const APP: ApplicationRow = {
  appId: "core-api",
  displayName: "Core API",
  adoProject: "Core",
  adoRepo: "core-api",
  platform: "linux-node",
  jiraComponent: "payments",
  maestroYamlPresent: true,
  createdVia: "onboarding",
};

function row(over: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-pay-101-0001",
    ticketKey: "PAY-101",
    appId: APP.appId,
    step: "3",
    status: "running",
    mode: "full_auto",
    risk: null,
    dataClass: "dahili",
    locale: "tr",
    variantId: "v1",
    templateVersion: "analysis@1.0.0",
    workspacePath: "/w/pay-101",
    workspacePresent: true,
    protectedPathsJson: ["infra/**"],
    verificationJson: [{ name: "test", command: ["pnpm", "test"] }],
    branch: "maestro/PAY-101",
    targetBranch: "main",
    prId: null,
    resumeToken: null,
    application: APP,
    ...over,
  };
}

interface Recorded {
  queries: unknown[];
  updates: Array<{ where: { id: string }; data: RunUpdate }>;
  creates: RunCreate[];
}

function fakeDelegate(result: RunRow | null): {
  delegate: ConstructorParameters<typeof PrismaRunContextStore>[0];
  recorded: Recorded;
} {
  const recorded: Recorded = { queries: [], updates: [], creates: [] };
  return {
    recorded,
    delegate: {
      findFirst: (args) => {
        recorded.queries.push(args);
        return Promise.resolve(result);
      },
      update: (args) => {
        recorded.updates.push(args);
        return Promise.resolve(undefined);
      },
      create: (args) => {
        recorded.creates.push(args.data);
        return Promise.resolve(undefined);
      },
    },
  };
}

describe("PrismaRunContextStore.get", () => {
  it("maps a row and its application into a RunContext", async () => {
    const { delegate } = fakeDelegate(row());
    const context = await new PrismaRunContextStore(delegate).get("PAY-101");

    expect(context.runId).toBe("run-pay-101-0001");
    expect(context.app?.adoRepo).toBe("core-api");
    expect(context.branch).toBe("maestro/PAY-101");
    expect(context.protectedPaths).toEqual(["infra/**"]);
    expect(context.verification).toEqual([{ name: "test", command: ["pnpm", "test"] }]);
    expect(context.risk).toBeNull();
  });

  /**
   * `fail` is in the set for the same reason `done` is: the reconciler
   * (`reconcile.ts`) writes it when the engine reports a crashed run, and a
   * failed run that still read as live would keep handing activities a dead
   * run's context and would block the ticket's next `/ai-start` on the partial
   * unique index (P2002). The migration's WHERE clause is the same list.
   */
  it("asks only for runs that are not finished, newest first", async () => {
    const { delegate, recorded } = fakeDelegate(row());
    await new PrismaRunContextStore(delegate).get("PAY-101");

    expect(recorded.queries[0]).toMatchObject({
      where: { ticketKey: "PAY-101", status: { notIn: ["done", "cancelled", "fail"] } },
      orderBy: { startedAt: "desc" },
    });
  });

  /**
   * The fail-closed pair. An activity that received an empty context would
   * carry on with an invented branch and an empty repo — and the first thing
   * it does with either is write to a bank's repository.
   */
  it("throws rather than inventing a context when no live run exists", async () => {
    const { delegate } = fakeDelegate(null);
    await expect(new PrismaRunContextStore(delegate).get("PAY-999")).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
  });

  it("throws when the run POINTS AT an application that is gone, rather than inventing a blank one", async () => {
    // `appId` set (the row() default) but the join empty: a dangling
    // reference, which is the incomplete-context failure it always was.
    const { delegate } = fakeDelegate(row({ application: null }));
    await expect(new PrismaRunContextStore(delegate).get("PAY-101")).rejects.toBeInstanceOf(
      IncompleteRunContextError,
    );
  });

  it("maps an analysis-only row — appId null on purpose — to a context with app: null", async () => {
    // The OTHER null: the binding named no application, so the run honestly
    // has none. Refusing here would fail every activity of a run intake
    // deliberately started; the activities that need an app refuse for
    // themselves (`appOf` in impl/delivery.ts).
    const { delegate } = fakeDelegate(row({ appId: null, application: null }));
    const context = await new PrismaRunContextStore(delegate).get("PAY-101");
    expect(context.app).toBeNull();
    expect(context.runId).toBe("run-pay-101-0001");
  });

  /**
   * A JSON column holds whatever was written. A half-parsed command would
   * reach the runner as a spawn of `undefined`, so entries without a usable
   * argv are dropped rather than passed on.
   */
  it("drops malformed verification entries instead of passing them to a runner", async () => {
    const { delegate } = fakeDelegate(
      row({
        verificationJson: [
          { name: "ok", command: ["pnpm", "lint"] },
          { name: "no-argv" },
          { name: "", command: ["x"] },
          { name: "not-strings", command: [1, 2] },
          "nonsense",
        ],
      }),
    );
    const context = await new PrismaRunContextStore(delegate).get("PAY-101");
    expect(context.verification).toEqual([{ name: "ok", command: ["pnpm", "lint"] }]);
  });

  it("reads a malformed protectedPaths column as no additions", async () => {
    const { delegate } = fakeDelegate(row({ protectedPathsJson: { not: "an array" } }));
    const context = await new PrismaRunContextStore(delegate).get("PAY-101");
    expect(context.protectedPaths).toEqual([]);
  });
});

describe("PrismaRunContextStore.patch", () => {
  it("writes only the named fields and leaves the rest alone", async () => {
    const { delegate, recorded } = fakeDelegate(row());
    await new PrismaRunContextStore(delegate).patch("PAY-101", { branch: "maestro/PAY-101-v2" });

    expect(recorded.updates).toHaveLength(1);
    expect(recorded.updates[0]?.data).toEqual({ branch: "maestro/PAY-101-v2" });
  });

  it("does not issue an update when nothing it owns changed", async () => {
    const { delegate, recorded } = fakeDelegate(row());
    // `runId`, `ticket` and `app` are not this store's columns to write.
    await new PrismaRunContextStore(delegate).patch("PAY-101", { runId: "other" });
    expect(recorded.updates).toHaveLength(0);
  });

  it("refuses to patch a ticket with no live run", async () => {
    const { delegate } = fakeDelegate(null);
    await expect(
      new PrismaRunContextStore(delegate).patch("PAY-999", { branch: "x" }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});

/**
 * `toRunUpdate` is the whole partial-update contract, so it is tested directly:
 * an absent key must never become an explicit value, and a deliberately-null
 * one must never be dropped.
 */
describe("toRunUpdate", () => {
  it("produces nothing for an empty patch", () => {
    expect(toRunUpdate({})).toEqual({});
  });

  it("distinguishes an absent nullable field from one set to null", () => {
    expect(toRunUpdate({})).not.toHaveProperty("prId");
    expect(toRunUpdate({ prId: null })).toEqual({ prId: null });
    expect(toRunUpdate({ prId: 77 })).toEqual({ prId: 77 });

    expect(toRunUpdate({})).not.toHaveProperty("resumeToken");
    expect(toRunUpdate({ resumeToken: null })).toEqual({ resumeToken: null });
    expect(toRunUpdate({ resumeToken: "tok" })).toEqual({ resumeToken: "tok" });
  });

  it("keeps false and empty string, which a truthiness test would drop", () => {
    expect(toRunUpdate({ workspacePresent: false })).toEqual({ workspacePresent: false });
    expect(toRunUpdate({ branch: "" })).toEqual({ branch: "" });
  });

  /**
   * The other half of the pin invariant. `create` refuses an empty pin; this
   * is the write path that could otherwise UN-pin a run that opened correctly,
   * putting the row back into the state OPS-22 failed from.
   *
   * Dropped rather than rejected, because `patch` is a partial update: the
   * caller is asking to change other columns, and no caller means to clear a
   * live run's variant. Keeping the pinned value is the safe resolution.
   */
  it("refuses to blank a pinned variant or template", () => {
    expect(toRunUpdate({ variantId: "" })).not.toHaveProperty("variantId");
    expect(toRunUpdate({ variantId: "   " })).not.toHaveProperty("variantId");
    expect(toRunUpdate({ templateVersion: "" })).not.toHaveProperty("templateVersion");
  });

  it("still writes a real variant and template", () => {
    // The guard above must not cost the legitimate re-pin its write.
    expect(toRunUpdate({ variantId: "analyst-kredi" })).toEqual({ variantId: "analyst-kredi" });
    expect(toRunUpdate({ templateVersion: "7" })).toEqual({ templateVersion: "7" });
  });

  it("copies array fields rather than storing the caller's reference", () => {
    const paths = ["a/**"];
    const update = toRunUpdate({ protectedPaths: paths });
    paths.push("b/**");
    expect(update.protectedPathsJson).toEqual(["a/**"]);
  });

  it("converts readonly command specs into a writable JSON shape", () => {
    const update = toRunUpdate({ verification: [{ name: "t", command: ["pnpm", "t"] }] });
    expect(update.verificationJson).toEqual([{ name: "t", command: ["pnpm", "t"] }]);
  });
});

/**
 * `create` — the row that has to exist before any activity can read a context.
 *
 * The deployment this method was written for had a worker polling an empty
 * queue: `signalWithStart` started executions and nothing wrote a run, so the
 * first activity of every run failed with `RunNotFoundError`. These tests pin
 * the two properties that failure mode needs — the row is written with the
 * workflow's own opening state, and calling twice for one ticket writes once.
 */
describe("PrismaRunContextStore.create", () => {
  const newRun = {
    runId: "run-1",
    ticket: "OPS-1",
    appId: "payments",
    mode: "ai_assist",
    dataClass: "gizli",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    variantId: "analyst-default",
    templateVersion: "1",
  } as const;

  it("opens the row at step 0 and status running", async () => {
    const { delegate, recorded } = fakeDelegate(null);
    await new PrismaRunContextStore(delegate).create(newRun);

    expect(recorded.creates).toHaveLength(1);
    const created = recorded.creates[0] as RunCreate;
    expect(created.id).toBe("run-1");
    expect(created.ticketKey).toBe("OPS-1");
    expect(created.appId).toBe("payments");
    expect(created.step).toBe("0");
    expect(created.status).toBe("running");
  });

  it("pins the variant and template the run will use", async () => {
    // Found live: the column defaults to "" and the row was written without
    // these, so the FIRST model call failed the gateway's contract with
    // `variantId: Too small` — three activity retries deep, reading as a model
    // problem rather than a run opened without saying which agent it runs.
    const { delegate, recorded } = fakeDelegate(null);
    await new PrismaRunContextStore(delegate).create(newRun);

    const created = recorded.creates[0] as RunCreate;
    expect(created.variantId).toBe("analyst-default");
    expect(created.templateVersion).toBe("1");
  });

  it("opens an analysis-only row with the appId column left untouched", async () => {
    // Omitted, not written as an explicit null: the column keeps its schema
    // default and a run that HAS an app writes the exact row it always wrote.
    const { delegate, recorded } = fakeDelegate(null);
    await new PrismaRunContextStore(delegate).create({ ...newRun, appId: null });

    expect(recorded.creates).toHaveLength(1);
    expect(Object.hasOwn(recorded.creates[0] as object, "appId")).toBe(false);
    expect((recorded.creates[0] as RunCreate).status).toBe("running");
  });

  it("is a no-op when the ticket already has a live run", async () => {
    // The second of two racing webhook deliveries: Temporal collapsed them into
    // one execution, so a second row would be the bug.
    const { delegate, recorded } = fakeDelegate(row());
    await new PrismaRunContextStore(delegate).create(newRun);
    expect(recorded.creates).toHaveLength(0);
  });

  it("treats a unique violation as success", async () => {
    // Both callers passed the pre-check simultaneously; the partial unique
    // index from migration 0002 rejected the loser. The row exists, which is
    // what the caller wanted, so the rejection must not propagate.
    const store = new PrismaRunContextStore({
      findFirst: () => Promise.resolve(null),
      update: () => Promise.resolve(undefined),
      create: () => Promise.reject(Object.assign(new Error("unique"), { code: "P2002" })),
    });
    await expect(store.create(newRun)).resolves.toBeUndefined();
  });

  /**
   * The regression OPS-22 and OPS-23 died of.
   *
   * Both rows were written with `variantId = ""` (the column defaults to it,
   * and `RunCreate.variantId` is optional, so nothing stopped the write). The
   * failure surfaced 19 activity attempts later inside the LLM gateway as
   * `ZodError: variantId: Too small: expected string to have >=1 characters` —
   * naming neither the ticket nor the caller that opened it.
   *
   * These tests assert the row is never written, not merely that something
   * throws: an exception raised after a successful `create` would leave the
   * same poisoned row behind and still pass a rejects-only assertion.
   */
  it("refuses to open a run with an empty variantId", async () => {
    const { delegate, recorded } = fakeDelegate(null);
    const store = new PrismaRunContextStore(delegate);

    await expect(store.create({ ...newRun, variantId: "" })).rejects.toBeInstanceOf(
      UnpinnedRunError,
    );
    expect(recorded.creates).toHaveLength(0);
  });

  it("refuses a whitespace-only variantId, as the gateway would", async () => {
    // `z.string().min(1)` accepts " ", so a bare length check here would move
    // the same failure one space further along instead of stopping it.
    const { delegate, recorded } = fakeDelegate(null);
    await expect(
      new PrismaRunContextStore(delegate).create({ ...newRun, variantId: "   " }),
    ).rejects.toBeInstanceOf(UnpinnedRunError);
    expect(recorded.creates).toHaveLength(0);
  });

  it("names the ticket and the missing pin in the message", async () => {
    // The point of failing here rather than in the gateway: the message has to
    // say which run was opened wrong, or it is no better than the ZodError.
    const { delegate } = fakeDelegate(null);
    await expect(
      new PrismaRunContextStore(delegate).create({ ...newRun, variantId: "" }),
    ).rejects.toThrow(/OPS-1.*variantId/s);
  });

  it("refuses an empty templateVersion too", async () => {
    const { delegate, recorded } = fakeDelegate(null);
    await expect(
      new PrismaRunContextStore(delegate).create({ ...newRun, templateVersion: "" }),
    ).rejects.toBeInstanceOf(UnpinnedRunError);
    expect(recorded.creates).toHaveLength(0);
  });

  it("refuses an unpinned run even when one is already live", async () => {
    // The guard runs BEFORE the idempotency check. A second webhook delivery
    // carrying an empty pin is the retry that makes a wiring bug reproducible;
    // returning quietly there would hide it at the best moment to see it.
    const { delegate } = fakeDelegate(row());
    await expect(
      new PrismaRunContextStore(delegate).create({ ...newRun, variantId: "" }),
    ).rejects.toBeInstanceOf(UnpinnedRunError);
  });

  it("propagates any other write failure", async () => {
    // A dead connection must not read as "run opened": intake would report a
    // started run whose row never existed, and the failure would surface one
    // activity later as "no live run" — far from its cause.
    const store = new PrismaRunContextStore({
      findFirst: () => Promise.resolve(null),
      update: () => Promise.resolve(undefined),
      create: () => Promise.reject(new Error("connection reset")),
    });
    await expect(store.create(newRun)).rejects.toThrow("connection reset");
  });
});
