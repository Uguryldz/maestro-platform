import { describe, expect, it } from "vitest";
import { ListeningRulesStore, flowTypeLabel, isValidRule, type ListeningRule } from "../src/listening.js";
import { discoveryJql, PROJECT_KEY } from "../src/config.js";

/**
 * The pilot's listening rules — status/issuetype → flow-type, mirrored from the
 * DB and used to derive the discovery JQL and classify a ticket.
 *
 * The load-bearing behaviours: with NO rule the discovery JQL is unchanged (the
 * pilot behaves exactly as before), a `status` rule narrows discovery to those
 * statuses, disabled rules are ignored, and classification matches issue type
 * and honours priority.
 */

const BOT = "712020:bot";
const FALLBACK = discoveryJql(BOT);

function rule(over: Partial<ListeningRule> = {}): ListeningRule {
  return {
    projectKey: PROJECT_KEY,
    assigneeAccountId: BOT,
    matchKind: "issuetype",
    matchValue: "Hata",
    flowType: "duzeltme",
    priority: 100,
    enabled: true,
    ...over,
  };
}

describe("discoveryJqlFor", () => {
  it("falls back to the default JQL when there are no status rules", () => {
    const store = new ListeningRulesStore();
    expect(store.discoveryJqlFor(BOT, FALLBACK)).toBe(FALLBACK);
  });

  it("an issuetype rule alone does NOT narrow the JQL (it only classifies)", () => {
    const store = new ListeningRulesStore([rule({ matchKind: "issuetype", matchValue: "Hata" })]);
    expect(store.discoveryJqlFor(BOT, FALLBACK)).toBe(FALLBACK);
  });

  it("a status rule narrows discovery to that status, keeping project + assignee", () => {
    const store = new ListeningRulesStore([
      rule({ matchKind: "status", matchValue: "Analiz Bekliyor", flowType: "analiz" }),
    ]);
    const jql = store.discoveryJqlFor(BOT, FALLBACK);
    // The project is now quoted and OR-grouped, no longer a hard-coded literal.
    expect(jql).toContain(`project = "${PROJECT_KEY}"`);
    expect(jql).toContain(`assignee = "${BOT}"`);
    expect(jql).toContain('status IN ("Analiz Bekliyor")');
    expect(jql).not.toContain("statusCategory");
  });

  it("lists every distinct status across status rules", () => {
    const store = new ListeningRulesStore([
      rule({ matchKind: "status", matchValue: "Analiz Bekliyor", flowType: "analiz" }),
      rule({ matchKind: "status", matchValue: "Düzeltme", flowType: "duzeltme", priority: 50 }),
    ]);
    const jql = store.discoveryJqlFor(BOT, FALLBACK);
    expect(jql).toContain('"Analiz Bekliyor"');
    expect(jql).toContain('"Düzeltme"');
  });

  it("ignores disabled rules", () => {
    const store = new ListeningRulesStore([
      rule({ matchKind: "status", matchValue: "Analiz Bekliyor", enabled: false }),
    ]);
    expect(store.discoveryJqlFor(BOT, FALLBACK)).toBe(FALLBACK);
  });

  it("covers a rule on ANY project, not just a hard-coded one (K4)", () => {
    // A status rule on a different project (SAM1, not OPS) must still take effect
    // — the old code hard-coded PROJECT_KEY="OPS" and silently ignored it.
    const store = new ListeningRulesStore([
      rule({ projectKey: "SAM1", matchKind: "status", matchValue: "İncelemede", flowType: "analiz" }),
    ]);
    const jql = store.discoveryJqlFor(BOT, FALLBACK);
    expect(jql).toContain('project = "SAM1"');
    expect(jql).toContain('status IN ("İncelemede")');
  });

  it("OR-groups status rules across two projects into one JQL", () => {
    const store = new ListeningRulesStore([
      rule({ projectKey: "OPS", matchKind: "status", matchValue: "Analiz Bekliyor", flowType: "analiz" }),
      rule({ projectKey: "SAM1", matchKind: "status", matchValue: "İncelemede", flowType: "analiz", priority: 50 }),
    ]);
    const jql = store.discoveryJqlFor(BOT, FALLBACK);
    expect(jql).toContain('project = "OPS"');
    expect(jql).toContain('project = "SAM1"');
    expect(jql).toContain(") OR (");
  });
});

