import { describe, expect, it } from "vitest";
import { planFor } from "../src/flow-plan.js";

/**
 * The flow plan turns a listening rule's flow type into real behaviour — which
 * steps the run executes. This is the contract the run loop reads, so the tests
 * pin exactly what each flow includes and excludes.
 */
describe("planFor", () => {
  it("analiz: analysis + gate, but NO engineering (analysis is the deliverable)", () => {
    expect(planFor("analiz")).toEqual({ analysisGate: true, engineering: false });
  });

  it("duzeltme: engineering, but SKIP the analysis gate (small targeted fix)", () => {
    expect(planFor("duzeltme")).toEqual({ analysisGate: false, engineering: true });
  });

  it("gelistirme: the full pipeline", () => {
    expect(planFor("gelistirme")).toEqual({ analysisGate: true, engineering: true });
  });

  it("null (no rule matched): the full pipeline, so a ticket is never under-processed", () => {
    expect(planFor(null)).toEqual({ analysisGate: true, engineering: true });
  });
});
