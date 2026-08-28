import type { Prisma } from "@prisma/client";
import type { DataClass, RiskTier, StepId, WorkMode, WorkflowRunStatus } from "@maestro/contracts";

/**
 * The mock's 22 tickets, as data. `tickets.ts` turns them into rows and holds
 * the invariants; keeping the table separate means a change to the demo's
 * *content* never touches the code that validates it.
 *
 * Mock step indices are positions in `STEP_IDS` (the mock's STEPS table is the
 * same list in the same order), so the demo carries contract step ids directly.
 */
export interface DemoTicket {
  key: string;
  appId: string | null;
  mode: WorkMode;
  risk: RiskTier | null;
  dataClass: DataClass;
  step: StepId;
  status: WorkflowRunStatus;
  /** Age of the run in hours (startedAt = DEMO_NOW - ageHours). */
  ageHours: number;
  /** Hours since the last state change (updatedAt = DEMO_NOW - idleHours). */
  idleHours: number;
  match: Prisma.InputJsonValue;
}

const RULE_MATCH = (ruleId: string, appId: string): Prisma.InputJsonValue => ({
  via: "rule",
  ruleId,
  appId,
});

const FANOUT_MATCH = (appId: string): Prisma.InputJsonValue => ({
  via: "analysis_fanout",
  parentTicketKey: "UGURPAY-500",
  appId,
});

/** The UGURPAY project: the fan-out family plus its standalone tickets. */
export const UGURPAY_TICKETS: readonly DemoTicket[] = [
  // --- UGURPAY-500 fan-out family (M100) -----------------------------------
  {
    // The coordination parent. It *does* carry an application: M100 runs the
    // discovery session in the primary repo and derives the impact matrix from
    // the other repo cards, so "no app" would contradict its own MatchResult.
    key: "UGURPAY-500",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    step: "3",
    status: "running",
    // Older than every child it fanned out — a parent cannot start after its
    // children (UGURPAY-504 is the oldest child at 388h).
    ageHours: 390,
    idleHours: 2,
    match: RULE_MATCH("rule-1", "ugurpay"),
  },
  {
    key: "UGURPAY-501",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    step: "12",
    status: "gate",
    // Covers the mock's hand-transcribed journal: 31 Jul 09:02 → 6 Aug 14:02
    // Istanbul. The mock's own "6 gün" label contradicted that journal.
    ageHours: 198,
    idleHours: 48,
    match: FANOUT_MATCH("ugurpay"),
  },
  {
    key: "UGURPAY-502",
    appId: "ugurmobil-ios",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    step: "7",
    status: "running",
    ageHours: 96,
    idleHours: 1,
    match: FANOUT_MATCH("ugurmobil-ios"),
  },
  {
    key: "UGURPAY-503",
    appId: "ugurmobil-android",
    mode: "ai_assist",
    risk: "orta",
    dataClass: "dahili",
    step: "6a",
    status: "running",
    ageHours: 96,
    idleHours: 1,
    match: FANOUT_MATCH("ugurmobil-android"),
  },
  {
    // The 16-day gate the escalation screen is about. The mock had age 16d and
    // "waiting 16d 2h", i.e. the gate opened before the run started.
    key: "UGURPAY-504",
    appId: "ugurmasaustu",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    step: "4",
    status: "gate",
    ageHours: 388,
    idleHours: 386,
    match: FANOUT_MATCH("ugurmasaustu"),
  },
  // --- standalone UGURPAY tickets ------------------------------------------
  {
    key: "UGURPAY-123",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "11",
    status: "gate",
    ageHours: 24,
    // The QA result gate opened 8 minutes ago — the mock's own audit rows
    // (14:12) say so, while its ticket table claimed "1h 10m".
    idleHours: 0.13,
    match: RULE_MATCH("rule-1", "ugurpay"),
  },
  {
    key: "UGURPAY-712",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    step: "2b",
    status: "gate",
    ageHours: 24,
    idleHours: 20,
    match: RULE_MATCH("rule-1", "ugurpay"),
  },
  {
    key: "UGURPAY-689",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "3",
    status: "queued", // subscription quota window (M55)
    ageHours: 3,
    idleHours: 1,
    match: RULE_MATCH("rule-1", "ugurpay"),
  },
  {
    key: "UGURPAY-478",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "13",
    status: "done",
    ageHours: 168,
    idleHours: 144,
    match: RULE_MATCH("rule-1", "ugurpay"),
  },
  {
    key: "UGURPAY-455",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "13",
    status: "done",
    ageHours: 288,
    idleHours: 264,
    match: RULE_MATCH("rule-1", "ugurpay"),
  },
];
