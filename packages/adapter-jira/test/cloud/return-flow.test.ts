import { describe, expect, it } from "vitest";
import {
  foldStatusName,
  selectDoneTransition,
  selectReturnTransition,
  selectTransitionByStatusName,
  type AvailableTransition,
} from "../../src/cloud/return-flow.js";

/**
 * Transition selection is by status CATEGORY, never by a hard-coded name — a
 * Jira site renames "Done"/"To Do" freely, but the category key is stable. These
 * tests pin that: the Done selector finds the merged-ticket close transition, and
 * a workflow with no Done edge yields null (not an error).
 */

function tr(over: Partial<AvailableTransition>): AvailableTransition {
  return {
    id: "1",
    name: "Move",
    toStatusId: "s1",
    toStatusName: "Status",
    toCategoryKey: "indeterminate",
    toCategoryName: "In Progress",
    ...over,
  };
}

describe("selectDoneTransition", () => {
  it("picks the transition whose destination is in the Done category (by key)", () => {
    const transitions = [
      tr({ id: "10", toStatusName: "Devam Ediyor", toCategoryKey: "indeterminate" }),
      tr({ id: "20", toStatusName: "Tamam", toCategoryKey: "done", toCategoryName: "Done" }),
    ];
    expect(selectDoneTransition(transitions)?.id).toBe("20");
  });

  it("matches a renamed Done column by category name when the key is absent", () => {
    const transitions = [tr({ id: "30", toStatusName: "Kapandı", toCategoryKey: "", toCategoryName: "Done" })];
    expect(selectDoneTransition(transitions)?.id).toBe("30");
  });

  it("returns null when no transition leads to a Done status", () => {
    const transitions = [
      tr({ toCategoryKey: "new", toCategoryName: "To Do" }),
      tr({ toCategoryKey: "indeterminate", toCategoryName: "In Progress" }),
    ];
    expect(selectDoneTransition(transitions)).toBeNull();
  });

  it("does not confuse Done with To Do", () => {
    const transitions = [tr({ toCategoryKey: "new", toCategoryName: "To Do" })];
    expect(selectDoneTransition(transitions)).toBeNull();
    expect(selectReturnTransition(transitions)).not.toBeNull();
  });
});

describe("foldStatusName", () => {
  it("folds Turkish's four-way i onto one letter", () => {
    // The whole point: all four of İ/I/ı/i must land on the same folded letter,
    // which is what neither toLowerCase() nor toLocaleLowerCase("tr") does alone.
    expect(foldStatusName("İNCELEMEDE")).toBe(foldStatusName("incelemede"));
    expect(foldStatusName("İncelemede")).toBe(foldStatusName("ınceleMEDE"));
    expect(foldStatusName("IŞIK")).toBe(foldStatusName("ışık"));
  });

  it("is independent of the host locale and of Unicode composition", () => {
    // A decomposed İ (I + U+0307) is what some clients send; it must compare
    // equal to the precomposed one Jira stores.
    const decomposed = "I\u0307NCELEMEDE"; // I + combining dot above
    expect(decomposed).not.toBe("İNCELEMEDE"); // genuinely different code points
    expect(foldStatusName(decomposed)).toBe(foldStatusName("İNCELEMEDE"));
    expect(foldStatusName("  Devam   Ediyor ")).toBe("devam ediyor");
  });

  it("leaves non-i Turkish letters alone — folding must not blur ş/ğ/ü", () => {
    expect(foldStatusName("Gözden Geçir")).toBe("gözden geçir");
    expect(foldStatusName("Tamam")).not.toBe(foldStatusName("Taman"));
  });
});

describe("selectTransitionByStatusName", () => {
  // The live OPS workflow: transition 31 is NAMED "In Review" but its destination
  // STATUS is "İNCELEMEDE". The two differ, so the pass order is load-bearing.
  const live = [
    tr({ id: "11", name: "Yapılacaklar", toStatusName: "Yapılacaklar", toCategoryKey: "new" }),
    tr({ id: "31", name: "In Review", toStatusName: "İNCELEMEDE" }),
    tr({ id: "41", name: "Tamam", toStatusName: "Tamam", toCategoryKey: "done" }),
  ];

  it("prefers the destination status name over the transition name", () => {
    expect(selectTransitionByStatusName(live, "İNCELEMEDE")?.id).toBe("31");
    expect(selectTransitionByStatusName(live, "incelemede")?.id).toBe("31");
  });

  it("falls back to the transition name when no destination matches", () => {
    expect(selectTransitionByStatusName(live, "In Review")?.id).toBe("31");
  });

  it("prefers a destination match even when another transition is NAMED the target", () => {
    // A workflow where one transition is named "Tamam" but leads elsewhere, while
    // another really lands on "Tamam" — the destination must win.
    const tricky = [
      tr({ id: "50", name: "Tamam", toStatusName: "Devam Ediyor" }),
      tr({ id: "60", name: "Bitir", toStatusName: "Tamam", toCategoryKey: "done" }),
    ];
    expect(selectTransitionByStatusName(tricky, "Tamam")?.id).toBe("60");
  });

  it("returns null for an unknown or empty status name", () => {
    expect(selectTransitionByStatusName(live, "Buzdolabında")).toBeNull();
    expect(selectTransitionByStatusName(live, "   ")).toBeNull();
  });
});
