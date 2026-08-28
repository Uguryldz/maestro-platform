import { describe, expect, it } from "vitest";
import { flowDecisionFor, ruleFor, rulesFor, type ClassifiableTicket } from "../src/flow-decision.js";
import type { ListeningRuleRecord } from "../src/listening-store.js";

/**
 * Per-ticket flow selection.
 *
 * The point of this module is that TWO TICKETS IN ONE PROJECT can run different
 * flows — the thing `flowOf(env)` could not express, because it read the flow
 * off the process environment and so bound the whole deployment to one answer.
 */

function rule(over: Partial<ListeningRuleRecord> = {}): ListeningRuleRecord {
  return {
    ruleId: "lr_1",
    projectKey: "OPS",
    assigneeAccountId: "",
    matchKind: "issuetype",
    matchValue: "Hata",
    flowType: "duzeltme",
    priority: 100,
    enabled: true,
    ...over,
  };
}

function ticket(over: Partial<ClassifiableTicket> = {}): ClassifiableTicket {
  return { projectKey: "OPS", status: null, issueType: null, assignee: null, ...over };
}

describe("flowDecisionFor — two tickets, one project, different flows", () => {
  // The headline behaviour. Both rules live in project OPS and both are
  // enabled; only the ticket differs.
  const rules = [
    rule({ ruleId: "lr_bug", matchKind: "issuetype", matchValue: "Hata", flowType: "duzeltme", priority: 10 }),
    rule({ ruleId: "lr_analysis", matchKind: "issuetype", matchValue: "Analiz", flowType: "analiz", priority: 20 }),
  ];

  it("routes a 'Hata' ticket to the engineering fix flow", () => {
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    // `statusMap: null` is comment-only mode — these rules map no columns, so
    // the decision says so explicitly rather than leaving the field absent.
    expect(decision).toEqual({ flow: "duzeltme", reason: "rule", ruleId: "lr_bug", statusMap: null });
  });

  it("routes an 'Analiz' ticket in the SAME project to the analysis flow", () => {
    const decision = flowDecisionFor(rules, ticket({ issueType: "Analiz" }), null);
    expect(decision).toEqual({ flow: "analiz", reason: "rule", ruleId: "lr_analysis", statusMap: null });
  });

  it("gives the two tickets genuinely different flows", () => {
    const bug = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    const analysis = flowDecisionFor(rules, ticket({ issueType: "Analiz" }), null);
    expect(bug.flow).not.toBe(analysis.flow);
  });

  it("matches on status as well as issue type", () => {
    const statusRules = [
      rule({ ruleId: "lr_todo", matchKind: "status", matchValue: "Yapılacak", flowType: "gelistirme" }),
    ];
    expect(flowDecisionFor(statusRules, ticket({ status: "Yapılacak" }), null).flow).toBe("gelistirme");
  });
});

describe("flowDecisionFor — fall back to the deployment default", () => {
  it("uses the deployment default when NO rule matches", () => {
    const decision = flowDecisionFor([rule({ matchValue: "Hata" })], ticket({ issueType: "Görev" }), "analiz");
    expect(decision).toEqual({ flow: "analiz", reason: "default" });
  });

  it("uses the deployment default when there are no rules at all", () => {
    expect(flowDecisionFor([], ticket({ issueType: "Hata" }), "analiz")).toEqual({
      flow: "analiz",
      reason: "default",
    });
  });

  it("leaves the flow UNSET when no rule matches and the deployment names no default", () => {
    // `null` flow means the engine's own full-pipeline default (`planFor`).
    expect(flowDecisionFor([], ticket({ issueType: "Hata" }), null)).toEqual({ flow: null, reason: "none" });
    expect(flowDecisionFor([], ticket({ issueType: "Hata" }), undefined)).toEqual({ flow: null, reason: "none" });
  });

  it("lets a matching rule OVERRIDE the deployment default", () => {
    // The whole point: an `analiz` deployment can still run a fix ticket.
    const decision = flowDecisionFor([rule({ flowType: "duzeltme" })], ticket({ issueType: "Hata" }), "analiz");
    expect(decision.flow).toBe("duzeltme");
    expect(decision.reason).toBe("rule");
  });
});

