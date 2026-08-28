import { describe, expect, it } from "vitest";
import { selectAutoStartTicket } from "../src/boot.js";
import { ListeningRulesStore, type ListeningRule } from "../src/listening.js";
import type { DiscoveredTicket } from "../src/poll.js";

/**
 * The AUTO-START selection guard (the engine's heartbeat), pure and offline.
 *
 * Only a ticket a LISTENING RULE can classify from its discovery row (project +
 * status) may auto-start; an unclassifiable ticket is reported as `unmatched`
 * (the caller logs "kural eşleşmedi, elle başlatılmalı") and a ticket already
 * attempted (failed/returned/started before) is never picked again.
 */

const BOT = "712020:bot-account";

function rule(overrides: Partial<ListeningRule> = {}): ListeningRule {
  return {
    projectKey: "OPS",
    assigneeAccountId: "",
    matchKind: "status",
    matchValue: "Yapılacaklar",
    flowType: "analiz",
    priority: 1,
    enabled: true,
    ...overrides,
  };
}

function row(key: string, status: string | null, issueType: string | null = null): DiscoveredTicket {
  return { key, summary: `özet ${key}`, status, issueType, createdAt: null };
}

describe("selectAutoStartTicket — oto-başlatma guard'ı", () => {
  it("picks the FIRST rule-classifiable, unattempted ticket (with its status + flow)", () => {
    const listening = new ListeningRulesStore([rule()]);
    const { pick, unmatched } = selectAutoStartTicket(
      [row("OPS-1", "Yapılacaklar"), row("OPS-2", "Yapılacaklar")],
      listening,
      BOT,
      new Set(),
    );
    expect(pick).toEqual({ key: "OPS-1", status: "Yapılacaklar", flow: "analiz" });
    expect(unmatched).toEqual([]);
  });

  it("NEVER picks a ticket no rule classifies — it is reported as unmatched (manual start)", () => {
    const listening = new ListeningRulesStore([rule()]);
    const { pick, unmatched } = selectAutoStartTicket(
      [row("OPS-3", "Devam Ediyor"), row("OPS-4", null)],
      listening,
      BOT,
      new Set(),
    );
    expect(pick).toBeNull();
    expect(unmatched).toEqual(["OPS-3", "OPS-4"]);
  });

  it("with NO rules at all nothing auto-starts (the pre-rule pilot behaviour)", () => {
    const listening = new ListeningRulesStore([]);
    const { pick, unmatched } = selectAutoStartTicket(
      [row("OPS-1", "Yapılacaklar")],
      listening,
      BOT,
      new Set(),
    );
    expect(pick).toBeNull();
    expect(unmatched).toEqual(["OPS-1"]);
  });

  it("skips an already-attempted ticket (a failed/returned run is not retried)", () => {
    const listening = new ListeningRulesStore([rule()]);
    const attempted = new Set(["OPS-1"]);
    const { pick, unmatched } = selectAutoStartTicket(
      [row("OPS-1", "Yapılacaklar"), row("OPS-2", "Yapılacaklar")],
      listening,
      BOT,
      attempted,
    );
    expect(pick).toEqual({ key: "OPS-2", status: "Yapılacaklar", flow: "analiz" });
    // The attempted ticket is neither picked nor re-reported as unmatched.
    expect(unmatched).toEqual([]);
  });

  it("only classifies within the rule's own project", () => {
    const listening = new ListeningRulesStore([rule({ projectKey: "PAY" })]);
    const { pick, unmatched } = selectAutoStartTicket(
      [row("OPS-1", "Yapılacaklar"), row("PAY-9", "Yapılacaklar")],
      listening,
      BOT,
      new Set(),
    );
    expect(pick).toEqual({ key: "PAY-9", status: "Yapılacaklar", flow: "analiz" });
    expect(unmatched).toEqual(["OPS-1"]);
  });

  it("a rule bound to ANOTHER bot's assignee does not classify for this bot", () => {
    const listening = new ListeningRulesStore([rule({ assigneeAccountId: "712020:other" })]);
    const { pick } = selectAutoStartTicket([row("OPS-1", "Yapılacaklar")], listening, BOT, new Set());
    expect(pick).toBeNull();
  });

  it("classifies an ISSUETYPE rule from the discovery row's issueType (the live OPS-15 bug)", () => {
    // The row carries the issue-type NAME from discovery; before the fix the
    // guard always passed issueType:null, so issuetype rules never auto-started.
    const listening = new ListeningRulesStore([
      rule({ matchKind: "issuetype", matchValue: "Task", flowType: "analiz" }),
    ]);
    const { pick } = selectAutoStartTicket(
      [row("OPS-15", "İNCELEMEDE", "Task")],
      listening,
      BOT,
      new Set(),
    );
    expect(pick).toEqual({ key: "OPS-15", status: "İNCELEMEDE", flow: "analiz" });
  });
});
