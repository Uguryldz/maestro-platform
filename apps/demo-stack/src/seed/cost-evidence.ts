import { createHash } from "node:crypto";
import type { EvidencePackage, JournalEntry, LlmCallLog, LlmRole } from "@maestro/contracts";
import type { OpenGate } from "@maestro/bff";
import { DEFAULT_GATE_OWNER_GROUPS } from "@maestro/bff";
import { demoRunId } from "../fakes/run-gateway.js";
import type { DemoRun } from "./runs.js";
import { stampBefore } from "./runs.js";
import { actorOf } from "./users.js";

/**
 * The gateway call log (M16), the open-gate board (M71) and the evidence
 * packages (M56) — all three derived from the runs and their journals rather
 * than written out separately, so a row can never describe a run that is not
 * there.
 */

/** Which journal kind spent tokens on behalf of which gateway role. */
const ROLE_OF_KIND: Readonly<Partial<Record<JournalEntry["kind"], LlmRole>>> = {
  intake: "intake",
  clarification: "intake",
  discovery: "analyst",
  analysis: "analyst",
  engineering: "engineer",
  review: "dev_reviewer",
  test_design: "test_designer",
  test_review: "test_reviewer",
  test_run: "test_engineer",
};

/**
 * One call-log row per AI journal entry, carrying the SAME cost and token
 * counts. That is the point: `/studio/runs/:ticket/cost` sums the log, and if
 * the log were invented independently the totals on the cost screen would
 * disagree with the totals on the journal — two numbers for one fact is how a
 * demo teaches a reader to distrust the product.
 *
 * `usd` stays populated because the seeded pool mixes API and subscription
 * drivers; the subscription rows below carry `usd: null`, which is what M55
 * requires and what the cost screen has to be able to render.
 */
export function callsFor(run: DemoRun, journal: readonly JournalEntry[]): readonly LlmCallLog[] {
  const runId = demoRunId(run.ticketKey);
  const dataClass = run.ticketKey.startsWith("UGURPAY") || run.ticketKey.startsWith("UGURDESK")
    ? "gizli"
    : "dahili";

  const rows: LlmCallLog[] = [];
  for (const [index, entry] of journal.entries()) {
    const role = ROLE_OF_KIND[entry.kind];
    if (role === undefined || entry.cost === undefined) continue;

    // Every third call runs on the subscription pool, where cost IS quota and
    // there is no dollar figure to report (M55).
    const onSubscription = index % 3 === 2;
    rows.push({
      at: entry.at,
      runId,
      role,
      variantId: `${role}-v2`,
      driver: onSubscription ? "claude-sub" : "anthropic-direct",
      model: entry.cost.model ?? "claude-sonnet-4-6",
      tokensIn: entry.cost.tokensIn ?? 0,
      tokensOut: entry.cost.tokensOut ?? 0,
      cachePct: onSubscription ? null : 34,
      usd: onSubscription ? null : entry.cost.usd,
      dataClass,
    });
  }
  return rows;
}

/**
 * The gate board (M71). Built ONLY from runs whose status is actually `gate` and
 * whose step is one the gate directory owns — a board listing a gate the
 * workflow would refuse to close is worse than an empty one, because somebody
 * would try.
 *
 * The clarification wait (2b) is deliberately excluded: it reports `gate` but
 * is not an approval, and `decideGate` rejects a decision on it.
 */
export function openGateOf(run: DemoRun, now: Date): OpenGate | null {
  if (run.status !== "gate") return null;
  const ownerGroup = DEFAULT_GATE_OWNER_GROUPS[run.step];
  if (ownerGroup === undefined) return null;

  return {
    ticketKey: run.ticketKey,
    runId: demoRunId(run.ticketKey),
    step: run.step,
    ownerGroup,
    openedAt: stampBefore(now, run.updatedHoursAgo),
    // The one gate that has been waiting long enough for the reminder ladder to
    // have escalated it (M45): UGURPAY-504, sixteen days at the PO gate.
    delegatedTo: run.updatedHoursAgo > 300 ? actorOf("mert.demir") : null,
  };
}

/**
 * The evidence package for a closed run (M56).
 *
 * Only `done` runs get one, because that is the rule: the package is built at
 * closure. Its `approvals` are the gate decisions the run's risk tier demanded,
 * which is why a `dusuk` run carries two and an `orta` run four — a manifest
 * claiming approvals the flow never asked for would misrepresent the control.
 *
 * The file digests are real SHA-256 hashes of the descriptive text below, not
 * random hex: a `Sha256Hex` that hashes nothing is a number that looks like
 * evidence and is not.
 */
export function evidenceFor(
  run: DemoRun,
  approvals: EvidencePackage["approvals"],
  now: Date,
): EvidencePackage | null {
  if (run.status !== "done") return null;
  const runId = demoRunId(run.ticketKey);
  const files = [
    { name: `${run.ticketKey}-analiz.docx`, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    { name: `${run.ticketKey}-diff.patch`, contentType: "text/x-patch" },
    { name: `${run.ticketKey}-test-raporu.xml`, contentType: "application/xml" },
    { name: `${run.ticketKey}-onay-zinciri.json`, contentType: "application/json" },
    { name: `${run.ticketKey}-tuketim.json`, contentType: "application/json" },
  ];

  return {
    runId,
    ticketKey: run.ticketKey,
    createdAt: stampBefore(now, run.updatedHoursAgo),
    templateVersion: "analiz-sablonu-v2",
    files: files.map((file) => {
      const body = `${runId}:${file.name}`;
      return {
        name: file.name,
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: 4_096 + (body.length * 137) % 262_144,
        contentType: file.contentType,
      };
    }),
    approvals,
    retentionYears: 10,
    objectLock: false,
  };
}
