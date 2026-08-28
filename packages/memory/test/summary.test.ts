import type { JournalEntry } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { MemoryArgumentError } from "../src/errors.js";
import { buildLivingSummary, SUMMARY_MAX_CHARS } from "../src/summary.js";
import { entry, RUN_ID } from "./fakes/support.js";

/** A long-running ticket: 400 events with gates, scans and a CI verdict. */
function bigJournal(): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (let seq = 0; seq < 400; seq += 1) {
    if (seq === 10) entries.push(entry({ seq, kind: "gate", actor: "human", title: "PO approved" }));
    else if (seq === 50) entries.push(entry({ seq, kind: "scan", title: "gitleaks: 1 finding" }));
    else if (seq === 60) entries.push(entry({ seq, kind: "ci", title: "build 771 failed" }));
    else if (seq === 200) entries.push(entry({ seq, kind: "gate", actor: "human", title: "TL approved" }));
    else if (seq === 390) entries.push(entry({ seq, kind: "gate", actor: "human", title: "QA approved" }));
    else entries.push(entry({ seq, detail: "x".repeat(300) }));
  }
  return entries;
}

describe("buildLivingSummary", () => {
  it("is deterministic: same journal, same characters", () => {
    const entries = bigJournal();
    const first = buildLivingSummary(RUN_ID, entries);
    const second = buildLivingSummary(RUN_ID, [...entries].reverse());
    expect(first.text).toBe(second.text);
    expect(first.upToSeq).toBe(399);
  });

  it("stays inside the contract's 8000-character ceiling", () => {
    const summary = buildLivingSummary(RUN_ID, bigJournal());
    expect(summary.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it("keeps the recent events, the gate decisions and the open findings", () => {
    const text = buildLivingSummary(RUN_ID, bigJournal()).text;
    // gates outside the recent window
    expect(text).toContain("PO approved");
    expect(text).toContain("TL approved");
    // latest finding per kind
    expect(text).toContain("gitleaks: 1 finding");
    expect(text).toContain("build 771 failed");
    // the newest events verbatim
    expect(text).toContain("#399");
    expect(text).toContain("QA approved");
    // and the compressed remainder
    expect(text).toContain("## earlier");
  });

  it("shows a superseded finding as replaced by the newer one", () => {
    const entries = [
      entry({ seq: 0, kind: "scan", title: "gitleaks: 3 findings" }),
      entry({ seq: 1, kind: "scan", title: "gitleaks: 0 findings" }),
      ...Array.from({ length: 40 }, (_, i) => entry({ seq: i + 2, detail: "y".repeat(300) })),
    ];
    const text = buildLivingSummary(RUN_ID, entries).text;
    expect(text).toContain("gitleaks: 0 findings");
    expect(text).not.toContain("gitleaks: 3 findings");
  });

  it("shows a short journal in full", () => {
    const entries = [
      entry({ seq: 0, kind: "intake", title: "ticket read" }),
      entry({ seq: 1, kind: "analysis", title: "impact matrix written" }),
    ];
    const text = buildLivingSummary(RUN_ID, entries).text;
    expect(text).toContain("## log");
    expect(text).toContain("#0");
    expect(text).toContain("#1");
  });

  it("survives a journal of pathological entries by clipping, not throwing", () => {
    const entries = Array.from({ length: 300 }, (_, seq) =>
      entry({ seq, title: "t".repeat(4000), detail: "d".repeat(4000) }),
    );
    const summary = buildLivingSummary(RUN_ID, entries);
    expect(summary.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(summary.upToSeq).toBe(299);
  });

  it("handles an empty journal", () => {
    const summary = buildLivingSummary(RUN_ID, []);
    expect(summary.upToSeq).toBe(0);
    expect(summary.text).toContain("journal empty");
  });

  it("refuses a journal that is not one run's, or that repeats a seq", () => {
    expect(() =>
      buildLivingSummary(RUN_ID, [entry({ seq: 0 }), entry({ seq: 0 })]),
    ).toThrow(MemoryArgumentError);
    expect(() =>
      buildLivingSummary(RUN_ID, [entry({ seq: 0, runId: "run-OTHER-0001" })]),
    ).toThrow(MemoryArgumentError);
  });

  it("validates its own options", () => {
    expect(() => buildLivingSummary(RUN_ID, [], { recentCount: 0 })).toThrow(MemoryArgumentError);
    expect(() => buildLivingSummary(RUN_ID, [], { lineChars: 10 })).toThrow(MemoryArgumentError);
    expect(() => buildLivingSummary(RUN_ID, [], { maxChars: 100 })).toThrow(MemoryArgumentError);
  });

  it("never exceeds a caller's smaller budget either", () => {
    const summary = buildLivingSummary(RUN_ID, bigJournal(), { maxChars: 900 });
    expect(summary.text.length).toBeLessThanOrEqual(900);
  });
});

/** A ticket that went through 30 signed gate decisions (M33/M34 evidence). */
function gateHeavyJournal(): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (let seq = 0; seq < 200; seq += 1) {
    if (seq % 6 === 0 && seq < 180) {
      entries.push(entry({ seq, kind: "gate", actor: "human", title: `gate ${seq} decided` }));
    } else {
      entries.push(entry({ seq, detail: "z".repeat(300) }));
    }
  }
  return entries;
}

const gateLines = (text: string): string[] =>
  text.split("\n").filter((line) => line.includes("/gate: "));

function omittedGates(text: string): number {
  const note = /\((\d+) earlier gate decisions omitted\)/.exec(text);
  return note === null ? 0 : Number(note[1]);
}

describe("gate decisions under a shrinking budget (M33/M34)", () => {
  const budgets = [SUMMARY_MAX_CHARS, 4000, 2000, 1200, 900, 600];

  it("keeps signed gate decisions at every level of the ladder, not just the widest", () => {
    for (const maxChars of budgets) {
      const text = buildLivingSummary(RUN_ID, gateHeavyJournal(), { maxChars }).text;
      expect(text.length).toBeLessThanOrEqual(maxChars);
      expect(text).toContain("## gate decisions");
      // The newest decision is the one a reviewer is answering; it survives.
      expect(text).toContain("gate 174 decided");
    }
  });

  it("accounts for every gate decision it could not print", () => {
    for (const maxChars of budgets) {
      const text = buildLivingSummary(RUN_ID, gateHeavyJournal(), { maxChars }).text;
      // 30 gates in the journal; the newest ones may also be in `recent`.
      const printed = new Set(gateLines(text).map((line) => line.split(" ")[0]));
      expect(printed.size + omittedGates(text)).toBe(30);
    }
  });

  it("spends a tight budget on gate decisions before anything else (O-5)", () => {
    // The verifier's probe: a narrowing ladder printed a handful of gate lines
    // out of 30 while leaving a third of the budget unused. Gate lines are the
    // core of the approval evidence (M33/M34) and get a reserved share.
    for (const [maxChars, atLeast] of [
      [4000, 20],
      [2000, 14],
      [1200, 8],
      [600, 4],
    ] as const) {
      const text = buildLivingSummary(RUN_ID, gateHeavyJournal(), { maxChars }).text;
      expect(gateLines(text).length).toBeGreaterThanOrEqual(atLeast);
      // …and the budget is actually spent, not left on the table.
      expect(text.length).toBeGreaterThan(maxChars * 0.7);
    }
  });

  it("gives the newest events up before it gives up the newest of them (D-14)", () => {
    // Clipping used to eat the tail of the text, and the tail is the newest
    // entry. Whatever else goes, the last thing that happened stays.
    for (const maxChars of [900, 600, 450]) {
      const entries = Array.from({ length: 60 }, (_, seq) =>
        entry({ seq, title: `event ${seq} ${"q".repeat(200)}` }),
      );
      const text = buildLivingSummary(RUN_ID, entries, { maxChars }).text;
      expect(text.length).toBeLessThanOrEqual(maxChars);
      expect(text).toContain("#59");
    }
  });
});

describe("timestamps (O-8)", () => {
  it("renders the same characters before and after a database round trip", () => {
    // Postgres hands `at` back as UTC; the caller wrote `+03:00`. The summary
    // is a deterministic artefact, so the same events must not produce two
    // different summaries either side of a restart.
    const local = [
      entry({ seq: 0, at: "2026-08-08T12:00:00+03:00", title: "ticket read" }),
      entry({ seq: 1, at: "2026-08-08T13:30:00+03:00", title: "patch written" }),
    ];
    const roundTripped = local.map((e) => ({ ...e, at: new Date(e.at).toISOString() }));
    expect(buildLivingSummary(RUN_ID, roundTripped).text).toBe(
      buildLivingSummary(RUN_ID, local).text,
    );
    expect(buildLivingSummary(RUN_ID, local).text).toContain("2026-08-08T09:00:00.000Z");
  });
});