describe("flowDecisionFor — what does NOT match", () => {
  it("ignores a rule belonging to another project", () => {
    const other = [rule({ projectKey: "PAY", flowType: "duzeltme" })];
    expect(flowDecisionFor(other, ticket({ projectKey: "OPS", issueType: "Hata" }), "analiz").reason).toBe("default");
  });

  it("ignores a disabled rule", () => {
    const off = [rule({ enabled: false, flowType: "duzeltme" })];
    expect(flowDecisionFor(off, ticket({ issueType: "Hata" }), "analiz").reason).toBe("default");
  });

  it("ignores a rule whose assignee is not the ticket's assignee", () => {
    const bot = [rule({ assigneeAccountId: "712020:bot", flowType: "duzeltme" })];
    const humanTicket = ticket({ issueType: "Hata", assignee: "ayse.kaya" });
    expect(flowDecisionFor(bot, humanTicket, "analiz").reason).toBe("default");
  });

  it("matches a rule whose assignee IS the ticket's assignee", () => {
    const bot = [rule({ assigneeAccountId: "712020:bot", flowType: "duzeltme" })];
    const botTicket = ticket({ issueType: "Hata", assignee: "712020:bot" });
    expect(flowDecisionFor(bot, botTicket, "analiz").flow).toBe("duzeltme");
  });

  it("treats an empty rule assignee as 'any assignee'", () => {
    const anyone = [rule({ assigneeAccountId: "  ", flowType: "duzeltme" })];
    expect(flowDecisionFor(anyone, ticket({ issueType: "Hata", assignee: "ayse.kaya" }), null).flow).toBe("duzeltme");
  });

  it("does NOT let a field the payload omitted match an empty matchValue", () => {
    // A delivery that carried no status must match nothing, rather than
    // matching a rule whose `matchValue` happens to be empty.
    const empty = [rule({ matchKind: "status", matchValue: "", flowType: "gelistirme" })];
    expect(flowDecisionFor(empty, ticket({ status: null }), "analiz").reason).toBe("default");
  });
});

describe("flowDecisionFor — priority and conflicts (fail-closed)", () => {
  it("lets the lowest priority number win when rules agree on nothing else", () => {
    const rules = [
      rule({ ruleId: "lr_low", matchValue: "Hata", flowType: "duzeltme", priority: 50 }),
      rule({ ruleId: "lr_high", matchValue: "Hata", flowType: "duzeltme", priority: 5 }),
    ];
    expect(ruleFor(rules, ticket({ issueType: "Hata" }))?.ruleId).toBe("lr_high");
  });

  it("takes the NARROWEST flow when two rules disagree, and says so", () => {
    // A status rule and an issuetype rule can both match one ticket; no unique
    // index can prevent that. `analiz` writes no code, so it is the safe pick
    // even though the wider rule has the better priority.
    const rules = [
      rule({ ruleId: "lr_type", matchKind: "issuetype", matchValue: "Hata", flowType: "gelistirme", priority: 1 }),
      rule({ ruleId: "lr_status", matchKind: "status", matchValue: "Yapılacak", flowType: "analiz", priority: 90 }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }), null);

    expect(decision.flow).toBe("analiz");
    expect(decision.reason).toBe("rule_conflict");
    expect(decision.ruleId).toBe("lr_status");
    expect([...(decision.conflictingRuleIds ?? [])].sort()).toEqual(["lr_status", "lr_type"]);
  });

  it("prefers duzeltme over gelistirme when those two conflict", () => {
    const rules = [
      rule({ ruleId: "lr_a", matchKind: "issuetype", matchValue: "Hata", flowType: "gelistirme", priority: 1 }),
      rule({ ruleId: "lr_b", matchKind: "status", matchValue: "Yapılacak", flowType: "duzeltme", priority: 2 }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }), null);
    expect(decision.flow).toBe("duzeltme");
    expect(decision.reason).toBe("rule_conflict");
  });

  it("does NOT report a conflict when both matching rules name the same flow", () => {
    const rules = [
      rule({ ruleId: "lr_a", matchKind: "issuetype", matchValue: "Hata", flowType: "analiz", priority: 1 }),
      rule({ ruleId: "lr_b", matchKind: "status", matchValue: "Yapılacak", flowType: "analiz", priority: 2 }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }), null);
    expect(decision.reason).toBe("rule");
    expect(decision.conflictingRuleIds).toBeUndefined();
  });

  it("decides the same way whatever order the store returned the rows in", () => {
    // Determinism: the flow travels into the workflow input, so the same rule
    // set must always produce the same answer.
    const rules = [
      rule({ ruleId: "lr_b", matchValue: "Hata", flowType: "duzeltme", priority: 10 }),
      rule({ ruleId: "lr_a", matchValue: "Hata", flowType: "duzeltme", priority: 10 }),
    ];
    const forward = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    const reversed = flowDecisionFor([...rules].reverse(), ticket({ issueType: "Hata" }), null);
    expect(forward).toEqual(reversed);
    expect(forward.ruleId).toBe("lr_a");
  });
});

