import { describe, expect, it } from "vitest";
import { englishAside, matchValueLabel } from "../src/screens/common/jira-english.ts";

/**
 * The English aside — a label, and only ever a label.
 *
 * The module exists because half the bank runs the Jira UI in English and goes
 * looking for `Task` and `Bug` while the rules say `Görev` and `Hata`. It is
 * one table lookup, and its whole risk profile is in two behaviours:
 *
 *  1. it must never CHANGE a value — `flow-decision.ts` compares `matchValue`
 *     to `fields.issuetype.name` verbatim, and OPS-66 really carries `Görev`,
 *     so a rule that stored `Task` would match nothing, silently, forever;
 *  2. it must never INVENT a translation — a bank's own custom type gets no
 *     aside at all rather than a confident guess.
 *
 * The screen tests cover (1) end to end; these cover the table itself, plus the
 * Turkish case-folding that İ makes non-obvious.
 */

describe("englishAside", () => {
  it("answers the standard issue types Jira ships", () => {
    expect(englishAside("Görev")).toBe("Task");
    expect(englishAside("Hata")).toBe("Bug");
    expect(englishAside("Hikaye")).toBe("Story");
    expect(englishAside("Epik")).toBe("Epic");
    expect(englishAside("Alt görev")).toBe("Subtask");
  });

  it("answers the standard statuses, İ and ı included", () => {
    // The live OPS board's own four names. `İNCELEMEDE` is genuinely upper-case
    // on this site and starts with the dotted capital İ, which folds to `i̇` (an
    // `i` plus a COMBINING DOT ABOVE) under the invariant lower-casing rule —
    // the one character that would silently break the most common status.
    expect(englishAside("İNCELEMEDE")).toBe("In Review");
    expect(englishAside("Yapılacaklar")).toBe("To Do");
    expect(englishAside("Devam Ediyor")).toBe("In Progress");
    expect(englishAside("Tamam")).toBe("Done");
  });

  it("is case- and whitespace-insensitive, because Jira sites are not consistent", () => {
    expect(englishAside("görev")).toBe("Task");
    expect(englishAside("  Hata  ")).toBe("Bug");
    expect(englishAside("DEVAM EDİYOR")).toBe("In Progress");
  });

  it("says nothing for a name outside the standard set", () => {
    // A bank's own types. "Request" and "Waiting for approval" are plausible
    // and would be inventions; the module refuses to make them.
    expect(englishAside("Talep")).toBeNull();
    expect(englishAside("Onay Bekliyor")).toBeNull();
    expect(englishAside("")).toBeNull();
  });

  it("says nothing when the site already serves the English name", () => {
    // An English-locale Jira, or a type Jira never translated. `Task (Task)`
    // is noise, not help.
    expect(englishAside("Task")).toBeNull();
    expect(englishAside("Subtask")).toBeNull();
    expect(englishAside("Bug")).toBeNull();
  });
});

describe("matchValueLabel", () => {
  it("pairs the two names without altering the stored one", () => {
    expect(matchValueLabel("Görev")).toBe("Görev (Task)");
    expect(matchValueLabel("İNCELEMEDE")).toBe("İNCELEMEDE (In Review)");
  });

  it("returns the name UNCHANGED when there is nothing to add", () => {
    // Identity is the property that matters: a caller that ever passed this
    // result to a payload would still be sending the exact stored value for
    // every name outside the table — the aside is the only difference.
    for (const name of ["Talep", "Onay Bekliyor", "Task", ""]) {
      expect(matchValueLabel(name)).toBe(name);
    }
  });
});
