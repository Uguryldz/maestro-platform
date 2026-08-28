import type { Prisma } from "@prisma/client";
import { findParamDefinition } from "../params-defaults.js";
import { ist } from "./clock.js";

/**
 * Parameter version history (M71).
 *
 * `seedParams` writes version 1 of every definition — the shipped default. The
 * rows below are what an operator did afterwards, and they are the reason the
 * audit trail can say "gates.risk_tiers → v4": before, the trail claimed a
 * version the database had never stored.
 *
 * Every row here becomes a `PARAM_CHANGED` audit record (see decisions.ts), so
 * the parameter screen's "Sürüm geçmişi" panel and the audit screen are two
 * views of the same rows rather than two independent inventions.
 */

const CHANGED_BY = "ugur.yildiz@ugurbank.local";
/** Guarded parameters need a second pair of eyes; Mert holds tech-leads. */
const APPROVED_BY = "mert.demir@ugurbank.local";

export class UnknownDemoParamError extends Error {
  constructor(key: string) {
    super(`demo parameter history references undefined parameter ${key}`);
    this.name = "UnknownDemoParamError";
  }
}

interface DemoParamVersion {
  key: string;
  scopeRef?: string;
  version: number;
  value: Prisma.InputJsonValue;
  at: Date;
  changedBy?: string;
}

const HISTORY: DemoParamVersion[] = [
  // gates.risk_tiers — the mock's version panel, in full (v1 is the installer
  // default). v2/v3 are the "everything is critical" experiment; v4 reverts to
  // the tiered set, which is why the runs' gate sets match GATES_BY_RISK again.
  {
    key: "gates.risk_tiers",
    version: 2,
    at: ist("2026-08-02T10:15:00"),
    value: {
      dusuk: ["5", "12"],
      orta: ["4", "5", "9", "11", "12"],
      kritik: ["4", "5", "9", "11", "12"],
    },
  },
  {
    key: "gates.risk_tiers",
    version: 3,
    at: ist("2026-08-04T11:40:00"),
    value: {
      dusuk: ["5", "11", "12"],
      orta: ["4", "5", "9", "11", "12"],
      kritik: ["4", "5", "9", "11", "12"],
    },
  },
  {
    key: "gates.risk_tiers",
    version: 4,
    at: ist("2026-08-07T09:30:00"),
    value: {
      dusuk: ["5", "12"],
      orta: ["4", "5", "11", "12"],
      kritik: ["4", "5", "9", "11", "12"],
    },
  },
  // escalation.ladder — the mock's "24s jira → 72s teams+smtp → 7g delegasyon
  // → 14g yönetici raporu" ladder, reached in two steps. The 7-day step is a
  // real delegation (`action`, plus the key that says so); it used to be a
  // fourth escalation while the comment claimed otherwise.
  {
    key: "escalation.ladder",
    version: 2,
    at: ist("2026-08-03T16:05:00"),
    value: {
      steps: [
        { id: "reminder-24h", afterHours: 24, channel: "jira", event: "gate_reminder" },
        { id: "escalation-72h", afterHours: 72, channel: "teams", event: "escalation" },
        { id: "escalation-72h-mail", afterHours: 72, channel: "smtp", event: "escalation" },
        {
          id: "delegate-7d",
          afterHours: 168,
          channel: "teams",
          event: "escalation",
          action: "delegate",
          messageKey: "notify.delegated",
        },
      ],
      businessHoursOnly: false,
    },
  },
  {
    key: "escalation.ladder",
    version: 3,
    at: ist("2026-08-07T09:45:00"),
    value: {
      steps: [
        { id: "reminder-24h", afterHours: 24, channel: "jira", event: "gate_reminder" },
        { id: "escalation-72h", afterHours: 72, channel: "teams", event: "escalation" },
        { id: "escalation-72h-mail", afterHours: 72, channel: "smtp", event: "escalation" },
        {
          id: "delegate-7d",
          afterHours: 168,
          channel: "teams",
          event: "escalation",
          action: "delegate",
          messageKey: "notify.delegated",
        },
        // 14 days: the management report. Still a notification, not a hand-off.
        { id: "management-report-14d", afterHours: 336, channel: "smtp", event: "escalation" },
      ],
      businessHoursOnly: false,
    },
  },
  // coverage.ratchet — new-line floor raised after the UGURPAY-501 review.
  {
    key: "coverage.ratchet",
    version: 2,
    at: ist("2026-08-07T10:10:00"),
    value: { allowDecrease: false, minNewLinePct: 85 },
  },
  // trigger.mode — UGURPAY was opted in by command first, then switched to
  // automatic once the dry run looked right (M102). Project-scoped, so the
  // version counter starts again at 1 for this scopeRef.
  {
    key: "trigger.mode",
    scopeRef: "UGURPAY",
    version: 1,
    at: ist("2026-08-05T14:00:00"),
    value: "command",
  },
  {
    key: "trigger.mode",
    scopeRef: "UGURPAY",
    version: 2,
    at: ist("2026-08-07T08:20:00"),
    value: "auto",
  },
];

/**
 * Rows for `ParamVersion`. `guarded` and `approvedBy` are derived from the
 * definition, never typed by hand: that is the same coupling
 * `writeParamVersion()` enforces at runtime, and it is what the database's
 * CHECK constraint verifies.
 */
export const DEMO_PARAM_VERSIONS: Prisma.ParamVersionCreateManyInput[] = HISTORY.map((entry) => {
  const definition = findParamDefinition(entry.key);
  if (definition === undefined) throw new UnknownDemoParamError(entry.key);
  const changedBy = entry.changedBy ?? CHANGED_BY;
  return {
    key: entry.key,
    scopeRef: entry.scopeRef ?? "",
    version: entry.version,
    valueJson: entry.value,
    guarded: definition.guarded,
    changedBy,
    approvedBy: definition.guarded ? APPROVED_BY : null,
    at: entry.at,
  };
});