describe("rulesFor / ruleFor", () => {
  it("returns every matching rule, most important first", () => {
    const rules = [
      rule({ ruleId: "lr_2", matchValue: "Hata", priority: 20 }),
      rule({ ruleId: "lr_1", matchKind: "status", matchValue: "Yapılacak", priority: 10 }),
      rule({ ruleId: "lr_x", matchValue: "Görev", priority: 1 }),
    ];
    const matched = rulesFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }));
    expect(matched.map((r) => r.ruleId)).toEqual(["lr_1", "lr_2"]);
  });

  it("returns null when nothing matches", () => {
    expect(ruleFor([rule({ matchValue: "Hata" })], ticket({ issueType: "Görev" }))).toBeNull();
  });

  it("returns a COPY, so a caller cannot mutate the stored rule", () => {
    const rules = [rule({ matchValue: "Hata" })];
    const found = ruleFor(rules, ticket({ issueType: "Hata" }));
    found!.flowType = "gelistirme";
    expect(rules[0]!.flowType).toBe("duzeltme");
  });

  it("carries the rule's agent-variant mapping through", () => {
    const rules = [rule({ matchValue: "Hata", analystVariantId: "analist-v2", engineerVariantId: "kodcu-v1" })];
    const found = ruleFor(rules, ticket({ issueType: "Hata" }));
    expect(found?.analystVariantId).toBe("analist-v2");
    expect(found?.engineerVariantId).toBe("kodcu-v1");
  });
});

/**
 * The status map travels with the flow, out of the same rule row and in the
 * same decision.
 *
 * It has to be one read and one answer: "which flow does this ticket run" and
 * "which columns does it move through" are both properties of the rule that
 * matched, and asking for them separately would let a rule edit between the two
 * reads give a ticket one rule's flow and another rule's board.
 */
describe("flowDecisionFor — the deciding rule's status map", () => {
  const MAP = { onStart: "Devam Ediyor", onReview: "İNCELEMEDE", onDone: "Tamam" } as const;

  it("carries the winning rule's map into the decision", () => {
    const rules = [rule({ ruleId: "lr_map", matchValue: "Hata", statusMap: MAP })];
    expect(flowDecisionFor(rules, ticket({ issueType: "Hata" }), null).statusMap).toEqual(MAP);
  });

  it("answers null — comment-only mode — for a rule that maps nothing", () => {
    const rules = [rule({ ruleId: "lr_bare", matchValue: "Hata" })];
    expect(flowDecisionFor(rules, ticket({ issueType: "Hata" }), null).statusMap).toBeNull();
  });

  /**
   * A ticket that matched NO rule has no operator-configured board, and the
   * deployment default names a flow but never a column set. Inventing one would
   * mean every unclassified ticket in the bank started being driven around
   * somebody's Jira uninvited.
   */
  it("leaves the map absent when the deployment default decided", () => {
    const decision = flowDecisionFor([rule({ matchValue: "Hata" })], ticket({ issueType: "Görev" }), "analiz");
    expect(decision.reason).toBe("default");
    expect(decision.statusMap).toBeUndefined();
  });

  it("leaves the map absent when nothing decided at all", () => {
    const decision = flowDecisionFor([], ticket({ issueType: "Hata" }), null);
    expect(decision.reason).toBe("none");
    expect(decision.statusMap).toBeUndefined();
  });

  /**
   * Under a conflict the map comes from the rule that WON the flow, never
   * merged across the matching set: a merged map would drive the ticket to a
   * column no single rule asked for, which is a board move nobody configured
   * and nobody can explain afterwards.
   */
  it("takes the map from the rule that won a conflict, unmerged", () => {
    const rules = [
      rule({ ruleId: "lr_fix", matchKind: "issuetype", matchValue: "Hata", flowType: "duzeltme", priority: 1, statusMap: { onDone: "Bitti" } }),
      rule({ ruleId: "lr_an", matchKind: "status", matchValue: "Yapılacak", flowType: "analiz", priority: 2, statusMap: MAP }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }), null);
    // `analiz` is the narrowest flow, so `lr_an` decides — board included.
    expect(decision.reason).toBe("rule_conflict");
    expect(decision.ruleId).toBe("lr_an");
    expect(decision.statusMap).toEqual(MAP);
  });
});

/**
 * "Bota atanan her ticket" — `matchKind: "assigned"` (migration 0020).
 *
 * The rule that names no condition. Before it existed, the only way to say "if
 * a human hands this to the bot, work it" was to enumerate every issue type in
 * the project — which is a rule set that goes stale the day somebody adds a
 * type, and silently ignores the tickets carrying it.
 *
 * Two things make it safe to add. It compares NO field, so `matchValue` is a
 * placeholder nobody reads; and it is the LEAST SPECIFIC rule there is, so a
 * rule an operator wrote on purpose always beats it. The second is what stops
 * the catch-all from turning every deliberate rule in a project into a
 * `rule_conflict` the moment it is added.
 */
