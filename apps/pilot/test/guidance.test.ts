import { describe, expect, it } from "vitest";
import { GuidanceStore } from "../src/guidance.js";
import { buildAnalysisContext } from "../src/analysis.js";
import type { TicketSnapshot } from "@maestro/contracts";

/**
 * The pilot's guidance store ("öğren" notes mirrored from the DB) and its
 * injection into the analysis context. The load-bearing behaviours: malformed
 * notes are dropped, and enabled notes become the analyst's knowledge docs.
 */

const TICKET = {
  key: "OPS-1",
  projectKey: "OPS",
  title: "t",
  description: "d",
  labels: [],
} as unknown as TicketSnapshot;

describe("GuidanceStore", () => {
  it("keeps well-formed notes and drops malformed ones", () => {
    const store = new GuidanceStore();
    store.set([
      { title: "A", content: "ok" },
      { title: "", content: "no title" } as never,
      { title: "B", content: "" } as never,
      { title: "  C  ", content: "  trimmed  " },
    ]);
    expect(store.snapshot()).toEqual([
      { title: "A", content: "ok" },
      { title: "C", content: "trimmed" },
    ]);
  });

  it("replaces the whole set on set()", () => {
    const store = new GuidanceStore([{ title: "old", content: "x" }]);
    store.set([{ title: "new", content: "y" }]);
    expect(store.snapshot()).toEqual([{ title: "new", content: "y" }]);
  });

  it("forVariant: global notlar herkese, hedefli not yalnız kendi ajanına", () => {
    const store = new GuidanceStore([
      { title: "genel", content: "herkese" },
      { title: "analiste özel", content: "x", variantId: "ozel-analist" },
      { title: "mühendise özel", content: "y", variantId: "ozel-muhendis" },
    ]);
    expect(store.forVariant("ozel-analist").map((n) => n.title)).toEqual(["genel", "analiste özel"]);
    expect(store.forVariant("ozel-muhendis").map((n) => n.title)).toEqual(["genel", "mühendise özel"]);
    // Çözülmemiş ajan yalnız global görür; hedefli not asla sızmaz.
    expect(store.forVariant(null).map((n) => n.title)).toEqual(["genel"]);
    expect(store.forVariant("baska-ajan").map((n) => n.title)).toEqual(["genel"]);
  });

  it("variantId sınırda normalize edilir: boş/whitespace → hedefsiz (global)", () => {
    const store = new GuidanceStore([
      { title: "a", content: "x", variantId: "  " },
      { title: "b", content: "y", variantId: " v1 " },
    ]);
    expect(store.snapshot()).toEqual([
      { title: "a", content: "x" },
      { title: "b", content: "y", variantId: "v1" },
    ]);
  });
});

describe("buildAnalysisContext with guidance", () => {
  it("injects guidance notes as the analyst's knowledge docs", () => {
    const context = buildAnalysisContext(TICKET, [
      { title: "Ekstre kuralı", content: "Son 12 ay ile sınırla." },
    ]);
    expect(context.knowledge.knowledgeDocs).toEqual([
      { name: "Ekstre kuralı", text: "Son 12 ay ile sınırla." },
    ]);
  });

  it("leaves knowledge docs empty when there is no guidance", () => {
    const context = buildAnalysisContext(TICKET);
    expect(context.knowledge.knowledgeDocs).toEqual([]);
  });
});
