import type { Prisma } from "@prisma/client";
import type { DemoTicket } from "./ticket-data.js";

/**
 * The remaining projects: the web front end, the two mobile applications, the
 * branch desktop client and the greenfield ticket that has no repository yet.
 * Split from `ticket-data.ts` only to keep both files readable.
 */

const RULE_MATCH = (ruleId: string, appId: string): Prisma.InputJsonValue => ({
  via: "rule",
  ruleId,
  appId,
});

export const OTHER_PROJECT_TICKETS: readonly DemoTicket[] = [
  // --- UGURWEB --------------------------------------------------------------
  {
    key: "UGURWEB-88",
    appId: "ugurweb",
    mode: "human_lead",
    risk: "dusuk",
    dataClass: "dahili",
    step: "6b",
    status: "running",
    ageHours: 72,
    idleHours: 2,
    match: RULE_MATCH("rule-2", "ugurweb"),
  },
  {
    key: "UGURWEB-91",
    appId: "ugurweb",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "6a",
    status: "running",
    ageHours: 5,
    idleHours: 1,
    match: RULE_MATCH("rule-2", "ugurweb"),
  },
  {
    key: "UGURWEB-72",
    appId: "ugurweb",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    step: "9",
    status: "gate",
    ageHours: 48,
    idleHours: 4,
    match: RULE_MATCH("rule-2", "ugurweb"),
  },
  {
    // Public marketing pages, WCAG labels: nothing here is even internal.
    key: "UGURWEB-83",
    appId: "ugurweb",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "acik",
    step: "13",
    status: "done",
    ageHours: 240,
    idleHours: 216,
    match: RULE_MATCH("rule-2", "ugurweb"),
  },
  {
    key: "UGURWEB-95",
    appId: "ugurweb",
    mode: "human_only", // Maestro only watches and collects evidence
    risk: "dusuk",
    dataClass: "dahili",
    step: "6a",
    status: "running",
    ageHours: 24,
    idleHours: 3,
    match: RULE_MATCH("rule-2", "ugurweb"),
  },
  // --- UGURMOB --------------------------------------------------------------
  {
    key: "UGURMOB-201",
    appId: "ugurmobil-ios",
    mode: "full_auto",
    risk: "kritik",
    dataClass: "dahili",
    step: "10",
    status: "running",
    ageHours: 48,
    idleHours: 1,
    // Tier ② of M99: no component on the ticket, AI suggested the app and a
    // human confirmed it at the analysis gate.
    match: {
      via: "ai_suggestion",
      appId: "ugurmobil-ios",
      confidence: 0.94,
      validatedAtGate: true,
    },
  },
  {
    key: "UGURMOB-166",
    appId: "ugurmobil-ios",
    mode: "full_auto",
    risk: "kritik",
    dataClass: "dahili",
    step: "13",
    status: "done",
    ageHours: 336,
    idleHours: 312,
    match: RULE_MATCH("rule-3", "ugurmobil-ios"),
  },
  {
    key: "UGURMOB-188",
    appId: "ugurmobil-android",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "5",
    status: "gate",
    ageHours: 7,
    idleHours: 3,
    match: RULE_MATCH("rule-4", "ugurmobil-android"),
  },
  // --- UGURDESK -------------------------------------------------------------
  {
    key: "UGURDESK-45",
    appId: "ugurmasaustu",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "10b",
    status: "fail", // CI red: 3 vstest scenarios, the agent is fixing them
    ageHours: 48,
    idleHours: 3,
    match: RULE_MATCH("rule-6", "ugurmasaustu"),
  },
  {
    // Bulk EFT import: customer account data, so the org-wide guard rule 7
    // applies — `gizli` class and human_lead mode. Its analyst call is the
    // on-prem `gizli` call in the gateway log, which is what
    // `dataclass.policy` prescribes for this class (M18/M63).
    key: "UGURDESK-52",
    appId: "ugurmasaustu",
    mode: "human_lead",
    risk: "kritik",
    dataClass: "gizli",
    step: "6a",
    status: "running",
    ageHours: 6,
    idleHours: 1,
    match: RULE_MATCH("rule-6", "ugurmasaustu"),
  },
  {
    key: "UGURDESK-39",
    appId: "ugurmasaustu",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "13",
    status: "done",
    ageHours: 288,
    idleHours: 264,
    match: RULE_MATCH("rule-6", "ugurmasaustu"),
  },
  // --- greenfield (M42) -----------------------------------------------------
  {
    key: "UGURPAY-600",
    appId: null, // no repo yet; the record is created during onboarding
    mode: "full_auto",
    risk: "kritik",
    dataClass: "dahili",
    step: "5",
    status: "gate",
    ageHours: 24,
    idleHours: 5,
    match: { via: "onboarding" },
  },
];