describe("flowDecisionFor — every ticket assigned to the bot", () => {
  const CATCH_ALL = rule({
    ruleId: "lr_any",
    matchKind: "assigned",
    // The literal the BFF pins. It must be irrelevant, and this is where that
    // is proved: no ticket below carries anything remotely like it.
    matchValue: "*",
    assigneeAccountId: "712020:bot",
    flowType: "analiz",
  });

  it("matches a ticket of any type and any status, so long as the bot has it", () => {
    for (const t of [
      ticket({ assignee: "712020:bot", issueType: "Görev" }),
      ticket({ assignee: "712020:bot", issueType: "Talep", status: "Onay Bekliyor" }),
      // The field the payload never delivered. A conditioned rule matches
      // nothing here (a null field matches nothing, deliberately); the
      // catch-all does not care, because it reads no field at all.
      ticket({ assignee: "712020:bot" }),
    ]) {
      const decision = flowDecisionFor([CATCH_ALL], t, null);
      expect(decision.reason).toBe("rule");
      expect(decision.ruleId).toBe("lr_any");
      expect(decision.flow).toBe("analiz");
    }
  });

  it("still respects the assignee — a ticket on a human is not Maestro's", () => {
    const decision = flowDecisionFor(
      [CATCH_ALL],
      ticket({ assignee: "712020:ayse", issueType: "Görev" }),
      null,
    );
    // Falls through to "no rule matched", not to the catch-all. The assignment
    // IS the condition; without it the rule says nothing about this ticket.
    expect(decision.reason).toBe("none");
  });

  it("loses to a rule that names a condition, with NO conflict reported", () => {
    const specific = rule({
      ruleId: "lr_bug",
      matchKind: "issuetype",
      matchValue: "Hata",
      assigneeAccountId: "712020:bot",
      flowType: "duzeltme",
      // Deliberately WORSE priority than the catch-all's default, to prove
      // specificity outranks priority rather than merely tie-breaking it.
      priority: 500,
    });
    const decision = flowDecisionFor(
      [CATCH_ALL, specific],
      ticket({ assignee: "712020:bot", issueType: "Hata" }),
      null,
    );

    expect(decision.flow).toBe("duzeltme");
    expect(decision.ruleId).toBe("lr_bug");
    // The headline: "Hata runs düzeltme, everything else assigned runs analiz"
    // is one coherent setup — the very setup the wizard produces — not a
    // misconfiguration to warn about on every single bug ticket.
    expect(decision.reason).toBe("rule");
    expect(decision.conflictingRuleIds).toBeUndefined();
  });

  it("catches the tickets the specific rule does not", () => {
    const specific = rule({
      ruleId: "lr_bug",
      matchValue: "Hata",
      assigneeAccountId: "712020:bot",
      flowType: "duzeltme",
    });
    const decision = flowDecisionFor(
      [CATCH_ALL, specific],
      ticket({ assignee: "712020:bot", issueType: "Görev" }),
      null,
    );
    expect(decision.ruleId).toBe("lr_any");
    expect(decision.flow).toBe("analiz");
  });

  it("carries its own status map, like any other deciding rule", () => {
    const mapped = { ...CATCH_ALL, statusMap: { onDone: "Tamam" } };
    const decision = flowDecisionFor([mapped], ticket({ assignee: "712020:bot" }), null);
    expect(decision.statusMap).toEqual({ onDone: "Tamam" });
  });

  it("still reports a real conflict between two catch-alls that disagree", () => {
    // The unique index stops this at the database for one (project, bot), but
    // two different bot accounts on one project can both match an unassigned-
    // agnostic rule — specificity must not swallow a genuine disagreement.
    const a = { ...CATCH_ALL, ruleId: "lr_a", assigneeAccountId: "", flowType: "analiz" as const };
    const b = { ...CATCH_ALL, ruleId: "lr_b", assigneeAccountId: "", flowType: "gelistirme" as const };
    const decision = flowDecisionFor([a, b], ticket({ assignee: "712020:bot" }), null);

    expect(decision.reason).toBe("rule_conflict");
    // Fail-closed, exactly as before: the narrowest flow of the matching set.
    expect(decision.flow).toBe("analiz");
    expect(decision.conflictingRuleIds).toEqual(["lr_a", "lr_b"]);
  });

  it("sorts the catch-all last in rulesFor, whatever its priority says", () => {
    const specific = rule({ ruleId: "lr_bug", matchValue: "Hata", assigneeAccountId: "712020:bot", priority: 900 });
    const matched = rulesFor(
      [CATCH_ALL, specific],
      ticket({ assignee: "712020:bot", issueType: "Hata" }),
    );
    expect(matched.map((r) => r.ruleId)).toEqual(["lr_bug", "lr_any"]);
    // `ruleFor` is the "first match wins" projection, so it follows.
    expect(ruleFor([CATCH_ALL, specific], ticket({ assignee: "712020:bot", issueType: "Hata" }))?.ruleId).toBe(
      "lr_bug",
    );
  });
});