describe("flowTypeFor", () => {
  it("matches an issue-type rule", () => {
    const store = new ListeningRulesStore([rule({ matchKind: "issuetype", matchValue: "Hata", flowType: "duzeltme" })]);
    expect(store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hata" })).toBe("duzeltme");
  });

  it("returns null when no rule matches (default flow)", () => {
    const store = new ListeningRulesStore([rule({ matchValue: "Hata" })]);
    expect(store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hikaye" })).toBeNull();
  });

  it("honours priority — the lower number wins", () => {
    const store = new ListeningRulesStore([
      rule({ matchKind: "issuetype", matchValue: "Hikaye", flowType: "gelistirme", priority: 200 }),
      rule({ matchKind: "issuetype", matchValue: "Hikaye", flowType: "analiz", priority: 10 }),
    ]);
    expect(store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hikaye" })).toBe("analiz");
  });

  it("does not match a rule for a different assignee", () => {
    const store = new ListeningRulesStore([rule({ assigneeAccountId: "someone-else" })]);
    expect(store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hata" })).toBeNull();
  });

  it("matches a status rule on status", () => {
    const store = new ListeningRulesStore([
      rule({ matchKind: "status", matchValue: "Analiz Bekliyor", flowType: "analiz" }),
    ]);
    expect(store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: "Analiz Bekliyor", issueType: "Görev" })).toBe("analiz");
  });
});

describe("ruleFor — akış → ajan eşlemesi (Faz 3)", () => {
  it("returns the WHOLE matched rule, agent-variant mapping included", () => {
    const store = new ListeningRulesStore([
      rule({ analystVariantId: "mobil-analist", engineerVariantId: "mobil-muhendis" }),
    ]);
    const matched = store.ruleFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hata" });
    expect(matched?.flowType).toBe("duzeltme");
    expect(matched?.analystVariantId).toBe("mobil-analist");
    expect(matched?.engineerVariantId).toBe("mobil-muhendis");
  });

  it("returns null when no rule matches, and a COPY when one does", () => {
    const store = new ListeningRulesStore([rule()]);
    expect(store.ruleFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hikaye" })).toBeNull();
    const matched = store.ruleFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hata" });
    matched!.flowType = "analiz"; // mutating the copy…
    expect(store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hata" })).toBe(
      "duzeltme", // …never reaches the live store
    );
  });

  it("agrees with flowTypeFor on every match (same walk, same priority order)", () => {
    const store = new ListeningRulesStore([
      rule({ matchKind: "issuetype", matchValue: "Hikaye", flowType: "gelistirme", priority: 200 }),
      rule({ matchKind: "issuetype", matchValue: "Hikaye", flowType: "analiz", priority: 10, analystVariantId: "ozel" }),
    ]);
    const ticket = { projectKey: PROJECT_KEY, status: null, issueType: "Hikaye" } as const;
    expect(store.ruleFor(BOT, ticket)?.flowType).toBe(store.flowTypeFor(BOT, ticket));
    expect(store.ruleFor(BOT, ticket)?.analystVariantId).toBe("ozel");
  });

  it("normalises a null/empty variant field to ABSENT on set (DB null = default agent)", () => {
    const store = new ListeningRulesStore([
      rule({
        analystVariantId: null as unknown as string,
        engineerVariantId: "  ",
      }),
    ]);
    const matched = store.ruleFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hata" });
    expect(matched).not.toBeNull();
    expect(matched).not.toHaveProperty("analystVariantId");
    expect(matched).not.toHaveProperty("engineerVariantId");
    // And a padded id is trimmed, not stored verbatim.
    const trimmedStore = new ListeningRulesStore([rule({ analystVariantId: " mobil-analist " })]);
    expect(
      trimmedStore.ruleFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hata" })
        ?.analystVariantId,
    ).toBe("mobil-analist");
  });
});

describe("isValidRule (mirror boundary guard)", () => {
  it("accepts a well-formed rule", () => {
    expect(isValidRule(rule())).toBe(true);
  });

  it("rejects an unknown flowType", () => {
    expect(isValidRule({ ...rule(), flowType: "silme" })).toBe(false);
  });

  it("rejects an unknown matchKind", () => {
    expect(isValidRule({ ...rule(), matchKind: "component" })).toBe(false);
  });

  it("rejects a missing field and non-objects", () => {
    const { priority: _p, ...noPriority } = rule();
    expect(isValidRule(noPriority)).toBe(false);
    expect(isValidRule(null)).toBe(false);
    expect(isValidRule("x")).toBe(false);
  });

  it("accepts the agent-variant fields as string, null or absent (Faz 3)", () => {
    expect(isValidRule({ ...rule(), analystVariantId: "mobil-analist" })).toBe(true);
    expect(isValidRule({ ...rule(), engineerVariantId: "mobil-muhendis" })).toBe(true);
    // A DB row without an override mirrors as null — well-formed, not dropped.
    expect(isValidRule({ ...rule(), analystVariantId: null, engineerVariantId: null })).toBe(true);
    expect(isValidRule(rule())).toBe(true); // absent stays valid
  });

  it("rejects a non-string, non-null variant field (malformed mirror entry)", () => {
    expect(isValidRule({ ...rule(), analystVariantId: 7 })).toBe(false);
    expect(isValidRule({ ...rule(), engineerVariantId: { id: "x" } })).toBe(false);
  });
});

describe("flowTypeLabel", () => {
  it("gives a Turkish label per flow", () => {
    expect(flowTypeLabel("analiz")).toBe("analiz");
    expect(flowTypeLabel("duzeltme")).toBe("düzeltme");
    expect(flowTypeLabel("gelistirme")).toBe("geliştirme");
  });
});

/**
 * "Bota atanan her ticket" in the ENGINE — `matchKind: "assigned"` (0020).
 *
 * The BFF decides the flow for webhook-driven tickets; the pilot decides it for
 * the ones it discovers itself. Both matchers must agree, or a ticket would run
 * one flow when Jira pushed it and another when the poll found it.
 *
 * The discovery JQL is deliberately NOT extended for this kind. `discoveryJqlFor`
 * narrows to explicit statuses only when status rules exist; with none, it falls
 * back to `assignee = <bot> AND statusCategory != Done`, which already finds
 * every open ticket the bot holds. A catch-all needs no clause of its own — and
 * adding one would narrow discovery for a rule whose whole point is not to.
 */
describe("a rule on the assignment alone", () => {
  const CATCH_ALL = rule({ matchKind: "assigned", matchValue: "*", flowType: "analiz" });

  it("classifies a ticket of any type, including one with no type at all", () => {
    const store = new ListeningRulesStore([CATCH_ALL]);
    for (const ticket of [
      { projectKey: PROJECT_KEY, status: "Devam Ediyor", issueType: "Görev" },
      { projectKey: PROJECT_KEY, status: "Onay Bekliyor", issueType: "Talep" },
      // A conditioned rule matches nothing here; the catch-all reads no field.
      { projectKey: PROJECT_KEY, status: null, issueType: null },
    ]) {
      expect(store.flowTypeFor(BOT, ticket)).toBe("analiz");
    }
  });

  it("still belongs to its own project and its own bot", () => {
    const store = new ListeningRulesStore([CATCH_ALL]);
    expect(store.flowTypeFor(BOT, { projectKey: "OTHER", status: null, issueType: "Görev" })).toBeNull();
    expect(
      store.flowTypeFor("712020:ayse", { projectKey: PROJECT_KEY, status: null, issueType: "Görev" }),
    ).toBeNull();
  });

  it("loses to a rule that names a condition, whatever the priorities say", () => {
    // The catch-all is given the BETTER priority on purpose: specificity has to
    // outrank it, or one catch-all would shadow every deliberate rule in the
    // project the moment an operator added it.
    const store = new ListeningRulesStore([
      { ...CATCH_ALL, priority: 1 },
      rule({ matchValue: "Hata", flowType: "duzeltme", priority: 900 }),
    ]);
    expect(
      store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Hata" }),
    ).toBe("duzeltme");
    // …and it still catches everything the specific rule does not.
    expect(
      store.flowTypeFor(BOT, { projectKey: PROJECT_KEY, status: null, issueType: "Görev" }),
    ).toBe("analiz");
  });

  it("survives the mirror's validator instead of being dropped as malformed", () => {
    // `isValidRule` is the boundary the BFF mirror crosses. A kind it did not
    // know would drop the rule silently — present in the database and on the
    // Studio screen, absent from the engine.
    expect(isValidRule(CATCH_ALL)).toBe(true);
  });

  it("does not narrow the discovery JQL, which already finds every assigned ticket", () => {
    const store = new ListeningRulesStore([CATCH_ALL]);
    // Unchanged fallback: `statusCategory != Done` on the bot's own queue is a
    // superset of "every ticket assigned to the bot", so there is nothing to add.
    expect(store.discoveryJqlFor(BOT, FALLBACK)).toBe(FALLBACK);
  });
});
