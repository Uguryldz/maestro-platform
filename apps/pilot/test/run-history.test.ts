import { describe, expect, it } from "vitest";
import { StateStore, initialState, STEP_DEFINITIONS } from "../src/state.js";

/**
 * The pilot's run HISTORY — finished runs are archived so past work survives the
 * next run overwriting the live state. These tests pin the load-bearing rules:
 * outcome classification, de-duplication, and "nothing to archive" safety.
 */

function storeWith(mutate: (s: ReturnType<StateStore["snapshot"]>) => void): StateStore {
  const store = new StateStore(
    initialState({ model: "m", jiraSite: "https://x", approverGroup: "g" }),
  );
  store.update(mutate);
  return store;
}

const lastStepId = STEP_DEFINITIONS[STEP_DEFINITIONS.length - 1]!.id;

describe("run history", () => {
  it("archives nothing when no run has started", () => {
    const store = new StateStore(initialState({ model: "m", jiraSite: "x", approverGroup: "g" }));
    store.archiveCurrent();
    expect(store.historySnapshot()).toHaveLength(0);
  });

  it("records a completed run (ran to the last step) as tamamlandı", () => {
    const store = storeWith((s) => {
      s.runId = "r1";
      s.ticketKey = "OPS-1";
      s.finished = true;
      for (const step of s.steps) step.state = "tamam";
    });
    const total = store.snapshot().steps.length;
    store.archiveCurrent();
    const [entry] = store.historySnapshot();
    expect(entry).toMatchObject({ runId: "r1", ticketKey: "OPS-1", outcome: "tamamlandı" });
    expect(entry?.stepsDone).toBe(total);
  });

  it("records a run that stopped early (clean, not all steps) as durduruldu", () => {
    // e.g. an "analiz" flow: steps 1-2 done, engineering skipped, no failure.
    const store = storeWith((s) => {
      s.runId = "r2";
      s.ticketKey = "OPS-2";
      s.finished = true;
      s.steps[0]!.state = "tamam";
      s.steps[1]!.state = "tamam";
    });
    store.archiveCurrent();
    expect(store.historySnapshot()[0]).toMatchObject({ outcome: "durduruldu", stepsDone: 2 });
  });

  it("records a failed run as hata with the failure detail", () => {
    const store = storeWith((s) => {
      s.runId = "r3";
      s.ticketKey = "OPS-3";
      s.failure = "build patladı";
    });
    store.archiveCurrent();
    expect(store.historySnapshot()[0]).toMatchObject({ outcome: "hata", detail: "build patladı" });
  });

  it("does not duplicate a run already archived", () => {
    const store = storeWith((s) => {
      s.runId = "r4";
      s.ticketKey = "OPS-4";
      s.finished = true;
      s.steps.find((x) => x.id === lastStepId)!.state = "tamam";
    });
    store.archiveCurrent();
    store.archiveCurrent();
    expect(store.historySnapshot()).toHaveLength(1);
  });

  it("keeps newest first across multiple runs", () => {
    const store = new StateStore(initialState({ model: "m", jiraSite: "x", approverGroup: "g" }));
    store.update((s) => {
      s.runId = "a";
      s.ticketKey = "OPS-A";
      s.failure = "x";
    });
    store.archiveCurrent();
    store.update((s) => {
      s.runId = "b";
      s.ticketKey = "OPS-B";
      s.failure = "y";
    });
    store.archiveCurrent();
    expect(store.historySnapshot().map((h) => h.runId)).toEqual(["b", "a"]);
  });
});
